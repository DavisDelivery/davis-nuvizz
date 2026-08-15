// lib/gmail-store.mts
//
// WHERE THE GMAIL GRANT LIVES, AND WHY IT IS ENCRYPTED.
//
// A refresh token is a standing key to a mailbox. This app's Firestore is read
// by an unauthenticated browser client (see src/lib/firebase.js — there is no
// login, and the rules are permissive), so a refresh token written as plain
// text into a doc would be a mailbox key published on the internet. It is
// therefore sealed with AES-256-GCM before it is ever handed to Firestore: a
// reader who can list every document gets ciphertext and nothing else.
//
// The key is server-only:
//   • GMAIL_TOKEN_KEY when set (any passphrase — rotate it to invalidate every
//     stored grant at once), otherwise
//   • derived from the FIREBASE_SA private key, so this works with no new
//     configuration. Rotating the service account therefore also invalidates
//     the stored grant, and Chad simply reconnects.
//
// Two documents, deliberately split:
//   nuvizz_secrets/gmail   the sealed refresh token. Nothing reads it but the server.
//   nuvizz_ops/gmail_status  connected? which address? last poll? NO SECRETS —
//                            this is the half that is safe for anyone to read.

import crypto from 'node:crypto';
import { getDoc, setDoc, deleteDoc } from './firestore.mts';

export const GMAIL_SECRET_DOC = 'nuvizz_secrets/gmail';
export const GMAIL_STATUS_DOC = 'nuvizz_ops/gmail_status';
export const GMAIL_STATE_DOC = 'nuvizz_ops/gmail_oauth_state';

/** An OAuth state older than this is dead. Ten minutes is longer than any real
 *  consent screen and short enough that a leaked link is useless by the time it
 *  is found. */
export const STATE_TTL_MS = 10 * 60 * 1000;

// ── sealing ──────────────────────────────────────────────────────────────────

/** PURE — exported so a test can prove a sealed token round-trips and that a
 *  tampered blob is rejected rather than silently half-decrypted. */
export function sealSecret(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (b: Buffer) => b.toString('base64url');
  return `v1.${b64(iv)}.${b64(tag)}.${b64(ct)}`;
}

/** Returns null for anything that is not a well-formed, authentic v1 blob. GCM
 *  authenticates, so a single flipped byte fails here instead of yielding a
 *  corrupted token that would look like a Google-side auth error. */
export function openSecret(blob: any, key: Buffer): string | null {
  const parts = String(blob ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const [, ivB, tagB, ctB] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return null; }
}

/** 32 bytes of key material from server-only secrets. Throws when there is
 *  none — callers treat that as "Gmail is not available here", never as
 *  "store it in the clear". */
export function tokenKey(): Buffer {
  const explicit = String(process.env.GMAIL_TOKEN_KEY || '').trim();
  if (explicit) return crypto.createHash('sha256').update(`dd-gmail|${explicit}`).digest();
  const raw = process.env.FIREBASE_SA;
  if (!raw) throw new Error('no key material: set GMAIL_TOKEN_KEY or FIREBASE_SA');
  let priv = '';
  try { priv = String(JSON.parse(raw)?.private_key ?? ''); } catch { /* fall through */ }
  if (!priv) throw new Error('FIREBASE_SA has no private_key — set GMAIL_TOKEN_KEY');
  return crypto.createHash('sha256').update(`dd-gmail|${priv}`).digest();
}

// ── the grant ────────────────────────────────────────────────────────────────

export interface GmailGrant {
  refreshToken: string;
  email: string;
  scope: string;
  connectedAt: string;
}

export async function saveGrant(grant: GmailGrant, query: string): Promise<void> {
  await setDoc(GMAIL_SECRET_DOC, {
    sealed: sealSecret(grant.refreshToken, tokenKey()),
    email: grant.email,
    scope: grant.scope,
    connectedAt: grant.connectedAt,
  });
  await setDoc(GMAIL_STATUS_DOC, {
    connected: true,
    email: grant.email,
    scope: grant.scope,
    connectedAt: grant.connectedAt,
    query,
    lastRunAt: null,
    lastRunSummary: null,
  });
}

/** The usable grant, or null when there is none / it cannot be opened. An
 *  unopenable blob means the key rotated: report it as disconnected so the tab
 *  offers Connect rather than failing every poll forever. */
export async function loadGrant(): Promise<GmailGrant | null> {
  const doc = await getDoc(GMAIL_SECRET_DOC).catch(() => null);
  if (!doc?.sealed) return null;
  let refreshToken: string | null = null;
  try { refreshToken = openSecret(doc.sealed, tokenKey()); } catch { refreshToken = null; }
  if (!refreshToken) return null;
  return {
    refreshToken,
    email: String(doc.email ?? ''),
    scope: String(doc.scope ?? ''),
    connectedAt: String(doc.connectedAt ?? ''),
  };
}

/** Secret-free. Safe to hand to any caller. */
export async function readStatus(): Promise<any> {
  return (await getDoc(GMAIL_STATUS_DOC).catch(() => null)) || null;
}

export async function patchStatus(patch: Record<string, any>): Promise<void> {
  const cur = (await getDoc(GMAIL_STATUS_DOC).catch(() => null)) || {};
  const { _id, ...rest } = cur as any;
  await setDoc(GMAIL_STATUS_DOC, { ...rest, ...patch });
}

export async function clearGrant(): Promise<void> {
  await deleteDoc(GMAIL_SECRET_DOC).catch(() => {});
  // The status doc is kept but emptied, so the tab can say "not connected"
  // rather than showing nothing at all after a disconnect.
  await setDoc(GMAIL_STATUS_DOC, {
    connected: false, email: null, scope: null, connectedAt: null,
    query: null, lastRunAt: null, lastRunSummary: null,
    disconnectedAt: new Date().toISOString(),
  }).catch(() => {});
}

// ── OAuth state (CSRF) ───────────────────────────────────────────────────────

export async function issueState(nowISO: string): Promise<string> {
  const state = crypto.randomBytes(24).toString('base64url');
  await setDoc(GMAIL_STATE_DOC, { state, at: nowISO });
  return state;
}

/** PURE — the whole decision, so the expiry and the mismatch case are testable
 *  without Firestore. Never throws: `presented` is whatever a stranger put in the
 *  query string, and timingSafeEqual throws on a length mismatch — which a
 *  multi-byte string of the same JS length would produce even after the length
 *  check. Compare BYTES, and treat any failure as "no". */
export function stateValid(stored: any, presented: any, nowMs: number): boolean {
  try {
    const want = Buffer.from(String(stored?.state ?? ''), 'utf8');
    const got = Buffer.from(String(presented ?? ''), 'utf8');
    if (!want.length || want.length !== got.length) return false;
    if (!crypto.timingSafeEqual(want, got)) return false;
    const at = Date.parse(String(stored?.at ?? ''));
    if (!Number.isFinite(at)) return false;
    return nowMs - at <= STATE_TTL_MS;
  } catch { return false; }
}

export async function consumeState(presented: string, nowMs: number): Promise<boolean> {
  const stored = await getDoc(GMAIL_STATE_DOC).catch(() => null);
  const ok = stateValid(stored, presented, nowMs);
  // One-shot either way: a replayed or expired state must not stay usable.
  await deleteDoc(GMAIL_STATE_DOC).catch(() => {});
  return ok;
}
