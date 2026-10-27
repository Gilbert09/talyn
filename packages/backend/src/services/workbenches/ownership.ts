import { randomUUID } from 'node:crypto';

export const TURN_OWNER = randomUUID();
let draining = false;
let detached = false;
export const isWorkbenchDraining = (): boolean => draining;
export const isWorkbenchDetached = (): boolean => detached;
export function beginWorkbenchDrain(): void { draining = true; }
export function detachWorkbenchFollowers(): void { detached = true; }
export function resetWorkbenchDrainForTests(): void { draining = false; detached = false; }
