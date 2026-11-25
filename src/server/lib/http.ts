import type { Context } from 'hono';
import type { z } from 'zod';

export interface ErrorIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: ErrorIssue[];

  constructor(status: number, message: string, code = 'error', issues?: ErrorIssue[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export const badRequest = (message: string, issues?: ErrorIssue[]) => new ApiError(400, message, 'bad_request', issues);
export const unauthorized = (message = 'Please sign in to continue.') => new ApiError(401, message, 'unauthorized');
export const forbidden = (message = "You don't have permission to do that.") => new ApiError(403, message, 'forbidden');
export const notFound = (what = 'Page') => new ApiError(404, `${what} not found.`, 'not_found');
export const conflict = (message: string) => new ApiError(409, message, 'conflict');

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
    const first = issues[0];
    const message = first ? (first.path ? `${first.path}: ${first.message}` : first.message) : 'Invalid request.';
    throw new ApiError(400, message, 'validation_error', issues);
  }
  return result.data;
}

/** Parses and validates a JSON request body. */
export async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let data: unknown;
  try {
    const text = await c.req.text();
    data = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('Request body must be valid JSON.');
  }
  return parse(schema, data);
}

export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parse(schema, c.req.query());
}
