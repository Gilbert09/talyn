import type { NextFunction, Request, Response } from 'express';
import { PublicApiError, publicErrorBody, toPublicApiError } from '../services/public/errors.js';

/** Send one error in the public shape, with its headers. */
export function sendPublicError(req: Request, res: Response, error: unknown): void {
  const err = toPublicApiError(error);
  if (err.status >= 500) {
    console.error(`[public-api] ${req.method} ${req.path} ${req.requestId ?? ''} failed:`, error);
  }
  for (const [name, value] of Object.entries(err.options.headers ?? {})) res.setHeader(name, value);
  res.status(err.status).json(publicErrorBody(err, req.requestId));
}

/** The `/v1` 404 for a path no route matches. */
export function publicNotFound(req: Request, res: Response): void {
  sendPublicError(req, res, new PublicApiError(404, 'route_not_found', `No route ${req.method} ${req.baseUrl}${req.path}.`));
}

/**
 * The `/v1` error handler. Arity 4 is load-bearing: Express treats a
 * middleware as an error handler only with four parameters.
 */
export function publicErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    // A stream that has started cannot change its status. Close it.
    console.error(`[public-api] ${req.method} ${req.path} failed after the headers were sent:`, err);
    if (!res.writableEnded) res.end();
    return;
  }
  void next;
  sendPublicError(req, res, err);
}
