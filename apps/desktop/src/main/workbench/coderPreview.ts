import { resolveWorkbenchConfig } from '@talyn/shared';
import type { CoderPreviewInput, CoderPreviewState, CoderWorkspace } from '../../workbenchBridgeTypes';
import { CoderCli, coderOrigin, remotePath, shellQuote, workspaceName } from './coder';

type Cli = Pick<CoderCli, 'status' | 'workspaces' | 'start' | 'exec' | 'appUrls' | 'portForward' | 'stopForwards'>;
interface Preview { input: CoderPreviewInput; state: CoderPreviewState; checkout: string; tree: string }

export function pickWorkspace(workspaces: CoderWorkspace[], choice: { workspace?: string; template?: string }): CoderWorkspace {
  if (choice.workspace) {
    workspaceName(choice.workspace);
    const chosen = workspaces.filter((item) => item.name === choice.workspace);
    if (chosen.length === 1) return chosen[0];
  } else {
    const matching = workspaces.filter((item) => item.template === choice.template && ['running', 'stopped'].includes(item.status));
    if (choice.template && matching.length === 1) return matching[0];
    if (workspaces.length === 1) return workspaces[0];
  }
  const names = workspaces.map((item) => `${item.name} (${item.template}, ${item.status})`).join(', ') || 'none';
  throw new Error(`Select a workspace in Settings. Available workspaces: ${names}. Run: coder list --output json`);
}

function sessionId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid preview session ID.');
  return value;
}
function baseSha(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{7,64}$/i.test(value)) throw new Error('The preview base must be a commit SHA.');
  return value;
}

export class CoderPreviews {
  private previews = new Map<string, Preview>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private cli: Cli, private openExternal: (url: string) => Promise<void>) {}

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    sessionId(id);
    const next = this.queue.catch(() => undefined).then(async () => {
      const preview = this.previews.get(id);
      if (preview) preview.state.error = undefined;
      try { return await action(); } catch (error) {
        const current = this.previews.get(id);
        if (current) current.state.error = error instanceof Error ? error.message : String(error);
        throw error;
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

  private async check(url: string) {
    const status = await this.cli.status(url).catch((error) => {
      throw new Error(`Could not connect to Coder. Run: coder whoami\n${error instanceof Error ? error.message : String(error)}`);
    });
    if (!status.installed) throw new Error('Install the Coder CLI. Run: brew install coder/coder/coder');
    if (!status.loggedIn) throw new Error(`Sign in to Coder. Run: coder login ${coderOrigin(url)}`);
    return status;
  }

  private async exec(preview: Preview, script: string, input?: string): Promise<string> {
    const workspace = preview.state.workspace!;
    const result = await this.cli.exec(workspace, script, { input }).catch((error) => {
      throw new Error(`Coder command failed. Check the workspace: coder ssh ${workspace}\n${error instanceof Error ? error.message : String(error)}`);
    });
    if (result.code) throw new Error(`Coder command failed (${result.code}): ${result.stderr || result.stdout}\nCheck the workspace: coder ssh ${workspace}`);
    return result.stdout;
  }

  prepare(input: CoderPreviewInput): Promise<CoderPreviewState> {
    return this.serial(input.sessionId, async () => {
      baseSha(input.base);
      if (input.config.target !== 'coder' || !input.config.coder?.url) throw new Error('Set the Coder URL in Settings.');
      const url = coderOrigin(input.config.coder.url);
      const coder = input.config.coder;
      const repo = input.repoName.split('/').pop()!;
      if (!/^[A-Za-z0-9._-]+$/.test(repo)) throw new Error('Invalid repository name.');
      const checkout = remotePath(coder.checkout || `~/${repo}`);
      let preview = this.previews.get(input.sessionId);
      if (preview && (preview.state.url !== url || preview.checkout !== checkout || preview.input.config.coder?.workspace !== coder.workspace)) {
        throw new Error('Remove this preview before you change its URL, workspace, or checkout.');
      }
      if (!preview) {
        preview = { input, checkout, tree: remotePath(`~/.talyn/previews/${input.sessionId}`), state: {
          sessionId: input.sessionId, url, cliReady: false, workspaceRunning: false,
          worktreeReady: false, active: false, running: false,
        } };
        this.previews.set(input.sessionId, preview);
      }
      const status = await this.check(url);
      preview.state.cliReady = true;
      const available = (await this.cli.workspaces()).filter((item) => !item.owner || item.owner === status.user);
      const workspace = pickWorkspace(available, { ...coder, workspace: preview.state.workspace || coder.workspace });
      preview.state.workspace = workspace.name;
      if (workspace.status !== 'running') await this.cli.start(workspace.name);
      preview.state.workspaceRunning = true;
      await this.stopOthers(preview);
      if (!preview.state.worktreeReady) {
        await this.exec(preview, `set -e; mkdir -p "$HOME/.talyn/previews"; if [ ! -e ${preview.tree} ]; then git -C ${checkout} fetch --quiet origin && git -C ${checkout} worktree add --force --detach ${preview.tree} ${input.base}; fi; test ! -L ${preview.tree}; test -f ${preview.tree}/.git`);
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
      await this.check(preview.state.url);
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
      await this.check(preview.state.url);
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
      await this.check(preview.state.url);
      let run = preview.input.config.coder?.run;
      if (!run) {
        const toml = await this.exec(preview, `if [ -f ${preview.tree}/.talyn/settings.toml ]; then cat ${preview.tree}/.talyn/settings.toml; fi`);
        const config = resolveWorkbenchConfig({ talynToml: toml || null });
        run = config.run.find((script) => script.default)?.command;
      }
      if (!run?.trim()) throw new Error('Set the Coder run command in Settings → Repositories.');
      await this.stopOthers(preview);
      await this.stopPreview(preview);
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
      await this.check(preview.state.url);
      const ports = preview.input.config.ports;
      const port = (ports.find((item) => item.primary) ?? ports[0])?.port;
      const apps = await this.cli.appUrls(preview.state.workspace!);
      let url = (apps.find((item) => port && item.port === port) ?? apps[0])?.url;
      if (!url) {
        if (!port) throw new Error('Set preview.ports in .talyn/settings.toml, then select Detect again in Settings.');
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
      if (preview.state.worktreeReady) await this.exec(preview, `git -C ${preview.checkout} worktree remove --force ${preview.tree}`);
      this.previews.delete(id);
    });
  }

  async shutdown(): Promise<void> {
    this.cli.stopForwards();
    await Promise.allSettled([...this.previews.keys()].map((id) => this.stop(id)));
  }
}
