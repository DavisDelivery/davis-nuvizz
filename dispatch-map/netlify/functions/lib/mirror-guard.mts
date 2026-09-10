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
 * MAY THIS MIRROR SCAN ITS OWN TENANT? Default NO — and that default is the point.
 *
 * isMirrorDeploy() shut reads on every mirror (Chad, 2026-09-03: "I do not want uat running
 * scans cut it off", after the UAT site quietly spent 109 NuVizz calls in a day). Keying that
 * on FIRESTORE_DATABASE rather than on a flag means a NEW mirror is born silent instead of
 * scanning until somebody notices the bill, and that stays exactly true.
 *
 * But it also made the UAT site useless as a TEST board, and not obviously: writes are on
 * there (NUVIZZ_WRITE_ENABLED=true, the DAVISV5 tenant, its own uat-mirror database), so you
 * can send to NuVizz UAT all day — you just cannot SEE anything to send, because nothing may
 * index the tenant. A dispatcher cannot test building a route with no orders on the board.
 *
 * So a mirror may now be told, deliberately and per-deploy, to scan the tenant it is pointed
 * at. NUVIZZ_MIRROR_SCANS=on is the whole switch. Three properties make it safe:
 *   • PRODUCTION CANNOT READ IT. isMirrorDeploy() is false there (FIRESTORE_DATABASE unset),
 *     so the flag is inert on the production site no matter what anyone sets.
 *   • IT ONLY RE-OPENS THE MIRROR'S OWN TENANT. The mirror's NUVIZZ_BASE_URL is the UAT host;
 *     a scan it runs can only reach what that host holds.
 *   • THE P0 KILL SWITCH STILL WINS. NUVIZZ_SCANS_ENABLED=false is checked AFTER this and
 *     still shuts everything — the runaway brake must not be overridable by a convenience.
 */
export function mirrorScansAllowed(env: Record<string, any> = process.env): boolean {
  if (!isMirrorDeploy(env)) return false;
  return /^(1|true|on|yes)$/i.test(String(env.NUVIZZ_MIRROR_SCANS ?? '').trim());
}

/**
 * WHY scanning is off, in one word, or null when it is on. There are three different reasons
 * and the board showed the same blank screen for all of them — the UAT site reported
 * `scansEnabled: false` for a week with no way to tell "a mirror may not scan" from "somebody
 * pulled the kill switch". Same rule as every other diagnostic here: an unexplained refusal
 * costs more than the thing it refused.
 */
export function scanBlockReason(env: Record<string, any> = process.env): 'mirror' | 'kill-switch' | null {
  if (isMirrorDeploy(env) && !mirrorScansAllowed(env)) return 'mirror';
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
