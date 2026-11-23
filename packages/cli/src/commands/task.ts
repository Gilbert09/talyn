import { Command } from 'commander';
import type { Task } from '@talyn/shared';
import { request } from '../client.js';

function envDefaults() {
  return {
    workspaceId: process.env.TALYN_WORKSPACE_ID,
    taskId: process.env.TALYN_TASK_ID,
  };
}

export function registerTaskCommands(program: Command): void {
  const task = program
    .command('task')
    .description('Inspect Talyn tasks. Only the Talyn app creates tasks.');

  task
    .command('list')
    .description('List tasks in a workspace')
    .option('--workspace <id>', 'Workspace id')
    .option('--status <status>', 'Filter by status')
    .option('--type <type>', 'Filter by type')
    .option('--json', 'Emit machine-readable JSON on stdout')
    .action(async (opts) => {
      const workspaceId = opts.workspace || envDefaults().workspaceId;
      const params = new URLSearchParams();
      if (workspaceId) params.set('workspaceId', workspaceId);
      if (opts.status) params.set('status', opts.status);
      if (opts.type) params.set('type', opts.type);
      const qs = params.toString();

      try {
        const tasks = await request<Task[]>('GET', `/tasks${qs ? `?${qs}` : ''}`);
        if (opts.json) {
          process.stdout.write(JSON.stringify(tasks) + '\n');
        } else {
          for (const t of tasks) {
            console.log(`${t.id}  ${t.status.padEnd(16)}  ${t.type.padEnd(13)}  ${t.title}`);
          }
          if (tasks.length === 0) console.log('(no tasks)');
        }
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
