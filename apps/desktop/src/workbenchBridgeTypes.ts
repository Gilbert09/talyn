import type { WorkbenchLocalBridge } from '@talyn/shared';

export type DesktopWorkbenchBridge = Omit<WorkbenchLocalBridge, 'repoPaths'> & {
  repoPaths: Omit<WorkbenchLocalBridge['repoPaths'], 'set'> & {
    homeDir(): Promise<string>;
    set(input: { repoFullName: string; path: string; ifMissing?: boolean }): Promise<Record<string, string>>;
    detect(input: { repoFullNames: string[] }): Promise<Record<string, string[]>>;
    uniqueMain(candidates: Record<string, string[]>): Promise<Record<string, string>>;
    scanRoots: {
      get(): Promise<string[]>;
      add(): Promise<string[] | null>;
      remove(root: string): Promise<string[]>;
    };
  };
};
