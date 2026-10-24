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

export type DesktopWorkbenchBridge = Omit<WorkbenchLocalBridge, 'repoPaths'> & {
  coder: {
    status(expectedUrl?: string): Promise<CoderStatus>;
    workspaces(): Promise<CoderWorkspace[]>;
  };
  coderPreview: CoderPreviewBridge;
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
