import type { WorkbenchLocalBridge } from '@talyn/shared';

export interface PreviewForward {
  workbenchId: string;
  port: number;
  localPort: number;
  url: string;
}

export type DesktopWorkbenchBridge = Omit<WorkbenchLocalBridge, 'repoPaths'> & {
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
