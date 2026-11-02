import { ZodError } from 'zod';
import { AccessError } from '../../middleware/auth.js';
import {
  AutoKeepDefaultPlanError,
  AutoReviewPlanError,
  LoopLimitError,
  MergeQueueLimitError,
  ReviewCycleLimitError,
  TaskLimitError,
  WorkflowLimitError,
} from '../billing/entitlements.js';
import { fleetErrorAsRefusal } from '../workbenches/errors.js';

import { errorTypeForStatus, type PublicErrorType } from './errorTypes.js';

export { errorTypeForStatus, PUBLIC_ERROR_TYPES, type PublicErrorType } from './errorTypes.js';

/** A refusal with everything the error body needs. Thrown by handlers and middleware. */
export class PublicApiError extends Error {
  readonly type: PublicErrorType;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly options: {
      param?: string;
      /** More fields for the error object, e.g. `limit` on a plan limit. */
      details?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = 'PublicApiError';
    this.type = errorTypeForStatus(status);
  }
}

export const notFound = (what: string, code = `${what}_not_found`): PublicApiError =>
  new PublicApiError(404, code, `No such ${what.replace(/_/g, ' ')}.`);

export const invalid = (message: string, param?: string, code = 'invalid_parameter'): PublicApiError =>
  new PublicApiError(400, code, message, param ? { param } : {});

/**
 * The plan-limit errors the services throw. The 402 carries the same code the
 * apps get, plus the numbers when the error has them.
 */
function planLimitError(err: unknown): PublicApiError | null {
  if (
    err instanceof TaskLimitError ||
    err instanceof MergeQueueLimitError ||
    err instanceof WorkflowLimitError ||
    err instanceof LoopLimitError ||
    err instanceof ReviewCycleLimitError ||
    err instanceof AutoKeepDefaultPlanError ||
    err instanceof AutoReviewPlanError
  ) {
    const fields = err as unknown as { limit?: number; active?: number; queued?: number; count?: number };
    const inUse = fields.active ?? fields.queued ?? fields.count;
    return new PublicApiError(402, err.code, err.message, {
      details: {
        ...(typeof fields.limit === 'number' ? { limit: fields.limit } : {}),
        ...(typeof inUse === 'number' ? { in_use: inUse } : {}),
      },
    });
  }
  return null;
}

function zodParam(err: ZodError): string | undefined {
  const issue = err.issues[0];
  if (!issue) return undefined;
  // An unknown field: name the field, not the object that holds it.
  const path = issue.code === 'unrecognized_keys' ? [...issue.path, issue.keys[0]] : issue.path;
  return path.length > 0 ? path.join('.') : undefined;
}

function zodMessage(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'The request is not valid.';
  if (issue.code === 'unrecognized_keys') return `Unknown field: ${issue.keys.join(', ')}.`;
  const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${where}${issue.message}`;
}

/**
 * Any thrown value as a public error. Unknown faults become a plain 500 with
 * NO internal message: a drizzle "Failed query: select ..." is for our logs,
 * never for a caller.
 */
export function toPublicApiError(err: unknown): PublicApiError {
  if (err instanceof PublicApiError) return err;
  if (err instanceof ZodError) return new PublicApiError(400, 'invalid_parameter', zodMessage(err), { param: zodParam(err) });
  if (err instanceof AccessError) return new PublicApiError(404, 'not_found', 'No such resource.');
  const plan = planLimitError(err);
  if (plan) return plan;
  const refusal = fleetErrorAsRefusal(err);
  if (refusal) return new PublicApiError(refusal.status, refusal.code || 'invalid_request', refusal.message);
  // body-parser's own errors carry a status and a type.
  const bodyError = err as { type?: string; status?: number };
  if (bodyError?.type === 'entity.parse.failed') return new PublicApiError(400, 'invalid_json', 'The request body is not valid JSON.');
  if (bodyError?.type === 'entity.too.large') return new PublicApiError(413, 'body_too_large', 'The request body is too large.');
  if (bodyError?.type === 'encoding.unsupported' || bodyError?.type === 'charset.unsupported') {
    return new PublicApiError(415, 'unsupported_encoding', 'The request body encoding is not supported.');
  }
  return new PublicApiError(500, 'internal_error', 'Something went wrong on our side. Retry, and quote the request id if it continues.');
}

/** The JSON body of an error response. */
export function publicErrorBody(err: PublicApiError, requestId: string | undefined): { error: Record<string, unknown> } {
  return {
    error: {
      type: err.type,
      code: err.code,
      message: err.message,
      ...(err.options.param ? { param: err.options.param } : {}),
      ...(err.options.details ?? {}),
      request_id: requestId ?? null,
    },
  };
}
