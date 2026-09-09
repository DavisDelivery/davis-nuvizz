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

// ── NUVIZZ WRITES FROM THE TEST BOARD: CONFIRMED, ONE AT A TIME ──────────────
//
// Chad, asked whether UAT should be allowed to write to NuVizz so the cancel-route and
// New-route fixes can actually be exercised there: "Allow writes but make it where you
// have to confirm via box that this is what is about to occur."
//
// So the door opens, but only for a write a human has just looked at and agreed to. The
// per-request confirmation is the gate, not an env var, and that is the safe shape:
//
//   • A BACKGROUND JOB CANNOT SET IT. Every scheduled function, sweep and retry in this
//     repo calls the write path without it, so none of them can write NuVizz from a
//     mirror no matter what env it inherits. That is the failure this whole file was
//     written about — a mirror built by copying production's env, with every outbound
//     door keyed on nothing but the presence of a copied API key.
//   • IT CANNOT BE SET ONCE AND FORGOTTEN. It rides the request, so it is answered again
//     for the next write. An env var, once set, is on for every write that deploy ever
//     makes — which is exactly how a UAT site ends up dispatching a real truck.
//   • MIRROR_ALLOW_OUTBOUND STILL WORKS, unchanged, as the blanket hatch for a
//     non-interactive test that cannot show anybody a box.
//
// PRODUCTION IS UNTOUCHED: not a mirror → allowed, exactly as before, and the flag is
// never even read.

/**
 * PURE. May this deploy write NuVizz for THIS request?
 * @param confirmed  the operator confirmed this specific write in the UAT box.
 */
export function nuvizzWriteGate(confirmed: boolean, env: Record<string, any> = process.env): { allowed: boolean; reason: string | null } {
  if (!isMirrorDeploy(env)) return { allowed: true, reason: null };
  if (confirmed === true) return { allowed: true, reason: null };
  if (allowedOutbound(env).has('nuvizz-write')) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason: `refused: this is the ${firestoreDatabaseName(env)} test board, and a NuVizz write from here has to be confirmed. `
      + 'Re-run the action and confirm it in the box. '
      + `(A non-interactive caller can set MIRROR_ALLOW_OUTBOUND=nuvizz-write on this site instead.)`,
  };
}

/** PURE. Should the browser put a confirmation box in front of this write? True on a
 *  mirror; false on production, where the app's own confirms already apply. */
export function needsWriteConfirm(env: Record<string, any> = process.env): boolean {
  return isMirrorDeploy(env);
}

/** Convenience for a caller that wants both answers at once. */
export function outboundGate(channel: OutboundChannel, env: Record<string, any> = process.env): { allowed: boolean; reason: string | null } {
  return outboundAllowed(channel, env)
    ? { allowed: true, reason: null }
    : { allowed: false, reason: outboundRefusal(channel, env) };
}
