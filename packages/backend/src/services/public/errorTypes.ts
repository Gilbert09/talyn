/**
 * The public API's error vocabulary. Every `/v1` error body is
 * `{ error: { type, code, message, param?, request_id } }`.
 *
 * `type` is fixed by the HTTP status. `code` reuses the snake_case codes the
 * apps and the MCP server already use (`not_ready`, `local_runtime`,
 * `task_limit_reached`, ...), so there is one vocabulary.
 */
export type PublicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'plan_limit_error'
  | 'rate_limit_error'
  | 'payload_too_large_error'
  | 'unavailable_error'
  | 'api_error';

export const PUBLIC_ERROR_TYPES: readonly PublicErrorType[] = [
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'conflict_error',
  'plan_limit_error',
  'rate_limit_error',
  'payload_too_large_error',
  'unavailable_error',
  'api_error',
];

export function errorTypeForStatus(status: number): PublicErrorType {
  switch (status) {
    case 400:
    case 415:
    case 422:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 402:
      return 'plan_limit_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 409:
      return 'conflict_error';
    case 413:
      return 'payload_too_large_error';
    case 429:
      return 'rate_limit_error';
    case 503:
      return 'unavailable_error';
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}
