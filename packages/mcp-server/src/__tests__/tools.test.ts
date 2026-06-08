import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TOOLS } from '../tools.js';

describe('fastowl MCP tools', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const originalWs = process.env.FASTOWL_WORKSPACE_ID;
  const originalTask = process.env.FASTOWL_TASK_ID;

  beforeEach(() => {
    fetchSpy.mockReset();
    process.env.FASTOWL_WORKSPACE_ID = 'ws-env';
    process.env.FASTOWL_TASK_ID = 't-env';
  });

  afterEach(() => {
    if (originalWs === undefined) delete process.env.FASTOWL_WORKSPACE_ID;
    else process.env.FASTOWL_WORKSPACE_ID = originalWs;
    if (originalTask === undefined) delete process.env.FASTOWL_TASK_ID;
    else process.env.FASTOWL_TASK_ID = originalTask;
  });

  function findTool(name: string) {
    const t = TOOLS.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} missing`);
    return t;
  }

  function okResponse<T>(data: T): Response {
    return new Response(JSON.stringify({ success: true, data }), { status: 200 });
  }

  it('exposes every expected tool with an object inputSchema', () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['fastowl_create_task', 'fastowl_list_tasks'].sort());
    for (const t of TOOLS) {
      expect(t.inputSchema).toHaveProperty('type', 'object');
    }
  });

  it('fastowl_create_task posts to /tasks with env-default workspace', async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse({ id: 't-1', title: 'Ship it', status: 'queued' })
    );
    const tool = findTool('fastowl_create_task');
    const result = await tool.handler({ prompt: 'Ship it' });
    expect(result).toContain('t-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toContain('/api/v1/tasks');
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      workspaceId: 'ws-env',
      type: 'code_writing',
      prompt: 'Ship it',
      priority: 'medium',
    });
  });

  it('fastowl_create_task surfaces backend error as thrown Error', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'bad prompt' }), { status: 400 })
    );
    const tool = findTool('fastowl_create_task');
    await expect(tool.handler({ prompt: 'x' })).rejects.toThrow('bad prompt');
  });

  it('fastowl_list_tasks formats lines predictably', async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse([
        { id: 't1', status: 'queued', type: 'code_writing', title: 'A' },
        { id: 't2', status: 'completed', type: 'manual', title: 'B' },
      ])
    );
    const tool = findTool('fastowl_list_tasks');
    const result = await tool.handler({});
    expect(result).toContain('t1');
    expect(result).toContain('[queued]');
    expect(result).toContain('t2');
  });
});

