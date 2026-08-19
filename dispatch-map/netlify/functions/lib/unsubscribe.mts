// lib/unsubscribe.mts
//
// LET THE CUSTOMER STOP THE EMAILS THEMSELVES.
//
// Chad: a customer replied "unsubscribe" to a delivery confirmation today, and he went into
// the app and turned her emails off by hand. The suppression has existed and been honoured
// since v0.54.78 — customer_notes.comms_opt_out, checked in chooseRecipient — but only a
// DISPATCHER could set it. So every unsubscribe was a person reading a reply and remembering
// to act on it, which is the kind of task that works until the day it doesn't.
//
// ── THE TOKEN ────────────────────────────────────────────────────────────────
//
// The link identifies a customer by matchKey, and matchKey is DERIVED from name + street +
// city + zip — all public. Unsigned, anyone who knows a business's address could unsubscribe
// them, and the addresses are on the side of the trucks. So the link carries an HMAC over
// the key and the endpoint refuses anything that does not verify.
//
// No expiry, deliberately. A delivery confirmation may be read weeks later out of an
// archive, and an unsubscribe link that has quietly gone stale is worse than none: the
// customer clicks, nothing happens, and they mark the next one as spam instead.
//
// ── WHAT IS SIGNED, AND WHAT IS NOT ──────────────────────────────────────────
//
// Only the matchKey is signed. The email address travels UNSIGNED and is recorded purely as
// provenance ("this arrived from an email we sent to X") — nothing is decided from it, so
// forging it buys an attacker a wrong note on a record they could already have suppressed.
//
// PURE except where noted. ZERO NuVizz calls.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const UNSUB_PATH = '/unsubscribe';

/**
 * The signing key.
 *
 * COMMS_UNSUB_SECRET when set; otherwise COMMS_ADMIN_TOKEN, which is already a server-only
 * secret on this site — so the feature works without new configuration and can be rotated
 * independently later.
 *
 * Returns null when NEITHER is set, and every caller treats that as "cannot mint, cannot
 * verify". That is the important part: falling back to a constant would produce tokens that
 * verify for everyone, which is the same as having no signature while looking like it has
 * one. A missing secret must break loudly, not silently.
 */
export function unsubSecrets(env: any = process.env): { sign: string | null; accept: string[] } {
  const pick = (v: any) => { const t = String(v || '').trim(); return t.length >= 8 ? t : null; };
  const dedicated = pick(env?.COMMS_UNSUB_SECRET);
  const legacy = pick(env?.COMMS_ADMIN_TOKEN);
  const prev = pick(env?.COMMS_UNSUB_SECRET_PREV);
  const sign = dedicated || legacy;
  // A KEY RING, and it has to exist from the first release. Links live in inboxes forever —
  // a delivery confirmation gets dug out of an archive months later — so the day the secret
  // is rotated, every link already sent starts answering "this link is not valid". A
  // customer who clicks unsubscribe and gets an error does not email us about it; they mark
  // the next one as spam. Retro-fitting this after the first rotation is impossible, because
  // by then the old signatures are unverifiable.
  const accept = [sign, prev, dedicated ? legacy : null].filter(Boolean) as string[];
  return { sign, accept: [...new Set(accept)] };
}

export function unsubSecret(env: any = process.env): string | null {
  return unsubSecrets(env).sign;
}

/**
 * Can this site actually mint a working unsubscribe link?
 *
 * SURFACED, not assumed. With no secret the footer silently degrades to "reply to this
 * email" — which is honest, but it is also indistinguishable from the feature working, and
 * a delivery program sending hundreds a day would go on with no unsubscribe and nobody the
 * wiser. That is the exact shape of failure this codebase keeps producing, so the answer is
 * reported on the Communications screen instead of being hoped for.
 */
export function unsubscribeReady(env: any = process.env): boolean {
  return !!unsubSecrets(env).sign;
}

/**
 * A matchKey is used to build a Firestore document path. normalizeMatchKey only ever emits
 * word characters, so anything else is either corruption or an attempt to walk out of the
 * collection — `customer_notes/../../something`. The signature already gates it; this is the
 * second lock, because a path built by string interpolation should never be able to leave.
 */
export function validKeyShape(k: any): boolean {
  return /^[A-Za-z0-9_]{1,300}$/.test(String(k ?? ''));
}

/** 16 bytes of HMAC-SHA256, hex. Short enough for a tidy URL, far past guessing. */
export function signKey(matchKey: string, secret: string): string {
  return createHmac('sha256', secret).update(`unsub:v1:${matchKey}`).digest('hex').slice(0, 32);
}

/** Constant-time compare, so the endpoint cannot be used as an oracle a byte at a time. */
export function verifyToken(matchKey: string, token: string, secrets: string | string[] | null): boolean {
  const ring = Array.isArray(secrets) ? secrets : (secrets ? [secrets] : []);
  if (!ring.length) return false;
  const got = Buffer.from(String(token || ''), 'utf8');
  let ok = false;
  for (const secret of ring) {
    const want = Buffer.from(signKey(String(matchKey || ''), secret), 'utf8');
    // Every candidate is compared, and the loop does not break early — an attacker must not
    // be able to learn WHICH key matched from how long the answer took.
    if (want.length === got.length) {
      try { if (timingSafeEqual(want, got)) ok = true; } catch { /* not this one */ }
    }
  }
  return ok;
}

// ── THE UNDO IS NOT THE SAME PERMISSION ──────────────────────────────────────
//
// The confirmation page offers "put me back on the list", and an earlier draft accepted the
// SAME token for it. That is an escalation in the direction that actually matters: anyone
// holding an unsubscribe URL — a forwarded copy, a mail gateway's log, a link scanner —
// could RE-SUBSCRIBE a customer who had asked to be left alone, and Davis would go on
// mailing somebody who opted out. Undoing an opt-out needs its own permission.
//
// So the undo token is scoped to the moment of opting out and expires. It is minted only on
// the page shown immediately after unsubscribing, which is the only context where "I just
// did that by mistake" is a real thing to say.
export const UNDO_TTL_MS = 30 * 60 * 1000;

export function signUndo(matchKey: string, atMs: number, secret: string): string {
  return createHmac('sha256', secret).update(`unsub:undo:v1:${matchKey}:${atMs}`).digest('hex').slice(0, 32);
}

export function verifyUndo(
  matchKey: string, atMs: number, token: string, secrets: string | string[] | null, nowMs: number,
): boolean {
  const ring = Array.isArray(secrets) ? secrets : (secrets ? [secrets] : []);
  if (!ring.length || !Number.isFinite(atMs)) return false;
  if (nowMs - atMs > UNDO_TTL_MS || atMs - nowMs > 60_000) return false;   // expired, or minted in the future
  const got = Buffer.from(String(token || ''), 'utf8');
  let ok = false;
  for (const secret of ring) {
    const want = Buffer.from(signUndo(String(matchKey || ''), atMs, secret), 'utf8');
    if (want.length === got.length) {
      try { if (timingSafeEqual(want, got)) ok = true; } catch { /* not this one */ }
    }
  }
  return ok;
}

/** The link that goes in the email. Absolute — an inbox has no page to be relative to. */
export function unsubscribeUrl(matchKey: string, origin: string, secret: string | null): string {
  const key = String(matchKey || '').trim();
  if (!key || !secret) return '';
  const base = String(origin || '').replace(/\/+$/, '');
  const qs = new URLSearchParams({ k: key, t: signKey(key, secret) });
  return `${base}${UNSUB_PATH}?${qs.toString()}`;
}

// ── THE RECORD ───────────────────────────────────────────────────────────────
//
// Written with a FIELD-MASKED patch (updateDocFields), never a whole-document write.
// customer_notes carries dispatcher-authored receiving hours that the flag engine reads, and
// setDoc in this repo replaces rather than merges — a blind write of this flag would take
// those hours with it and silently stop flagging that customer for good.
export type OptOutSource = 'customer' | 'dispatcher';

export function optOutPatch(o: {
  source: OptOutSource; at: string; email?: string | null; via?: string | null;
}): Record<string, any> {
  return {
    comms_opt_out: true,
    comms_opt_out_at: o.at,
    // WHO turned it off is the difference between "the customer asked us to stop" and "we
    // decided not to email them". Chad needs to tell those apart on the list, and only one
    // of them is a thing he may quietly undo.
    comms_opt_out_source: o.source,
    ...(o.email ? { comms_opt_out_email: String(o.email).slice(0, 200) } : {}),
    ...(o.via ? { comms_opt_out_via: String(o.via).slice(0, 40) } : {}),
  };
}

/** Undo — the confirmation page offers it, because a mis-click must not be permanent. */
export function optInPatch(at: string): Record<string, any> {
  return {
    comms_opt_out: false,
    comms_opt_out_at: null,
    comms_opt_out_source: null,
    comms_opt_out_email: null,
    comms_opt_out_via: null,
    comms_opt_in_at: at,
  };
}

/** PURE. One row for the "who has unsubscribed" list. */
export function optOutRow(doc: any) {
  return {
    matchKey: String(doc?._id || doc?.matchKey || ''),
    customer: String(doc?.raw_name || doc?.name || '') || null,
    email: doc?.comms_opt_out_email || doc?.comms_email || null,
    at: doc?.comms_opt_out_at || null,
    // A record with the flag but no provenance predates this feature — it was set by hand
    // from the notes editor, which wrote no source. Reported as 'dispatcher (before
    // tracking)' rather than guessed at, so the list never invents a customer request.
    source: doc?.comms_opt_out_source || null,
    via: doc?.comms_opt_out_via || null,
  };
}

/** PURE. Sort newest-first, undated last — they are the pre-tracking ones. */
export function sortOptOuts(rows: any[]): any[] {
  return [...(rows || [])].sort((a, b) => {
    if (!a.at && !b.at) return String(a.customer || '').localeCompare(String(b.customer || ''));
    if (!a.at) return 1;
    if (!b.at) return -1;
    return String(b.at).localeCompare(String(a.at));
  });
}
