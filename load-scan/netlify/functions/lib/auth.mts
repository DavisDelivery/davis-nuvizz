// auth.mts — driver credentials, PIN hashing, and session tokens.
//
// NuVizz has no per-driver auth (single tenant service account), so this app owns
// its own credential store. A driver logs in with a Davis-assigned driver number
// and a PIN; nothing here ever talks to NuVizz.
//
// PIN storage: scrypt with a per-credential random salt. Never plaintext, never a
// bare hash. Verification is constant-time.
//
// Tokens: HMAC-SHA256 JWT, 90-day expiry, signed with LOADSCAN_JWT_SECRET.

import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHmac } from 'node:crypto';

const scrypt = (pin: string, salt: Buffer, len = 32): Promise<Buffer> =>
  new Promise((resolve, reject) => _scrypt(pin, salt, len, (err, dk) => (err ? reject(err) : resolve(dk))));

export const DRIVER_AUTH = 'driver_auth';
export const UNMATCHED_ALIASES = 'load_scan_unmatched_aliases';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;
export const TOKEN_DAYS = 90;

// ── PIN hashing ──────────────────────────────────────────────────────────────

/** Format: scrypt$<saltHex>$<hashHex>. Self-describing so the algorithm can change. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(pin, salt);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const dk = await scrypt(pin, salt, expected.length);
  // Lengths already match by construction; timingSafeEqual throws otherwise.
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

/** 4-6 digits. Anything else is rejected before it can reach the store. */
export function isValidPinFormat(pin: any): boolean {
  return /^\d{4,6}$/.test(String(pin ?? ''));
}

// ── Session tokens ───────────────────────────────────────────────────────────

const b64url = (s: Buffer | string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function secret(): string {
  const s = process.env.LOADSCAN_JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('LOADSCAN_JWT_SECRET not set (needs >= 32 chars)');
  }
  return s;
}

function sign(data: string): string {
  return b64url(createHmac('sha256', secret()).update(data).digest());
}

/**
 * Three roles, and the difference is only ever "whose load am I looking at":
 *
 *   driver      their own load, resolved from the hand-seeded alias set
 *   loader      a forklift operator loading somebody else's truck. Picks the
 *               load off the day's list — one truck start to finish, several
 *               per shift. No aliases, so the identity path never runs.
 *   dispatcher  the credential admin surface
 *
 * Piece matching, duplicate catching, counts and the offline queue are
 * identical for all three: they work on a load, not on a person.
 */
export type Role = 'driver' | 'loader' | 'dispatcher';

/** Anything unrecognized is a driver — the least-privileged role, never a guess upward. */
export function normalizeRole(v: any): Role {
  return v === 'dispatcher' ? 'dispatcher' : v === 'loader' ? 'loader' : 'driver';
}

export interface TokenClaims {
  sub: string; // driverNumber
  name?: string;
  role: Role;
  iat: number;
  exp: number;
}

export function issueToken(driverNumber: string, displayName: string, role: Role = 'driver'): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: String(driverNumber),
      name: displayName || '',
      role,
      iat: now,
      exp: now + TOKEN_DAYS * 86400,
    } satisfies TokenClaims),
  );
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

/** Verify signature AND expiry. Returns null on any failure — never throws for bad input. */
export function verifyToken(token: any): TokenClaims | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  let expected: string;
  try {
    expected = sign(`${h}.${p}`);
  } catch {
    return null; // secret missing — fail closed
  }
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let claims: TokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    return null;
  }
  if (!claims?.sub) return null;
  if (!Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null;
  return claims;
}

/** Pull a bearer token off a request and verify it. */
export function authenticate(req: Request): TokenClaims | null {
  const raw = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? verifyToken(m[1]) : null;
}

// ── Role guard ───────────────────────────────────────────────────────────────

/**
 * Is this credential the LAST active dispatcher?
 *
 * Guard for demotion and deactivation: the bootstrap secret has been used and
 * removed, so a system with zero active dispatchers cannot be administered by
 * anyone. A dispatcher demoting or deactivating the last one — including
 * themselves — is refused.
 */
export function isLastActiveDispatcher(
  creds: Array<{ _id?: any; driverNumber?: any; role?: any; active?: any }>,
  driverNumber: string,
): boolean {
  const id = String(driverNumber);
  const activeDispatchers = (creds || [])
    .filter((c) => c?.role === 'dispatcher' && c?.active !== false)
    .map((c) => String(c?._id ?? c?.driverNumber ?? ''));
  return activeDispatchers.includes(id) && !activeDispatchers.some((n) => n !== id);
}

// ── Lockout ──────────────────────────────────────────────────────────────────

export function isLockedOut(doc: any, nowMs = Date.now()): boolean {
  const until = doc?.lockedUntil ? Date.parse(String(doc.lockedUntil)) : NaN;
  return Number.isFinite(until) && until > nowMs;
}

/** Next credential state after a wrong PIN. Locks at MAX_FAILED_ATTEMPTS. */
export function nextFailureState(doc: any, nowMs = Date.now()): { failedAttempts: number; lockedUntil: string | null } {
  const failed = Number(doc?.failedAttempts || 0) + 1;
  return failed >= MAX_FAILED_ATTEMPTS
    ? { failedAttempts: failed, lockedUntil: new Date(nowMs + LOCKOUT_MINUTES * 60_000).toISOString() }
    : { failedAttempts: failed, lockedUntil: null };
}
