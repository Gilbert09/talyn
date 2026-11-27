import { workbenchCreation, type Workbench, type WorkbenchCreation } from '@talyn/shared';

import type { Scope } from '../../workflow/model';

interface Creation {
  owner: Pick<Scope, 'environment' | 'user'> | null;
  view: WorkbenchCreation;
  replaceComposer: boolean;
  result: Promise<Workbench | null>;
}

let nextId = 0;
let latest: Creation | undefined;

export function beginCreation(owner: Creation['owner'], input: Omit<Parameters<typeof workbenchCreation>[0], 'id'>, replaceComposer: boolean) {
  const view = workbenchCreation({ ...input, id: `creating-${++nextId}` });
  let finish!: (item: Workbench | null) => void;
  const result = new Promise<Workbench | null>((resolve) => { finish = resolve; });
  latest = { owner, view, replaceComposer, result };
  return { id: view.workbench.id, finish };
}

export function getCreation(owner: Creation['owner'], id: string) {
  if (latest?.view.workbench.id === id && owner?.environment === latest.owner?.environment && owner?.user === latest.owner?.user) {
    return latest;
  }
  return undefined;
}

export function clearCreation(creation: Creation) {
  if (latest === creation) latest = undefined;
}
