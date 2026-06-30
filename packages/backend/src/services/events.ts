import { EventEmitter } from 'node:events';
import type { TaskStatus } from '@talyn/shared';
import { debugBus } from './debugBus.js';

export interface DomainTaskStatusEvent {
  workspaceId: string;
  taskId: string;
  status: TaskStatus;
}

interface DomainEvents {
  on(event: 'task:status', listener: (evt: DomainTaskStatusEvent) => void): DomainEventEmitter;
  off(event: 'task:status', listener: (evt: DomainTaskStatusEvent) => void): DomainEventEmitter;
  emit(event: 'task:status', evt: DomainTaskStatusEvent): boolean;
}

class DomainEventEmitter extends EventEmitter implements DomainEvents {}

/**
 * In-process event bus for server-side listeners. Websocket broadcast is a
 * separate concern — it goes to clients; this one goes to other backend
 * services that need to react to state transitions (e.g. the Continuous Build
 * scheduler reacts to tasks hitting terminal states).
 */
export const domainEvents = new DomainEventEmitter();

// Mirror domain events into the developer Debug stream.
domainEvents.on('task:status', (evt) => {
  debugBus.recordEvent({
    service: 'tasks',
    action: 'task:status',
    summary: `task ${evt.taskId.slice(0, 8)} → ${evt.status}`,
    meta: { taskId: evt.taskId, status: evt.status, workspaceId: evt.workspaceId },
  });
});
