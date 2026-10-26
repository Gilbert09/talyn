import type { EffectivePreview, WorkbenchLocalBridge } from '@talyn/shared';

export interface PreviewForward {
  workbenchId: string;
  port: number;
  localPort: number;
  url: string;
}

export interface CoderStatus {
  installed: boolean;
  loggedIn: boolean;
  url?: string;
  user?: string;
}

export interface CoderWorkspace { name: string; owner: string; status: string; template: string }
export interface CoderPreviewInput {
  sessionId: string;
  repoName: string;
  base: string;
  config: EffectivePreview;
}
export interface CoderPreviewState {
  sessionId: string;
  url: string;
  workspace?: string;
  cliReady: boolean;
  workspaceRunning: boolean;
  worktreeReady: boolean;
  active: boolean;
  running: boolean;
  syncedAt?: string;
  turn?: number;
  error?: string;
}
export interface CoderPreviewBridge {
  prepare(input: CoderPreviewInput): Promise<CoderPreviewState>;
  sync(input: { sessionId: string; base: string; patch: string; turn?: number }): Promise<CoderPreviewState>;
  run(sessionId: string): Promise<CoderPreviewState>;
  stop(sessionId: string): Promise<CoderPreviewState | null>;
  open(sessionId: string): Promise<string>;
  remove(sessionId: string): Promise<void>;
  state(sessionId: string): Promise<CoderPreviewState | null>;
}

/** A local Claude Code conversation, as the import picker lists it. */
export interface ClaudeConversation {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  /** Claude Code's own title for the conversation, when it wrote one. */
  title: string | null;
  firstPrompt: string | null;
  /** ISO time of the newest line, or of the file's last change. */
  lastActivity: string;
  bytes: number;
  /** The watched repository the folder is a checkout of, or null with `unavailableReason`. */
  repoFullName: string | null;
  unavailableReason: string | null;
}

/** The upload body for one conversation, built in main. */
export interface ClaudeImportPrepared {
  /** The upload body: header line, gzipped conversation, gzipped patch. */
  body: Uint8Array;
  sessionBytes: number;
  patchBytes: number;
  base: string;
  root: string;
  untrackedFiles: number;
}

export type DesktopWorkbenchBridge = Omit<WorkbenchLocalBridge, 'repoPaths'> & {
  coder: {
    status(expectedUrl?: string): Promise<CoderStatus>;
    workspaces(): Promise<CoderWorkspace[]>;
  };
  coderPreview: CoderPreviewBridge;
  claudeImport: {
    list(repoFullNames: string[]): Promise<ClaudeConversation[]>;
    prepare(input: { sessionId: string; cwd: string }): Promise<ClaudeImportPrepared>;
  };
  preview: {
    start(input: { workbenchId: string; port: number; token: string; apiBaseUrl: string }): Promise<PreviewForward>;
    stop(workbenchId: string, port?: number): Promise<void>;
    list(): Promise<PreviewForward[]>;
    setToken(token: string | null): Promise<void>;
  };
  repoPaths: Omit<WorkbenchLocalBridge['repoPaths'], 'set'> & {
    homeDir(): Promise<string>;
    set(input: { repoFullName: string; path: string; ifMissing?: boolean }): Promise<Record<string, string>>;
    detect(input: { repoFullNames: string[]; startup?: boolean }): Promise<Record<string, string[]>>;
    uniqueMain(candidates: Record<string, string[]>): Promise<Record<string, string>>;
    scanRoots: {
      get(): Promise<string[]>;
      add(): Promise<string[] | null>;
      remove(root: string): Promise<string[]>;
    };
  };
};
