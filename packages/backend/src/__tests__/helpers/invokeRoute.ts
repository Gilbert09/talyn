import type { Request, Response, Router } from 'express';

export async function invokeRoute<T>(
  router: Router,
  method: string,
  path: string,
  request: Partial<Request>,
): Promise<{ status: number; body: T }> {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response) => Promise<unknown> }> } };
  const layer = (router.stack as Layer[]).find((item) => item.route?.path === path && (item.route.methods[method.toLowerCase()] || item.route.methods._all));
  if (!layer?.route) throw new Error(`Missing route: ${method} ${path}`);
  let status = 200;
  let body: T | undefined;
  const res = {
    status(code: number) { status = code; return res; },
    json(value: T) { body = value; return res; },
  };
  await layer.route.stack[0].handle(request as Request, res as unknown as Response);
  if (body === undefined) throw new Error('The route did not return JSON.');
  return { status, body };
}
