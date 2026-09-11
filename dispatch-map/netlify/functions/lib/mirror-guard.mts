// lib/mirror-guard.mts
//
// A MIRROR DEPLOY MAY NOT REACH THE OUTSIDE WORLD.
//
// Chad: "nothing we do in UAT writes to the production version of the site."
//
// The repo already had the right primitive and used it for exactly one thing. isMirrorDeploy()
// (nuvizz-scan.mts, v0.90.0) keys on FIRESTORE_DATABASE — the one variable that is always true
// of a mirror and never true of production — and its own comment says why that is the right
// key: "a deploy writing to a NAMED database is by definition not the production board, and has
// no business generating vendor traffic... a new mirror is born silent instead of scanning
// until somebody notices the bill."
//
// That reasoning was applied to READS and stopped there. Every OUTBOUND door was left keyed on
// nothing but the presence of an API key, and a mirror is built by COPYING production's env:
//
//   emailEnabled()  = RESEND_API_KEY && RESEND_FROM        → true on a mirror
//   smsEnabled()    = SIMPLETEXTING_API_KEY                 → true on a mirror
//   writeEnabled()  = NUVIZZ_WRITE_ENABLED === 'true'       → true on a mirror
//
// So a UAT deploy could email a real customer about a real delivery, text a real driver from
// the real Davis number, and assign or dispatch a real load in production NuVizz — which sends
// a truck. Worse than a single duplicate: each deploy keeps its dedup ledger in its OWN
// Firestore database while sharing ONE Resend account, so the two ledgers do not compose and
// the same customer can be mailed once by each site.
//
// The rule here is the same one, finished: a mirror is born SILENT — no vendor calls, no mail,
// no texts, no writes — and that is the default, not a variable somebody has to remember.
//
// THE ESCAPE HATCH IS PER-CHANNEL AND EXPLICIT. Testing the mailer on UAT is a real need, and
// a guard with no way through gets removed rather than configured. MIRROR_ALLOW_OUTBOUND takes
// a comma-separated list ('email', 'sms', 'nuvizz-write', or 'all'). Anything opened this way
// is opened on purpose, by name, in one place a reviewer can read.
//
// PRODUCTION IS UNTOUCHED. FIRESTORE_DATABASE unset → not a mirror → every gate answers exactly
// as it did before this file existed.

/** The named Firestore database this deploy writes, or '(default)' for production. */
export function firestoreDatabaseName(env: Record<string, any> = process.env): string {
  return String(env.FIRESTORE_DATABASE || '').trim() || '(default)';
}

/**
 * Is this a mirror (UAT) deploy? Keyed on FIRESTORE_DATABASE — see the header for why that is
 * the only marker that cannot be forgotten into the dangerous direction.
 */
export function isMirrorDeploy(env: Record<string, any> = process.env): boolean {
  return firestoreDatabaseName(env) !== '(default)';
}

/**
 * WHY scanning is off, in one word, or null when it is on.
 *
 * A MIRROR NEVER SCANS, and that is settled (Chad, 2026-09-03: "I do not want uat running
 * scans cut it off", after the UAT site quietly spent 109 NuVizz calls in a day; and again
 * 2026-09-10: "we need to use firestore to see what data/orders are put into system daily so
 * we are not running scans"). isMirrorDeploy() keys on FIRESTORE_DATABASE rather than on a
 * flag precisely so a NEW mirror is born silent instead of scanning until somebody notices
 * the bill. Nothing here re-opens that; the UAT board gets its day from production's
 * Firestore (lib/prod-pool.mts) and its orders from a deliberate seed, not from discovery.
 *
 * What this adds is only the REASON. Three different things can shut scanning and the board
 * showed the same blank screen for all of them — the UAT site read `scansEnabled: false` for
 * a week with no way to tell "a mirror may not scan" from "somebody pulled the kill switch".
 * An unexplained refusal costs more than the thing it refused.
 */
export function scanBlockReason(env: Record<string, any> = process.env): 'mirror' | 'kill-switch' | null {
  if (isMirrorDeploy(env)) return 'mirror';
  if (String(env.NUVIZZ_SCANS_ENABLED ?? '').trim().toLowerCase() === 'false') return 'kill-switch';
  return null;
}

/** The doors that lead out of the building. */
export type OutboundChannel = 'email' | 'sms' | 'nuvizz-write';
export const OUTBOUND_CHANNELS: OutboundChannel[] = ['email', 'sms', 'nuvizz-write'];

const LABEL: Record<OutboundChannel, string> = {
  email: 'email',
  sms: 'SMS',
  'nuvizz-write': 'NuVizz writes',
};

/**
 * PURE. Which channels this deploy has been explicitly allowed to use despite being a mirror.
 * Unknown names are ignored rather than throwing — a typo must fail CLOSED (the channel stays
 * shut), never open.
 */
export function allowedOutbound(env: Record<string, any> = process.env): Set<OutboundChannel> {
  const raw = String(env.MIRROR_ALLOW_OUTBOUND || '').trim().toLowerCase();
  if (!raw) return new Set();
  if (raw === 'all') return new Set(OUTBOUND_CHANNELS);
  const out = new Set<OutboundChannel>();
  for (const part of raw.split(',')) {
    const k = part.trim() as OutboundChannel;
    if (OUTBOUND_CHANNELS.includes(k)) out.add(k);
  }
  return out;
}

/**
 * PURE. May this deploy use `channel`? Production: always yes. A mirror: only when named in
 * MIRROR_ALLOW_OUTBOUND.
 */
export function outboundAllowed(channel: OutboundChannel, env: Record<string, any> = process.env): boolean {
  if (!isMirrorDeploy(env)) return true;
  return allowedOutbound(env).has(channel);
}

/**
 * PURE. The sentence a refused channel returns. It names the deploy, the channel and the way
 * through, because a silent no-op is indistinguishable from a broken feature — which is the
 * failure this whole file is modelled on (a UAT scan that nobody had switched off, running
 * 109 calls a day while the kill switch read `{env: false, config: false}`).
 */
export function outboundRefusal(channel: OutboundChannel, env: Record<string, any> = process.env): string {
  return `refused: this is the ${firestoreDatabaseName(env)} mirror deploy, which does not send ${LABEL[channel]}. `
    + `Set MIRROR_ALLOW_OUTBOUND=${channel} on this site to allow it deliberately.`;
}

/** Convenience for a caller that wants both answers at once. */
export function outboundGate(channel: OutboundChannel, env: Record<string, any> = process.env): { allowed: boolean; reason: string | null } {
  return outboundAllowed(channel, env)
    ? { allowed: true, reason: null }
    : { allowed: false, reason: outboundRefusal(channel, env) };
}
