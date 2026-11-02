import type { ZodTypeAny } from 'zod';
import { PUBLIC_ERROR_TYPES } from '../../services/public/errorTypes.js';
import { z } from './zod.js';

/** The page size when the caller does not say, and the most one page can hold. */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export const Id = z.string().min(1).max(200);

export const Timestamp = z.string().openapi({ format: 'date-time', example: '2026-11-02T09:30:00.000Z' });

export const ErrorBody = z
  .object({
    error: z
      .object({
        type: z.enum(PUBLIC_ERROR_TYPES as [string, ...string[]]),
        code: z.string().openapi({ example: 'session_not_found' }),
        message: z.string(),
        param: z.string().optional().openapi({ description: 'The request field the error is about, when there is one.' }),
        request_id: z.string().nullable().openapi({ example: 'req_01JBX8Z6Q4M8N3V5K7T2W9Y1C0' }),
      })
      .passthrough()
      .openapi({ description: 'Some errors carry more fields, e.g. `limit` and `in_use` on a plan limit.' }),
  })
  .openapi('Error');

/** `?flag=true|false`. */
export const QueryBoolean = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .openapi({ type: 'boolean' });

export const PageQuery = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .openapi({ description: `Items per page, 1 to ${MAX_PAGE_LIMIT}. Default ${DEFAULT_PAGE_LIMIT}.` }),
  cursor: z
    .string()
    .max(500)
    .optional()
    .openapi({ description: 'The `next_cursor` of the previous page. Absent for the first page.' }),
};

/** A page of a list, newest first. */
export function listOf<T extends ZodTypeAny>(item: T, name: string) {
  return z
    .object({
      object: z.literal('list'),
      data: z.array(item),
      has_more: z.boolean(),
      next_cursor: z.string().nullable().openapi({ description: 'Pass as `cursor` for the next page. Null on the last page.' }),
    })
    .openapi(name);
}
