import { resolveWorkbenchConfig, type EffectivePreview } from '@talyn/shared';
import type {
  CoderPreviewCheckInput, CoderPreviewInput, CoderPreviewState, CoderProblem, CoderStatus, CoderStep, CoderWorkspace,
} from '../../workbenchBridgeTypes';
import { CODER_SEARCH_TEXT, CoderCli, classifyCoderFailure, coderOrigin, remotePath, shellQuote, workspaceName } from './coder';

type Cli = Pick<CoderCli, 'status' | 'workspaces' | 'start' | 'waitUntilRunning' | 'exec' | 'appUrls' | 'portForward' | 'stopForwards'>;
interface Preview { input: CoderPreviewInput; state: CoderPreviewState; checkout: string; tree: string }

// A workspace build waits for the template's startup scripts. PostHog's waits up to 16 minutes.
const WORKSPACE_START_MS = 600_000;
// `git fetch` of a large repository such as posthog/posthog can take minutes on a stale checkout.
const WORKTREE_MS = 600_000;

/** A failed check. The message is what a toast shows; the problem is what the panel shows. */
export class CoderProblemError extends Error {
  constructor(readonly problem: CoderProblem) {
    const first = problem.commands?.[0]?.command;
    super(first ? `${problem.message}\nRun: ${first}` : problem.message);
  }
}

const safeWord = (value: string) => /^[A-Za-z0-9._/:-]+$/.test(value) ? value : shellQuote(value);

/** PostHog's repository sets coder_url in hogli.yaml, and hogli has its own devbox commands. */
export function usesHogli(config: Pick<EffectivePreview, 'reasons'>): boolean {
  return config.reasons.some((reason) => reason.includes('hogli.yaml'));
}

/** The problem for a CLI status, or null when the CLI is ready for this deployment. */
export function statusProblem(status: CoderStatus, url: string, hogli: boolean, platform: NodeJS.Platform = process.platform): CoderProblem | null {
  const login = { command: `coder login ${safeWord(url)}` };
  const setup = { label: 'Or use hogli, from the PostHog repository:', command: 'hogli devbox:setup' };
  if (!status.installed) {
    return {
      step: 'cli', code: 'not_installed',
      message: 'Talyn cannot find the Coder CLI. Install it, then select Check again.',
      commands: [
        platform === 'win32' ? { command: 'winget install Coder.Coder' } : { command: 'brew install coder/coder/coder' },
        ...(hogli ? [setup] : []),
      ],
      note: `You can also use the official install script: curl -L https://coder.com/install.sh | sh\nTalyn looked in ${CODER_SEARCH_TEXT}.`,
      detail: status.detail,
    };
  }
  if (status.loggedIn) return null;
  switch (status.problem) {
    case 'unreachable':
      return {
        step: 'login', code: 'unreachable',
        message: `Talyn cannot reach ${url}. The deployment can be on a private network, such as a Tailscale tailnet. Connect to that network, then select Check again.`,
        commands: hogli ? [{ label: 'To find the cause, run:', command: 'hogli devbox:doctor' }] : undefined,
        detail: status.detail,
      };
    case 'wrong_deployment':
      return {
        step: 'login', code: 'wrong_deployment',
        message: `The Coder CLI is signed in to ${status.url}, but this repository uses ${url}. Sign in to ${url}, then select Check again.`,
        commands: [login],
        detail: status.detail,
      };
    case 'error':
      return {
        step: 'login', code: 'error',
        message: 'The Coder CLI did not answer as expected. Read its output below, then select Check again.',
        commands: [{ label: 'To see the error, run:', command: 'coder whoami' }],
        detail: status.detail,
      };
    default:
      return {
        step: 'login', code: 'not_logged_in',
        message: `The Coder CLI is not signed in to ${url}, or the sign-in expired. Sign in, then select Check again.`,
        commands: [login, ...(hogli ? [setup] : [])],
        detail: status.detail,
      };
  }
}

function workspaceList(workspaces: CoderWorkspace[]): string {
  return workspaces.map((item) => `${item.name} (${item.template || 'no template'}, ${item.status})`).join(', ') || 'none';
}

export function pickWorkspace(
  workspaces: CoderWorkspace[],
  choice: { workspace?: string; template?: string },
  hogli = false,
): CoderWorkspace {
  const choose = (message: string) => new CoderProblemError({ step: 'workspace', code: 'choose_workspace', message });
  if (choice.workspace) {
    workspaceName(choice.workspace);
    const chosen = workspaces.filter((item) => item.name === choice.workspace);
    if (chosen.length === 1) return chosen[0];
    throw choose(`The workspace ${choice.workspace} in Settings is not one of your Coder workspaces. Select a workspace in Settings → Repositories. Available workspaces: ${workspaceList(workspaces)}.`);
  }
  const matching = workspaces.filter((item) => item.template === choice.template && ['running', 'stopped'].includes(item.status));
  if (choice.template && matching.length === 1) return matching[0];
  if (workspaces.length === 1) return workspaces[0];
  const forTemplate = choice.template ? workspaces.filter((item) => item.template === choice.template) : workspaces;
  if (!forTemplate.length) {
    const create = choice.template ? `coder create --template ${safeWord(choice.template)}` : 'coder create';
    throw new CoderProblemError({
      step: 'workspace', code: 'no_workspace',
      message: choice.template
        ? `You have no Coder workspace from the template ${choice.template}. Create one, then select Check again.`
        : 'You have no Coder workspace. Create one, then select Check again.',
      commands: [...(hogli ? [{ command: 'hogli devbox:start' }] : []), { label: hogli ? 'Or with the Coder CLI:' : undefined, command: create }],
      note: `Talyn does not create workspaces, because a template asks for choices that only you can make.${workspaces.length ? ` Your other workspaces: ${workspaceList(workspaces)}.` : ''}`,
    });
  }
  throw choose(`You have more than one Coder workspace. Select a workspace in Settings → Repositories. Available workspaces: ${workspaceList(workspaces)}.`);
}

function sessionId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid preview session ID.');
  return value;
}
function baseSha(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{7,64}$/i.test(value)) throw new Error('The preview base must be a commit SHA.');
  return value;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class CoderPreviews {
  private previews = new Map<string, Preview>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private cli: Cli, private openExternal: (url: string) => Promise<void>) {}

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    sessionId(id);
    const next = this.queue.catch(() => undefined).then(async () => {
      const preview = this.previews.get(id);
      if (preview) {
        preview.state.error = undefined;
        preview.state.problem = undefined;
      }
      try { return await action(); } catch (error) {
        const current = this.previews.get(id);
        if (current) {
          current.state.error = message(error);
          current.state.problem = error instanceof CoderProblemError
            ? error.problem
            : { step: current.state.step ?? 'cli', code: 'error', message: message(error) };
        }
        throw error;
      } finally {
        const current = this.previews.get(id);
        if (current) {
          current.state.step = undefined;
          current.state.stepDetail = undefined;
        }
      }
    });
    this.queue = next;
    return next;
  }

  state(id: string): CoderPreviewState | null {
    const state = this.previews.get(sessionId(id))?.state;
    return state ? { ...state } : null;
  }

  private get(id: string): Preview {
    const preview = this.previews.get(sessionId(id));
    if (!preview?.state.worktreeReady) throw new Error('Select Preview in Coder to prepare the worktree.');
    return preview;
  }

  private step(preview: Preview, step: CoderStep, detail?: string): void {
    preview.state.step = step;
    preview.state.stepDetail = detail;
  }

  /** Finds or makes the record for a session. A record with no worktree yet follows the config. */
  private record(input: CoderPreviewCheckInput & { base?: string }): Preview {
    if (input.config.target !== 'coder' || !input.config.coder?.url) throw new Error('Set the Coder URL in Settings → Repositories.');
    const url = coderOrigin(input.config.coder.url);
    const coder = input.config.coder;
    const repo = input.repoName.split('/').pop()!;
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) throw new Error('Invalid repository name.');
    const checkout = remotePath(coder.checkout || `~/${repo}`);
    if (coder.workspace) workspaceName(coder.workspace);
    const existing = this.previews.get(input.sessionId);
    if (existing?.state.worktreeReady) {
      if (existing.state.url !== url || existing.checkout !== checkout || existing.input.config.coder?.workspace !== coder.workspace) {
        throw new Error('Remove this preview before you change its URL, workspace, or checkout.');
      }
      return existing;
    }
    const preview: Preview = {
      input: { ...input, base: input.base ?? existing?.input.base ?? '' },
      checkout,
      tree: remotePath(`~/.talyn/previews/${input.sessionId}`),
      state: {
        sessionId: input.sessionId, url, cliReady: false, signedIn: false, workspaceRunning: false,
        worktreeReady: false, active: false, running: false,
      },
    };
    this.previews.set(input.sessionId, preview);
    return preview;
  }

  /** The CLI is installed and signed in to the preview's deployment. */
  private async signedIn(preview: Preview): Promise<CoderStatus> {
    this.step(preview, 'cli', 'Looking for the coder CLI');
    const status = await this.cli.status(preview.state.url);
    preview.state.cliReady = status.installed;
    preview.state.signedIn = status.loggedIn;
    if (status.installed) this.step(preview, 'login', `Checking the sign-in to ${preview.state.url}`);
    const problem = statusProblem(status, preview.state.url, usesHogli(preview.input.config));
    if (problem) throw new CoderProblemError(problem);
    return status;
  }

  /** Runs the checks in order and stops at the first that fails. */
  private async checks(preview: Preview, startStopped: boolean): Promise<void> {
    const status = await this.signedIn(preview);
    this.step(preview, 'workspace', 'Reading your Coder workspaces');
    const coder = preview.input.config.coder ?? {};
    const all = await this.cli.workspaces().catch((error) => {
      const detail = message(error);
      throw new CoderProblemError(classifyCoderFailure(detail) === 'unreachable'
        ? { step: 'workspace', code: 'unreachable', message: `Talyn cannot reach ${preview.state.url} to list your workspaces. Connect to its network, then select Check again.`, detail }
        : { step: 'workspace', code: 'error', message: 'Talyn could not list your Coder workspaces.', commands: [{ command: 'coder list' }], detail });
    });
    const available = all.filter((item) => !item.owner || !status.user || item.owner === status.user);
    const workspace = pickWorkspace(available, { ...coder, workspace: preview.state.workspace || coder.workspace }, usesHogli(preview.input.config));
    preview.state.workspace = workspace.name;
    preview.state.workspaceRunning = workspace.status === 'running';
    const onStatus = (value: string) => this.step(preview, 'workspace', `Starting ${workspace.name}. Status: ${value}`);
    const start = { command: `coder start ${workspace.name}` };
    switch (workspace.status) {
      case 'running':
        break;
      case 'starting':
      case 'pending':
        onStatus(workspace.status);
        await this.cli.waitUntilRunning(workspace.name, Date.now() + WORKSPACE_START_MS, onStatus);
        break;
      case 'stopped':
      case 'failed':
      case 'canceled':
        if (!startStopped) {
          throw new CoderProblemError({
            step: 'workspace', code: workspace.status === 'stopped' ? 'workspace_stopped' : 'workspace_failed',
            message: workspace.status === 'stopped'
              ? `The workspace ${workspace.name} is stopped. Start it, then select Preview in Coder.`
              : `The last build of ${workspace.name} has the status ${workspace.status}. Start it again, then select Preview in Coder.`,
            commands: [start],
            action: 'start_workspace',
          });
        }
        await this.cli.start(workspace.name, onStatus);
        break;
      default:
        throw new CoderProblemError({
          step: 'workspace', code: 'workspace_busy',
          message: `The workspace ${workspace.name} has the status ${workspace.status}. Wait until it stops, then select Check again.`,
          commands: [{ label: 'To see its status, run:', command: `coder list` }],
        });
    }
    preview.state.workspaceRunning = true;
  }

  private async exec(preview: Preview, script: string, input?: string, timeout?: number): Promise<string> {
    const workspace = preview.state.workspace!;
    const result = await this.cli.exec(workspace, script, { input, ...(timeout ? { timeout } : {}) }).catch((error) => {
      throw new Error(`Coder command failed. Check the workspace: coder ssh ${workspace}\n${message(error)}`);
    });
    if (result.code) throw new Error(`Coder command failed (${result.code}): ${result.stderr || result.stdout}\nCheck the workspace: coder ssh ${workspace}`);
    return result.stdout;
  }

  /** The read-only checks: CLI, sign-in and workspace. It never starts a workspace. */
  check(input: CoderPreviewCheckInput): Promise<CoderPreviewState> {
    return this.serial(input.sessionId, async () => {
      const preview = this.record(input);
      try { await this.checks(preview, false); } catch (error) {
        // The panel reads the problem from the state, so a failed check is an answer, not an error.
        if (!(error instanceof CoderProblemError)) throw error;
        preview.state.problem = error.problem;
        preview.state.error = error.message;
      }
      return { ...preview.state };
    });
  }

  startWorkspace(id: string): Promise<CoderPreviewState> {
    return this.serial(id, async () => {
      const preview = this.previews.get(sessionId(id));
      if (!preview?.state.workspace) throw new Error('Select Check again to find your workspace first.');
      await this.signedIn(preview);
      const name = preview.state.workspace;
      const onStatus = (value: string) => this.step(preview, 'workspace', `Starting ${name}. Status: ${value}`);
      await this.cli.start(name, onStatus);
      preview.state.workspaceRunning = true;
      return { ...preview.state };
    });
  }

  prepare(input: CoderPreviewInput): Promise<CoderPreviewState> {
    return this.serial(input.sessionId, async () => {
      baseSha(input.base);
      const preview = this.record(input);
      await this.checks(preview, true);
      await this.stopOthers(preview);
      if (!preview.state.worktreeReady) {
        this.step(preview, 'worktree', `Fetching origin and making the worktree ~/.talyn/previews/${input.sessionId}`);
        await this.exec(preview, `set -e; mkdir -p "$HOME/.talyn/previews"; if [ ! -e ${preview.tree} ]; then git -C ${preview.checkout} fetch --quiet origin && git -C ${preview.checkout} worktree add --force --detach ${preview.tree} ${input.base}; fi; test ! -L ${preview.tree}; test -f ${preview.tree}/.git`, undefined, WORKTREE_MS);
        preview.state.worktreeReady = true;
      }
      preview.input = input;
      preview.state.active = true;
      return { ...preview.state };
    });
  }

  sync(input: { sessionId: string; base: string; patch: string; turn?: number }): Promise<CoderPreviewState> {
    return this.serial(input.sessionId, async () => {
      const preview = this.get(input.sessionId);
      if (!preview.state.active) throw new Error('This preview stopped. Select Preview in Coder to start it.');
      baseSha(input.base);
      if (typeof input.patch !== 'string') throw new Error('Invalid preview patch.');
      await this.signedIn(preview);
      this.step(preview, 'sync', "Applying the session's changes to the worktree");
      preview.state.syncedAt = undefined;
      preview.state.turn = undefined;
      await this.exec(preview, `set -e; cd ${preview.tree}; git reset --hard ${input.base} && git clean -fdq${input.patch ? ' && git apply --binary --whitespace=nowarn' : ''}`, input.patch || undefined);
      preview.input.base = input.base;
      preview.state.syncedAt = new Date().toISOString();
      preview.state.turn = input.turn;
      return { ...preview.state };
    });
  }

  private async stopOthers(preview: Preview): Promise<void> {
    for (const other of this.previews.values()) {
      if (other !== preview && other.state.url === preview.state.url && other.state.workspace === preview.state.workspace && (other.state.active || other.state.running)) {
        await this.stopPreview(other);
      }
    }
  }

  private async stopPreview(preview: Preview): Promise<void> {
    if (!preview.state.workspace) return;
    if (preview.state.active || preview.state.running) this.cli.stopForwards(preview.state.workspace);
    if (preview.state.worktreeReady) {
      await this.signedIn(preview);
      this.step(preview, 'run', 'Stopping the run command');
      const name = shellQuote(`=talyn-preview-${preview.input.sessionId}`);
      const pid = remotePath(`~/.talyn/previews/${preview.input.sessionId}.pid`);
      await this.exec(preview, `set -e; if command -v tmux >/dev/null 2>&1 && tmux has-session -t ${name} 2>/dev/null; then tmux kill-session -t ${name}; fi; if [ -f ${pid} ]; then p=$(cat ${pid}); case "$p" in ''|*[!0-9]*) exit 1;; esac; if kill -0 -- "-$p" 2>/dev/null; then kill -- "-$p"; fi; rm -f ${pid}; fi`);
    }
    preview.state.active = false;
    preview.state.running = false;
  }

  run(id: string): Promise<CoderPreviewState> {
    return this.serial(id, async () => {
      const preview = this.get(id);
      if (!preview.state.active || !preview.state.syncedAt) throw new Error('Sync this preview before you run it.');
      await this.signedIn(preview);
      this.step(preview, 'run', 'Reading the run command');
      let run = preview.input.config.coder?.run;
      if (!run) {
        const toml = await this.exec(preview, `if [ -f ${preview.tree}/.talyn/settings.toml ]; then cat ${preview.tree}/.talyn/settings.toml; fi`);
        const config = resolveWorkbenchConfig({ talynToml: toml || null });
        run = config.run.find((script) => script.default)?.command;
      }
      if (!run?.trim()) {
        throw new CoderProblemError({ step: 'run', code: 'error', message: 'This repository has no run command for Coder. Set the Coder run command in Settings → Repositories, or add a default script to .talyn/settings.toml.' });
      }
      await this.stopOthers(preview);
      await this.stopPreview(preview);
      this.step(preview, 'run', `Starting "${run}" in tmux`);
      const name = shellQuote(`talyn-preview-${id}`);
      const log = remotePath(`~/.talyn/previews/${id}.log`);
      const pid = remotePath(`~/.talyn/previews/${id}.pid`);
      const command = `bash -lc ${shellQuote(run)}`;
      await this.exec(preview, `set -e; cd ${preview.tree}; if command -v tmux >/dev/null 2>&1; then tmux new-session -d -s ${name} -c ${preview.tree} ${shellQuote(command)}; else set -m; nohup ${command} > ${log} 2>&1 < /dev/null & echo $! > ${pid}; fi`);
      preview.state.active = true;
      preview.state.running = true;
      return { ...preview.state };
    });
  }

  stop(id: string): Promise<CoderPreviewState | null> {
    return this.serial(id, async () => {
      const preview = this.previews.get(id);
      if (preview) await this.stopPreview(preview);
      return this.state(id);
    });
  }

  open(id: string): Promise<string> {
    return this.serial(id, async () => {
      const preview = this.get(id);
      if (!preview.state.active) throw new Error('Select Preview in Coder to start this preview.');
      await this.signedIn(preview);
      this.step(preview, 'open', "Looking for the template's app URL");
      const ports = preview.input.config.ports;
      const port = (ports.find((item) => item.primary) ?? ports[0])?.port;
      const apps = await this.cli.appUrls(preview.state.workspace!);
      let url = (apps.find((item) => port && item.port === port) ?? apps[0])?.url;
      if (!url) {
        if (!port) throw new Error('Set preview.ports in .talyn/settings.toml, then select Detect again in Settings.');
        this.step(preview, 'open', `Forwarding port ${port} with coder port-forward`);
        url = await this.cli.portForward(preview.state.workspace!, port);
      }
      await this.openExternal(url);
      return url;
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(id, async () => {
      const preview = this.previews.get(id);
      if (!preview) return;
      await this.stopPreview(preview);
      if (preview.state.worktreeReady) {
        this.step(preview, 'worktree', 'Removing the worktree');
        await this.exec(preview, `git -C ${preview.checkout} worktree remove --force ${preview.tree}`);
      }
      this.previews.delete(id);
    });
  }

  async shutdown(): Promise<void> {
    this.cli.stopForwards();
    await Promise.allSettled([...this.previews.keys()].map((id) => this.stop(id)));
  }
}
