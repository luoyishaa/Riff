import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthResponse, SessionDto } from '@collab/protocol';
import type { DocumentStore, PrincipalRecord } from './infra/document-store.js';
import { fail } from './http.js';

const SESSION_COOKIE = 'collab_session';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

function cookieValue(header: string | string[] | undefined, name: string): string | undefined {
  const value = Array.isArray(header) ? header.join(';') : header;
  for (const part of value?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64, SCRYPT).toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${derived}`;
}

function passwordMatches(password: string, encoded: string): boolean {
  const [algorithm, n, r, p, salt, expectedHex] = encoded.split('$');
  if (algorithm !== 'scrypt' || n !== String(SCRYPT.N) || r !== String(SCRYPT.r) || p !== String(SCRYPT.p) || !salt || !expectedHex) return false;
  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = scryptSync(password, salt, expected.length, SCRYPT);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Cookie sessions for human accounts. The browser holds an opaque token in an
 * HttpOnly cookie; the database keeps only its hash. `x-principal-id` is
 * honoured only when the server runs with COLLAB_DEV_AUTH_BYPASS=1 (tests).
 */
export class AuthService {
  constructor(
    private readonly store: DocumentStore,
    private readonly options: { allowLegacyHeader: boolean; now: () => number },
  ) {}

  principalId(headers: IncomingHttpHeaders): string {
    const token = cookieValue(headers.cookie, SESSION_COOKIE);
    const fromSession = token === undefined ? undefined : this.store.principalIdForAuthSession(tokenHash(token), this.options.now());
    if (fromSession) return fromSession;
    if (!this.options.allowLegacyHeader) return '';
    const legacy = headers['x-principal-id'];
    return (Array.isArray(legacy) ? legacy[0] : legacy) ?? '';
  }

  /** The signed-in human, or a 401 reply already sent. */
  requireHuman(request: FastifyRequest, reply: FastifyReply): PrincipalRecord | undefined {
    const principal = this.store.principal(this.principalId(request.headers));
    if (principal?.kind === 'human') return principal;
    void fail(reply, 401, 'authentication-required', 'A signed-in account is required');
    return undefined;
  }

  session(request: FastifyRequest, principalId: string): SessionDto {
    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    const stored = token === undefined ? undefined : this.store.authSession(tokenHash(token), this.options.now());
    return { principalId, transport: stored ? 'cookie' : 'legacy-header', ...(stored === undefined ? {} : { expiresAt: stored.expiresAt }) };
  }

  authenticate(identifier: string, password: string): PrincipalRecord | undefined {
    const account = this.store.humanPrincipalByIdentifier(identifier);
    const credential = account === undefined ? undefined : this.store.principalPasswordHash(account.id);
    return account && credential && passwordMatches(password, credential) ? account : undefined;
  }

  /** Start a session for this browser; other devices keep theirs. */
  signIn(principal: PrincipalRecord, reply: FastifyReply): AuthResponse {
    const token = randomBytes(32).toString('base64url');
    const createdAt = this.options.now();
    const expiresAt = createdAt + SESSION_LIFETIME_MS;
    this.store.createAuthSession(tokenHash(token), principal.id, createdAt, expiresAt);
    void reply.header('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}`);
    return { principal, session: { principalId: principal.id, transport: 'cookie', expiresAt } };
  }

  signOut(request: FastifyRequest, reply: FastifyReply): void {
    const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
    if (token !== undefined) this.store.revokeAuthSession(tokenHash(token));
    void reply.header('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  hasSessionCookie(request: FastifyRequest): boolean {
    return cookieValue(request.headers.cookie, SESSION_COOKIE) !== undefined;
  }
}
