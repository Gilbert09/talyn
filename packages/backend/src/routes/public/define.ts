import type { Request, Response } from 'express';
import type { ZodTypeAny, output } from 'zod';
import type { ApiScope } from '@talyn/shared';
import type { ApiTokenPrincipal } from '../../services/apiTokens.js';

/**
 * One `/v1` route, declared once. The router mounts it from this declaration
 * and the OpenAPI spec is generated from it, so a route cannot exist without
 * a scope, a schema and an entry in the spec. `openapi.contract.test.ts` holds
 * that: it compares the mounted Express routes with the spec.
 */

export type PublicHttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface PublicResponseSpec {
  description: string;
  /** JSON body schema. Absent for a 204 or a stream. */
  schema?: ZodTypeAny;
  /** Default `application/json`. */
  contentType?: 'application/json' | 'text/event-stream';
}

export interface PublicRouteContext<P, Q, B> {
  req: Request;
  res: Response;
  params: P;
  query: Q;
  body: B;
  token: ApiTokenPrincipal;
}

/** A JSON answer. A handler that writes the response itself (a stream) returns nothing. */
export type PublicRouteResult = { status: number; body?: unknown } | void;

interface RouteFields {
  method: PublicHttpMethod;
  /** OpenAPI style, relative to `/v1`: `/sessions/{id}`. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tag: string;
  /**
   * What the caller needs: a scope, `any` (any valid token, e.g. `/me`), or
   * `none` (no token; the spec itself). A route must say which.
   */
  scope: ApiScope | 'any' | 'none';
  /** Starts work: honours `Idempotency-Key`, and counts against the per-token create budget. */
  creates?: boolean;
  /** Reads or changes sessions: also needs the `workbenches` flag for the token owner. */
  sessions?: boolean;
  /**
   * For a create whose answer holds a secret: what the idempotency record
   * stores instead of the answer, and how a replay rebuilds the answer from
   * it. The idempotency table must never hold a plaintext secret.
   */
  idempotentBody?: (body: unknown) => unknown;
  replayBody?: (stored: unknown, token: ApiTokenPrincipal) => Promise<unknown>;
  /** Success responses. Error responses are added to the spec for every route. */
  responses: Record<number, PublicResponseSpec>;
}

export interface PublicRouteDefinition<P extends ZodTypeAny, Q extends ZodTypeAny, B extends ZodTypeAny> extends RouteFields {
  params?: P;
  query?: Q;
  body?: B;
  handler(ctx: PublicRouteContext<output<P>, output<Q>, output<B>>): Promise<PublicRouteResult>;
}

/** A route with its schema types erased, for the router and the spec builder. */
export interface PublicRoute extends RouteFields {
  params?: ZodTypeAny;
  query?: ZodTypeAny;
  body?: ZodTypeAny;
  handler(ctx: PublicRouteContext<unknown, unknown, unknown>): Promise<PublicRouteResult>;
}

export function definePublicRoute<
  P extends ZodTypeAny = ZodTypeAny,
  Q extends ZodTypeAny = ZodTypeAny,
  B extends ZodTypeAny = ZodTypeAny,
>(route: PublicRouteDefinition<P, Q, B>): PublicRoute {
  return route as unknown as PublicRoute;
}

/** `/sessions/{id}/chats` → `/sessions/:id/chats`. */
export function expressPath(openApiPath: string): string {
  return openApiPath.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
}
