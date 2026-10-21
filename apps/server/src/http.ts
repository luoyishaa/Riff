import type { FastifyReply } from 'fastify';
import type { ReviewError } from '@collab/review';
import type { ZodType, ZodTypeDef } from 'zod';

export function fail(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

/** Parse a request body at the HTTP boundary; on failure the 400 reply is already sent. */
export function parseBody<T>(schema: ZodType<T, ZodTypeDef, unknown>, body: unknown, reply: FastifyReply): T | undefined {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  void fail(reply, 400, 'invalid-request', parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '));
  return undefined;
}

const NOT_FOUND: ReadonlySet<ReviewError> = new Set(['thread-not-found', 'message-not-found', 'suggestion-not-found', 'batch-not-found', 'document-not-found', 'version-not-found']);

export function sendReviewError(reply: FastifyReply, error: ReviewError, message: string): FastifyReply {
  const status = error === 'permission-denied' ? 403 : NOT_FOUND.has(error) ? 404 : 400;
  return fail(reply, status, error, message);
}

export function queryString(query: unknown, name: string): string | undefined {
  if (typeof query !== 'object' || query === null || !(name in query)) return undefined;
  const value = (query as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}
