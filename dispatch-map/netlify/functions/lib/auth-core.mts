// lib/auth-core.mts — the PURE rules of the dispatch-map user system.
//
// Nothing in here touches Firestore, the network, or a Request. It is the part that
// has to be right and the part that is easiest to test, so it stays free of edges:
// password hashing, the password policy, username/email normalisation, the lockout
// rule, the session token, and the reset token. The store (auth-store.mts) and the
// endpoints (auth-*.mts) are thin wrappers over this.
//
// WHY A HOME-GROWN USER STORE AND NOT FIREBASE AUTH: Chad asked for usernames and
// passwords with resets. Firebase Auth would need the Auth product enabled in the
// console, an email for every account, and a client rewrite before a single function
// could verify a caller; this needs one env var (AUTH_SESSION_SECRET) and works from
// the first deploy. load-scan already runs the same shape for driver PINs
// (load-scan/netlify/functions/lib/auth.mts) and it has held up. The Firestore-rules
// cutover still wants Firebase Auth later; nothing here prevents that — a session
// here can mint a Firebase custom token when that day comes.
//
// Password storage: scrypt, per-credential random salt, cost PARAMETERS ENCODED IN
// THE STRING so the cost can be raised later and old hashes still verify (the audit
// flagged load-scan for omitting them). Verification is constant-time.
//
// Session token: HMAC-SHA256 JWT carrying the user's tokenVersion, so deactivating or
// demoting a user, or changing their password, invalidates every session they hold
// the moment the store is read — no 90-day zombie tokens (audit finding 17).

import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHmac, createHash } from 'node:crypto';

// ── Roles ────────────────────────────────────────────────────────────────────

/**
 * admin       manages users and the switches that spend money or email customers
 * dispatcher  runs the board: routing, notes, NuVizz writes, SMS, manual scans
 * viewer      read-only — the board and the reports, nothing that acts
 */
export type Role = 'admin' | 'dispatcher' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'dispatcher', 'viewer'] as const;

/** Anything unrecognised is a viewer — the least-privileged role, never a guess upward. */
export function normalizeRole(v: any): Role {
  return v === 'admin' ? 'admin' : v === 'dispatcher' ? 'dispatcher' : 'viewer';
}

export function roleAtLeast(have: Role, need: Role): boolean {
  const rank: Record<Role, number> = { viewer: 0, dispatcher: 1, admin: 2 };
  return rank[normalizeRole(have)] >= rank[normalizeRole(need)];
}

// ── Identifiers ──────────────────────────────────────────────────────────────

// Lower-case, starts alphanumeric, 2–40 chars. The username IS the Firestore document
// id, so the character set is deliberately narrower than "what a person might type":
// no '/', no '.', no '..', nothing the path guard would refuse.
export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

export function normalizeUsername(v: any): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  return USERNAME_RE.test(s) ? s : null;
}

// Good enough to route mail and strict enough to refuse header injection: one '@',
// no whitespace, no CR/LF, bounded length.
const EMAIL_RE = /^[^\s@<>"',;()[\]\\]+@[^\s@<>"',;()[\]\\]+\.[^\s@<>"',;()[\]\\]+$/;

export function normalizeEmail(v: any): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || s.length > 254) return null;
  return EMAIL_RE.test(s) ? s : null;
}

// ── Password policy ──────────────────────────────────────────────────────────

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** Returns a human-readable problem, or null when the password is acceptable. */
export function passwordProblem(pw: any, username?: string | null): string | null {
  const s = typeof pw === 'string' ? pw : '';
  if (s.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  if (s.length > PASSWORD_MAX) return `password must be at most ${PASSWORD_MAX} characters`;
  if (/^(.)\1+$/.test(s)) return 'password cannot be one repeated character';
  const low = s.toLowerCase();
  if (username && low.includes(String(username).toLowerCase())) return 'password cannot contain the username';
  if (['password', 'davisdelivery', 'dispatch', 'qwertyuiop', '1234567890'].some((w) => low === w || low === w + '1' || low === w + '!')) {
    return 'password is too common';
  }
  return null;
}

// ── Password hashing ─────────────────────────────────────────────────────────

const SCRYPT_N = 1 << 15; // 32768 — ~100ms on a Netlify function, 2× load-scan's PIN cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LEN = 64;
const SCRYPT_MAXMEM = 128 * 1024 * 1024; // room for N up to 2^17 at r=8 when the cost is raised

const scrypt = (pw: string, salt: Buffer, len: number, N: number, r: number, p: number): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    _scrypt(pw, salt, len, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, dk) => (err ? reject(err) : resolve(dk))));

/** Format: scrypt$N$r$p$<saltHex>$<hashHex>. Self-describing so the cost can change. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(pw, salt, SCRYPT_LEN, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export interface ParsedHash { N: number; r: number; p: number; salt: Buffer; hash: Buffer }

export function parseHash(stored: any): ParsedHash | null {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
  // N must be a power of two in a sane range — anything else is a corrupt or hostile record.
  if (!Number.isInteger(N) || N < 1024 || N > (1 << 20) || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 8) return null;
  if (!/^[0-9a-f]{16,}$/.test(parts[4]) || !/^[0-9a-f]{32,}$/.test(parts[5])) return null;
  return { N, r, p, salt: Buffer.from(parts[4], 'hex'), hash: Buffer.from(parts[5], 'hex') };
}

/** Constant-time. A malformed stored hash verifies FALSE — never throws, never passes. */
export async function verifyPassword(pw: any, stored: any): Promise<boolean> {
  if (typeof pw !== 'string' || !pw) return false;
  const h = parseHash(stored);
  if (!h) return false;
  let dk: Buffer;
  try { dk = await scrypt(pw, h.salt, h.hash.length, h.N, h.r, h.p); } catch { return false; }
  return dk.length === h.hash.length && timingSafeEqual(dk, h.hash);
}

/** True when a stored hash was made with a lower cost than today's — rehash on next login. */
export function hashNeedsUpgrade(stored: any): boolean {
  const h = parseHash(stored);
  return !!h && (h.N < SCRYPT_N || h.hash.length < SCRYPT_LEN);
}

// A fixed hash to verify AGAINST when the username does not exist, so a miss costs the
// same scrypt as a hit and response time cannot be used to enumerate accounts.
let __dummyHash: string | null = null;
export async function dummyVerify(pw: any): Promise<void> {
  if (!__dummyHash) __dummyHash = await hashPassword('not-a-real-account-' + randomBytes(8).toString('hex'));
  await verifyPassword(typeof pw === 'string' ? pw : 'x', __dummyHash);
}

// ── Lockout ──────────────────────────────────────────────────────────────────

export const MAX_FAILED_ATTEMPTS = 8;
export const LOCKOUT_MINUTES = 15;

export interface LockFields { failedAttempts?: number | null; lockedUntil?: string | null }

export function lockedUntilMs(doc: LockFields | null | undefined): number {
  const t = doc?.lockedUntil ? Date.parse(String(doc.lockedUntil)) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export function isLockedOut(doc: LockFields | null | undefined, nowMs = Date.now()): boolean {
  return lockedUntilMs(doc) > nowMs;
}

/**
 * The state to store after ONE more failure. If a previous lockout has EXPIRED the
 * counter starts again from zero — so a dispatcher who waited the 15 minutes and then
 * mistypes once is not locked straight back out (the audit found load-scan doing that).
 */
export function nextFailureState(doc: LockFields | null | undefined, nowMs = Date.now()): { failedAttempts: number; lockedUntil: string | null } {
  const prior = lockedUntilMs(doc) && lockedUntilMs(doc) <= nowMs ? 0 : Math.max(0, Number(doc?.failedAttempts) || 0);
  const failedAttempts = prior + 1;
  const lockedUntil = failedAttempts >= MAX_FAILED_ATTEMPTS
    ? new Date(nowMs + LOCKOUT_MINUTES * 60_000).toISOString()
    : null;
  return { failedAttempts, lockedUntil };
}

/** Given a counter that was incremented atomically, should the account now be locked? */
export function lockFromCount(failedAttempts: number, nowMs = Date.now()): string | null {
  return failedAttempts >= MAX_FAILED_ATTEMPTS ? new Date(nowMs + LOCKOUT_MINUTES * 60_000).toISOString() : null;
}

// ── Session tokens ───────────────────────────────────────────────────────────

const b64url = (s: Buffer | string) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export const SESSION_SECRET_MIN = 32;

/** Fail CLOSED: no secret, no sessions. A missing env var must never mean "anyone". */
export function sessionSecret(): string {
  const s = String(process.env.AUTH_SESSION_SECRET || '');
  if (s.length < SESSION_SECRET_MIN) throw new Error(`AUTH_SESSION_SECRET not set (needs >= ${SESSION_SECRET_MIN} chars)`);
  return s;
}

export function sessionsConfigured(): boolean {
  try { sessionSecret(); return true; } catch { return false; }
}

export function sessionDays(): number {
  const n = Number(String(process.env.AUTH_SESSION_DAYS || '').trim());
  return Number.isFinite(n) && n >= 1 && n <= 90 ? Math.floor(n) : 14;
}

export interface SessionClaims {
  sub: string;        // username
  name: string;       // display name at issue time (cosmetic; the store is authoritative)
  role: Role;         // role at issue time (cosmetic; the store is authoritative)
  tv: number;         // tokenVersion at issue time — must still match the store
  iat: number;
  exp: number;
}

function hmac(data: string): string {
  return b64url(createHmac('sha256', sessionSecret()).update(data).digest());
}

export function issueSessionToken(u: { username: string; displayName?: string | null; role: any; tokenVersion?: number | null }, nowMs = Date.now()): { token: string; expiresAt: string } {
  const now = Math.floor(nowMs / 1000);
  const exp = now + sessionDays() * 86400;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims: SessionClaims = {
    sub: u.username,
    name: u.displayName || u.username,
    role: normalizeRole(u.role),
    tv: Math.max(0, Number(u.tokenVersion) || 0),
    iat: now,
    exp,
  };
  const payload = b64url(JSON.stringify(claims));
  return { token: `${header}.${payload}.${hmac(`${header}.${payload}`)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** Verify signature AND expiry. The header's alg is IGNORED (no algorithm confusion). Null on any failure. */
export function verifySessionToken(token: any, nowMs = Date.now()): SessionClaims | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let expected: string;
  try { expected = hmac(`${h}.${p}`); } catch { return null; } // no secret — fail closed
  const a = Buffer.from(s); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: any;
  try { claims = JSON.parse(b64urlDecode(p).toString('utf8')); } catch { return null; }
  if (!claims || typeof claims.sub !== 'string' || !USERNAME_RE.test(claims.sub)) return null;
  if (!Number.isFinite(claims.exp) || claims.exp <= Math.floor(nowMs / 1000)) return null;
  return {
    sub: claims.sub,
    name: typeof claims.name === 'string' ? claims.name : claims.sub,
    role: normalizeRole(claims.role),
    tv: Math.max(0, Number(claims.tv) || 0),
    iat: Number(claims.iat) || 0,
    exp: claims.exp,
  };
}

/**
 * Pull OUR session token off a request. Header only — never the query string (it lands in logs).
 *
 * x-auth-token is read FIRST, and this is a decision recorded ahead of the need, NOT a benefit
 * already collected. Stating it the other way round would be reporting an intent as an
 * outcome, which this codebase has been bitten by before.
 *
 * THE INTENT. Two token systems reach this site. The Drivers panel
 * (src/components/DriversPanel.jsx:46) signs a dispatcher into LOAD-SCAN and sends that
 * FOREIGN token as `Authorization: Bearer …`; loadscan-admin.mts forwards the header untouched
 * to the other origin, which is what authorises the call there. If this function read
 * Authorization first, the day loadscan-admin is gated requireUser would find a token it
 * cannot verify and refuse UNCONDITIONALLY — a bad token is a 401 even in legacy mode
 * (require-user.mts) — so the Drivers panel would 401 on every call, before AUTH_REQUIRED was
 * ever flipped. Giving our own session its own header is the way both systems can ride one
 * request.
 *
 * WHAT IS ACTUALLY TRUE TODAY. Nothing sends x-auth-token. The client's one HTTP helper
 * (src/lib/api.js apiFetch) puts our session in `Authorization: Bearer …` like every other
 * caller, so this branch never fires and the precedence has no effect on any live request. The
 * ordering is here so that the conflict above is already resolved WHEN a client starts using
 * the header — and until one does, loadscan-admin.mts must not be gated with requireUser,
 * because the collision it describes is still real.
 *
 * Authorization works for every caller that carries no x-auth-token — which is, at present,
 * all of them: the app, curl, and the tests.
 */
export function bearerFromHeaders(headers: { get(name: string): string | null }): string | null {
  // Only a header that actually CARRIES a value takes precedence: an empty or blank
  // x-auth-token must not shadow a real Authorization token and turn a signed-in caller
  // into an anonymous one.
  const x = (headers.get('x-auth-token') || '').trim();
  if (x) return x;
  const m = /^Bearer\s+(.+)$/i.exec((headers.get('authorization') || '').trim());
  return m ? m[1].trim() : null;
}

// ── Reset tokens ─────────────────────────────────────────────────────────────

export const RESET_TTL_MINUTES = 30;

/** The plaintext goes in the email; only its SHA-256 is stored, so a Firestore read cannot be replayed. */
export function newResetToken(): { token: string; hash: string } {
  const token = b64url(randomBytes(32));
  return { token, hash: hashResetToken(token) };
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function resetTokenMatches(token: any, storedHash: any): boolean {
  if (typeof token !== 'string' || !token || typeof storedHash !== 'string' || !storedHash) return false;
  const a = Buffer.from(hashResetToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function resetExpired(expiresAt: any, nowMs = Date.now()): boolean {
  const t = expiresAt ? Date.parse(String(expiresAt)) : NaN;
  return !Number.isFinite(t) || t <= nowMs;
}

// ── Temporary passwords ──────────────────────────────────────────────────────

// No 0/O/1/l/I — these get read over the phone and typed on a dock at 5am.
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateTempPassword(len = 14): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += TEMP_ALPHABET[bytes[i] % TEMP_ALPHABET.length];
  return out;
}

// ── Secret comparison ────────────────────────────────────────────────────────

/** Constant-time string equality via digests (lengths never leak either). */
export function safeEqual(a: any, b: any): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}
