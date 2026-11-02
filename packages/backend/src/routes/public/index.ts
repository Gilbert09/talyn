import express, { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler.js';
import { assertApiToken, requireApiToken, requireScope } from '../../middleware/publicAuth.js';
import { publicErrorHandler, publicNotFound } from '../../middleware/publicErrors.js';
import { authFailureGuard, PUBLIC_RATE_LIMITS, publicRateLimit, type RateLimitStore } from '../../middleware/publicRateLimit.js';
import { requestId } from '../../middleware/requestId.js';
import type { ApiTokenPrincipal } from '../../services/apiTokens.js';
import { assertSessionsAvailable } from '../../services/public/authorize.js';
import { PublicApiError } from '../../services/public/errors.js';
import {
  claimIdempotencyKey,
  IDEMPOTENCY_HEADER,
  requestFingerprint,
  validateIdempotencyKey,
  type IdempotencyClaim,
} from '../../services/public/idempotency.js';
import { expressPath, type PublicRoute } from './define.js';
import { PUBLIC_ROUTES } from './routes.js';

/**
 * The public API, mounted at `/v1` (served as `https://api.talyn.dev/v1`).
 *
 * It shares nothing with `/api/v1` but the services. Its own conventions:
 * personal access tokens only, snake_case bodies with no envelope, errors as
 * `{ error: { type, code, message, param, request_id } }`, opaque cursors,
 * `Idempotency-Key` on creates, and rate limits per token with `RateLimit-*`
 * headers.
 *
 * NO CORS. `index.ts` mounts this router BEFORE the app's `cors()`, so no
 * `Access-Control-*` header is ever sent and a browser cannot read a `/v1`
 * answer. A personal access token must not live in a web page.
 *
 * The order of the middleware is the security model:
 *  1. a request id, so even a refusal can be traced;
 *  2. a per-IP limit on FAILED authentications, checked before the token
 *     lookup, because each lookup is a database read and a brute force must
 *     not drive those;
 *  3. the token, and the `publicApi` flag for its owner;
 *  4. a per-token limit, then per route: the scope, the create limit, the
 *     `workbenches` flag for session routes, and idempotency.
 */

export interface PublicApiRouterOptions {
  /** Tests pass a store so limits do not leak between test cases. */
  rateLimitStore?: RateLimitStore;
}

export function publicApiRouter(options: PublicApiRouterOptions = {}): Router {
  const router = Router();
  const store = options.rateLimitStore;
  const tokenKey = (req: Request) => assertApiToken(req).tokenId;

  const authFailures = authFailureGuard({
    name: 'auth-fail',
    ...PUBLIC_RATE_LIMITS.authFailuresPerIp,
    keyFn: (req) => req.ip ?? 'unknown',
    store,
  });

  router.use(requestId);
  router.use(asyncHandler(authFailures.check));
  router.use(express.json({ limit: '1mb' }));

  const createLimiter = asyncHandler(
    publicRateLimit({
      name: 'create',
      ...PUBLIC_RATE_LIMITS.creates,
      keyFn: tokenKey,
      message: 'Too many sessions, chats or messages started. Wait, then retry.',
      store,
    }),
  );

  const mount = (route: PublicRoute) => {
    const chain = [];
    if (route.scope !== 'none' && route.scope !== 'any') chain.push(requireScope(route.scope));
    if (route.creates) chain.push(createLimiter);
    chain.push(asyncHandler((req: Request, res: Response) => runRoute(route, req, res)));
    router[route.method](expressPath(route.path), ...chain);
  };

  for (const route of PUBLIC_ROUTES) if (route.scope === 'none') mount(route);

  router.use(
    asyncHandler(async (req: Request, res: Response, next) => {
      try {
        await requireApiToken(req, res, next);
      } catch (err) {
        if (err instanceof PublicApiError && err.status === 401) await authFailures.record(req);
        throw err;
      }
    }),
  );
  router.use(
    asyncHandler(
      publicRateLimit({ name: 'token', ...PUBLIC_RATE_LIMITS.perToken, keyFn: tokenKey, store }),
    ),
  );

  for (const route of PUBLIC_ROUTES) if (route.scope !== 'none') mount(route);

  router.use(publicNotFound);
  router.use(publicErrorHandler);
  return router;
}

async function runRoute(route: PublicRoute, req: Request, res: Response): Promise<void> {
  const token = req.apiToken as ApiTokenPrincipal;
  if (route.sessions) await assertSessionsAvailable(token);

  const params = route.params ? route.params.parse(req.params) : {};
  const query = route.query ? route.query.parse(req.query) : {};
  const body = route.body ? route.body.parse(req.body ?? {}) : undefined;

  let claim: IdempotencyClaim | null = null;
  const rawKey = route.creates ? req.header(IDEMPOTENCY_HEADER) : undefined;
  if (rawKey !== undefined) {
    const key = validateIdempotencyKey(rawKey);
    claim = await claimIdempotencyKey(token.tokenId, key, requestFingerprint(req.method, `${req.baseUrl}${req.path}`, req.body));
    if (claim.kind === 'replay') {
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(claim.status).json(route.replayBody ? await route.replayBody(claim.body, token) : claim.body);
      return;
    }
  }

  let result;
  try {
    result = await route.handler({ req, res, params, query, body, token });
  } catch (err) {
    if (claim?.kind === 'proceed') await claim.release().catch(() => undefined);
    throw err;
  }
  if (!result) return;
  if (claim?.kind === 'proceed') {
    // The work is done: a failed write here must not turn it into an error. The
    // key then stays in progress until it is abandoned (see idempotency.ts).
    const stored = route.idempotentBody ? route.idempotentBody(result.body) : (result.body ?? null);
    const settle = result.status < 300 ? claim.complete(result.status, stored) : claim.release();
    await settle.catch((err) => console.warn('[public-api] could not record an idempotency key:', err));
  }
  if (result.body === undefined) res.status(result.status).end();
  else res.status(result.status).json(result.body);
}
