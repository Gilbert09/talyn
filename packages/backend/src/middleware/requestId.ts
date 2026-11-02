import { randomBytes } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** `req_<ulid>`, minted per public API request. In every error body and the `X-Request-Id` header. */
      requestId?: string;
    }
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A ULID: 48 bits of milliseconds and 80 random bits, in Crockford base32.
 * Sorts by time, so a support person can find neighbours of a request id.
 */
export function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}

/**
 * Give the request an id and return it as `X-Request-Id`. A client-supplied id
 * is not trusted: the id is ours, so a log search on it finds only our lines.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = `req_${ulid()}`;
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
