import { randomUUID } from 'crypto';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import {
  buildClaudeArgv,
  buildCodexArgv,
  LineBuffer,
  createClaudeStreamParser,
  createCodexStreamParser,
  checkpointCreateSteps,
  checkpointRef,
  type ClaudePermissionMode,
  type WorkbenchLocalBridge,
} from '@talyn/shared';
import { processEnv } from './environment';
import { exec, safeFilePath } from './git';
import { applyRepositoryInstructions } from './repositoryInstructions';
import { WorkbenchPaths } from './paths';
import { stopGroup, type Emit } from './processes';

type TurnInput = Parameters<WorkbenchLocalBridge['startTurn']>[0] & {
  permissionMode?: ClaudePermissionMode;
};
interface RunningTurn {
  workbenchId: string;
  child?: ChildProcess;
  cancelled: boolean;
  done: Promise<void>;
  finish: () => void;
  stopping?: Promise<void>;
}

export class AgentProcesses {
  private readonly running = new Map<string, RunningTurn>();
  private closing = false;

  constructor(
    private readonly paths: WorkbenchPaths,
    private readonly emit: Emit,
    private readonly command?: (input: TurnInput) => string[],
  ) {}

  async startTurn(input: TurnInput): Promise<void> {
    if (this.closing) throw new Error('The runtime is shutting down');
    if (this.running.has(input.chatId))
      throw new Error('A turn is already running for this chat');
    if (input.agent !== 'claude' && input.agent !== 'codex')
      throw new Error('Unknown agent');
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const turn: RunningTurn = {
      workbenchId: input.workbenchId,
      cancelled: false,
      done,
      finish,
    };
    this.running.set(input.chatId, turn);
    let temporaryIndex: string | undefined;
    try {
      temporaryIndex = await this.paths.tempIndex();
      const checkpoint = await exec(
        input.path,
        checkpointCreateSteps({
          chatId: input.chatId,
          turn: input.turn,
          tmpIndexPath: temporaryIndex,
        }),
      );
      if (checkpoint.exitCode !== 0)
        throw new Error(`Checkpoint failed: ${checkpoint.stderr}`);
      const sha = checkpoint.stdout.trim().split('\n').pop()!;
      this.emit('workbench:checkpoint', {
        chatId: input.chatId,
        turn: input.turn,
        ref: checkpointRef(input.chatId, input.turn),
        sha,
        createdAt: new Date().toISOString(),
      });
      const prepared = await this.prepareAttachments(input);
      if (input.repositoryInstructions !== undefined) {
        await applyRepositoryInstructions(input.path, input.agent, input.repositoryInstructions).catch((err) =>
          console.warn('[workbench] repository instructions failed:', err),
        );
      }
      const env = await processEnv();
      if (turn.cancelled) {
        this.emit('workbench:turn-end', {
          chatId: input.chatId,
          turn: input.turn,
          exitCode: null,
          sessionId: input.resumeSessionId ?? null,
          isError: false,
          resultText: '',
          cancelled: true,
        });
        this.running.delete(input.chatId);
        finish();
        return;
      }
      const argv =
        this.command?.(input) ??
        (input.agent === 'claude'
          ? buildClaudeArgv({
              ...input,
              prompt: prepared.prompt,
              permissionMode: input.permissionMode ?? 'acceptEdits',
            })
          : buildCodexArgv({ ...input, ...prepared }));
      const parser =
        input.agent === 'claude'
          ? createClaudeStreamParser()
          : createCodexStreamParser();
      const lines = new LineBuffer();
      const child = spawn(argv[0], argv.slice(1), {
        cwd: input.path,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      turn.child = child;
      let stderr = '';
      let spawnError: string | undefined;
      const feed = (line: string) => {
        for (const event of parser.push(line)) {
          this.emit('workbench:turn-event', {
            chatId: input.chatId,
            turn: input.turn,
            event,
          });
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) =>
        lines.push(chunk).forEach(feed),
      );
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-16 * 1024);
      });
      child.once('error', (error) => {
        spawnError = error.message;
      });
      child.once('close', (exitCode, signal) => {
        lines.flush().forEach(feed);
        const failed =
          !turn.cancelled &&
          (exitCode !== 0 ||
            !!spawnError ||
            parser.result?.isError === true ||
            !parser.result);
        const error = failed
          ? [
              spawnError ??
                parser.result?.text ??
                `Agent exited with code ${exitCode}${signal ? ` (${signal})` : ''}`,
              stderr,
            ]
              .filter(Boolean)
              .join('\n')
          : undefined;
        this.emit('workbench:turn-end', {
          chatId: input.chatId,
          turn: input.turn,
          exitCode,
          sessionId: parser.sessionId ?? input.resumeSessionId ?? null,
          isError: failed,
          resultText: error ?? parser.result?.text ?? '',
          cancelled: turn.cancelled,
          ...(error ? { error } : {}),
        });
        // Keep the chat reserved until cancellation also stops its descendants.
        void (turn.stopping ?? Promise.resolve()).finally(() => {
          this.running.delete(input.chatId);
          finish();
        });
      });
    } catch (error) {
      this.running.delete(input.chatId);
      finish();
      throw error;
    } finally {
      if (temporaryIndex) await fs.rm(temporaryIndex, { force: true });
    }
  }

  private async prepareAttachments(
    input: TurnInput,
  ): Promise<{ prompt: string; images: string[] }> {
    const files: string[] = [];
    const images: string[] = [];
    for (const attachment of input.attachments ?? []) {
      let file: string;
      if (attachment.path) {
        file = await safeFilePath(input.path, attachment.path);
        if (!(await fs.stat(file)).isFile())
          throw new Error('Attachment is not a regular file');
      } else if (attachment.dataBase64 !== undefined) {
        if (attachment.dataBase64.length > 28 * 1024 * 1024)
          throw new Error('Attachment exceeds the 20 MiB limit');
        const data = Buffer.from(attachment.dataBase64, 'base64');
        if (data.length > 20 * 1024 * 1024)
          throw new Error('Attachment exceeds the 20 MiB limit');
        const context = path.join(await fs.realpath(input.path), '.context');
        await fs.mkdir(context, { recursive: true, mode: 0o700 });
        if ((await fs.lstat(context)).isSymbolicLink())
          throw new Error('Attachment directory must not be a symlink');
        const directory = await fs.mkdtemp(path.join(context, 'attachments-'));
        file = path.join(
          directory,
          `${randomUUID()}-${path.basename(attachment.name).replace(/[^a-zA-Z0-9._-]/g, '_')}`,
        );
        await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
      } else {
        throw new Error('Attachment has no file or data');
      }
      files.push(`${JSON.stringify(attachment.name)}: ${JSON.stringify(file)}`);
      if (attachment.mimeType.startsWith('image/')) images.push(file);
    }
    return {
      prompt: files.length
        ? `${input.prompt}\n\nAttached files:\n${files.join('\n')}`
        : input.prompt,
      images,
    };
  }

  async cancelTurn(chatId: string): Promise<void> {
    const turn = this.running.get(chatId);
    if (!turn) return;
    turn.cancelled = true;
    if (turn.child?.pid) turn.stopping ??= stopGroup(turn.child.pid);
    await turn.stopping;
    await turn.done;
  }

  async stopWorkbench(workbenchId: string): Promise<void> {
    await Promise.all(
      [...this.running]
        .filter(([, turn]) => turn.workbenchId === workbenchId)
        .map(([chatId]) => this.cancelTurn(chatId)),
    );
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all(
      [...this.running.keys()].map((chatId) => this.cancelTurn(chatId)),
    );
  }
}
