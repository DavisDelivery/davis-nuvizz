// lib/alert-recipients.mts
//
// WHO GETS TEXTED AND WHO GETS EMAILED — AS A THING CHAD CAN READ AND CHANGE.
//
// Chad, 2026-09-09: "We are sending texts alerts for different things and i think we need to
// build a ui in the diagnostics where i can add more numbers or remove numbers from who gets
// texted same thing for emails need to build a ui in same place so can control that as well."
//
// WHAT IT WAS BEFORE THIS FILE. Five recipient lists, all environment variables, none of them
// visible from the app and none of them editable without a trip to the Netlify console and a
// redeploy:
//
//   FLAG_SMS_TO        the evening/overnight flag text        lib/flag-sms.mts:69
//   FLAG_SMS_TO_NIGHT  the router on duty, until 6:00a sharp  lib/flag-sms.mts:70
//   ALERT_CC           the miss-window email, beside CS       lib/flag-alert.mts:140
//   NOTIFY_CS_TO       the marked-customer notice             lib/cs-notify.mts:45
//   DAY_REPORT_TO      the 6:30p end-of-day report            day-completion-report-background.mts:55
//
// THIS IS THE SAME DEFECT THAT COST AN EVENING IN SEPTEMBER, ONE LAYER DOWN. On 2026-09-03
// Chad said he had not received either miss-window email. Nothing was broken: both had been
// delivered, and he was simply not on the list. lib/flag-alert.mts records the lesson — "the
// mailer is broken" and "you are not on the list" are indistinguishable from an inbox, and
// only one of them is a bug anyone can see. The fix that day made the list CONFIGURABLE. It
// did not make it READABLE, and it did not make it changeable by the person who owns it. A
// recipient list nobody can see is the same class of problem as a switch whose position
// cannot be read, and this repo already has a rule about those.
//
// SO THE RULE HERE IS: THE SCREEN PRINTS THE LIST THE SENDER WILL ACTUALLY USE. Not the
// stored list, not the env var — the resolved, validated, floor-applied list, per channel,
// including the addresses nobody can remove. Anything the screen cannot show, the sender must
// not use.
//
// ── FOUR DECISIONS, EACH WITH A BAD MORNING BEHIND IT ────────────────────────────────
//
// 1. A SAVED LIST WINS VERBATIM — INCLUDING AN EMPTY ONE. If Chad deletes every number from
//    the flag texts, the flag texts stop. That is the whole point of the screen; a control
//    that quietly reverts to an env var when emptied is a control that lies. The distinction
//    is between "never set" (fall back to the environment, exactly as before this existed)
//    and "set to nothing" (send to nobody). Firestore can hold both: an absent key and an
//    empty array are different documents.
//
// 2. EXCEPT WHERE EMPTY WOULD SILENTLY DISABLE SOMEBODY ELSE'S FEATURE. The marked-customer
//    notice is addressed TO customer service — emptying it does not mean "stop telling CS",
//    it means somebody cleared a box. That channel keeps a floor, exactly as csRecipients()
//    always has. The miss-window email keeps customer service on the TO line for the same
//    reason: they are the desk that phones the consignee, and this list is who WATCHES.
//    Every floor is printed on the screen next to the list it applies to, so no channel
//    behaves in a way the screen does not say out loud.
//
// 3. NOTHING IS DROPPED IN SILENCE, EVER. A refused entry comes back BY NAME with a reason.
//    A recipient who quietly disappears recreates the precise failure this whole area exists
//    to end: someone who believes they are on the list and never gets mail. This applies to
//    what Chad types AND to what the environment already holds — an ALERT_CC entry the
//    allowlist refuses is named on the screen rather than being invisible.
//
// 4. THE SCREEN VALIDATES WHAT THE SENDER VALIDATES. Phone numbers go through the SAME
//    normalizePhone/validUsPhone that lib/sms.mts hands SimpleTexting, so a number the field
//    accepts is a number the transport can dial. A second, looser copy of that rule in the UI
//    is how you get a saved recipient that fails at 9pm with nobody watching.
//
// ── THE EMAIL ALLOWLIST, AND WHY IT NOW COVERS EVERY EMAIL CHANNEL ───────────────────
//
// ALERT_CC has refused non-internal addresses since 2026-09-03, for a stated reason: the
// message names a customer, its PRO, its route, and the fact that Davis is about to miss
// their window. NOTIFY_CS_TO and DAY_REPORT_TO carry the same class of content and had no
// allowlist at all — a typo there puts a customer's freight in a stranger's inbox.
//
// So the allowlist binds EVERYTHING THIS SCREEN STORES, on write and again on read. What it
// deliberately does NOT do is reach back and re-judge a value already sitting in the Netlify
// console. NOTIFY_CS_TO and DAY_REPORT_TO have never validated anything, and quietly enforcing
// a rule over them would stop mailing somebody who is being mailed today — a change nobody
// asked for, discovered by whoever stops getting the report. Those addresses stay live and are
// FLAGGED on the screen instead (`envWarned`), which puts the decision in front of the person
// whose decision it is. ALERT_CC is the exception that proves it: it has enforced the
// allowlist since 2026-09-03, so enforcing it here changes nothing at all.
//
// The narrow promise, which the tests pin: with nothing saved, every channel alerts exactly
// who it alerted before this file existed.
//
// PURE. No I/O, no Firestore, no clock. The endpoint and the senders are the thin edges.
import { normalizePhone, validUsPhone } from './sms.mts';
import { ALERT_TO, ALERT_INTERNAL_SUFFIXES } from './flag-alert.mts';

/** The company customer-service desk. The floor under two channels, removable from neither. */
export const COMPANY_CS_ADDRESS = ALERT_TO;

/** Internal domains, shared with the miss-window email so the two can never drift apart. */
export { ALERT_INTERNAL_SUFFIXES };

/**
 * A CEILING ON LIST LENGTH, WHICH IS NOT A POLICY ABOUT HOW MANY PEOPLE MAY CARE.
 *
 * The evening sweep sends one SimpleTexting call PER RECIPIENT per row, under a per-sweep cap
 * of 8 rows — so a 25-name list is up to 200 texts a night from one job. The number is high
 * enough that no real list reaches it and low enough that a pasted spreadsheet column cannot
 * quietly become a bill. A list at the ceiling is refused loudly, not truncated.
 */
export const MAX_PER_CHANNEL = 25;

const EMAILISH = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * PURE. Strip an RFC 5322 display name: `Davis Dispatch <ops@…>` → `ops@…`.
 *
 * WHY THIS EXISTS, AND IT IS NOT TIDINESS. NOTIFY_CS_TO and DAY_REPORT_TO have never validated
 * anything — whatever the console holds went to Resend verbatim — and Resend accepts the
 * `Name <address>` form. This repo uses that exact shape itself for RESEND_FROM. So if either
 * variable is set that way today, refusing it here would stop mailing somebody who is being
 * mailed right now: the marked-customer notice would fall to the customer-service floor and
 * the 6:30p report would reach NOBODY, reported only as "nobody is on the list".
 *
 * That is precisely the silent break this change promises not to cause, and it is not worth
 * leaving to a question about what is in the console — unwrapping costs one regex and makes
 * the answer the same either way. The mailbox is what identifies a recipient; the display name
 * is decoration, and dropping it changes nothing about who receives the message.
 */
export function stripDisplayName(raw: string): string {
  const m = /^[^<>]*<\s*([^<>\s]+)\s*>$/.exec(String(raw ?? '').trim());
  return m ? m[1] : String(raw ?? '').trim();
}

/**
 * THE ONE SEPARATOR RULE, because there were four.
 *
 * parseAlertCc split on comma/semicolon/newline; flag-sms, cs-notify and the comms test
 * allowlist each split on comma alone. The same paste therefore worked in one env var and
 * produced one garbage recipient in another, with no diagnostic either way. Everything this
 * module reads — a typed field, a pasted block, an env var — goes through this.
 */
export const splitEntries = (raw: unknown): string[] =>
  String(raw ?? '')
    .split(/[,;\n\r\t]/)
    .map((s) => s.trim())
    .filter(Boolean);

export type ChannelKind = 'sms' | 'email';

export interface ChannelSpec {
  key: string;
  kind: ChannelKind;
  envVar: string;
  label: string;
  /** When this channel actually fires, in words a dispatcher would use. */
  when: string;
  /** An address on every message regardless of this list — the TO line, not a member of it. */
  alwaysAlso: string | null;
  /** Used when the resolved list is empty, so the channel cannot be switched off by accident. */
  floorWhenEmpty: string | null;
  /** What actually happens when the list resolves to nothing. Printed on the screen. */
  emptyNote: string;
  /** A truth about this channel a person editing it would otherwise get wrong. Optional. */
  note?: string;
  /**
   * What to call the resolved send list on screen, when "Goes to" would state a falsehood.
   *
   * The overnight list is ADDED to the standing list and only between 7:00p and 5:59a, so a
   * card headed "Goes to" is wrong twice over at 10am: it names people who will not be texted,
   * and it omits the union that actually fires at 9pm. "Goes to" is the line a dispatcher
   * reads; the prose above it is not.
   */
  goesToLabel?: string;
  /**
   * Does the ENVIRONMENT fallback for this channel enforce the internal-domain allowlist?
   *
   * TRUE ONLY WHERE IT ALREADY DID. ALERT_CC has refused outside addresses since 2026-09-03
   * (lib/flag-alert.mts parseAlertCc), so enforcing it here changes nothing. NOTIFY_CS_TO and
   * DAY_REPORT_TO never validated anything, and turning the allowlist on over a value already
   * sitting in the Netlify console would silently stop mailing somebody who is being mailed
   * today — a change nobody asked for, discovered by whoever stops getting the report. They
   * are flagged on the screen instead, and the allowlist binds everything SAVED through it.
   *
   * The narrow promise this keeps: with nothing saved, every channel alerts exactly who it
   * alerted before this file existed.
   */
  envEnforcesAllowlist: boolean;
}

/**
 * THE FIVE LISTS, IN THE ORDER A DISPATCHER WOULD ASK ABOUT THEM: phones first, because a
 * text reaches somebody who is not at a desk, and that is the one Chad asked about first.
 *
 * `when` is not decoration. A recipient list is only judgeable against the thing that fires
 * it — "am I on the 9pm one or the 6:30pm one?" is the actual question, and a screen that
 * lists five boxes of addresses without answering it is a screen nobody can use.
 */
export const RECIPIENT_CHANNELS: ChannelSpec[] = [
  {
    key: 'flagSmsTo',
    kind: 'sms',
    envVar: 'FLAG_SMS_TO',
    label: 'Flag texts',
    when: 'Every evening and overnight sweep, 8:00p–7:00a ET, when a stop looks like it will miss its window or is on the wrong truck.',
    alwaysAlso: null,
    floorWhenEmpty: null,
    emptyNote: 'Nobody is texted. The sweep still runs and still records what it found — you just will not hear about it that night.',
    note: 'One text per person, per flagged stop — up to 8 a sweep. A four-name list is four texts for every problem found.',
    envEnforcesAllowlist: true,
  },
  {
    key: 'flagSmsToNight',
    kind: 'sms',
    envVar: 'FLAG_SMS_TO_NIGHT',
    label: 'Flag texts — the router on duty',
    when: 'Added to the list above from 7:00p ET, and dropped at 6:00a ET sharp. For whoever is building tomorrow’s loads tonight.',
    alwaysAlso: null,
    floorWhenEmpty: null,
    emptyNote: 'Nobody extra overnight. The list above is still texted.',
    goesToLabel: 'Also texted, 7:00p–5:59a only',
    envEnforcesAllowlist: true,
  },
  {
    key: 'alertCc',
    kind: 'email',
    envVar: 'ALERT_CC',
    label: 'Miss-window email',
    when: 'Weekdays 7:00a–8:00p ET, the first time a stop goes critical — one email per stop per day.',
    alwaysAlso: COMPANY_CS_ADDRESS,
    floorWhenEmpty: null,
    emptyNote: 'Customer service alone, which is how this alert worked before anyone else was added.',
    // NAMED HONESTLY, BECAUSE THE ENV VAR IS NOT. It is called ALERT_CC and there is no CC:
    // lib/email.mts sends Resend a `to` array and nothing else — no cc field, no bcc field —
    // so every address here lands on one visible To: line beside customer service. Harmless
    // (everyone on it is Davis staff) but worth saying on the screen, because a field labelled
    // CC would be naming a header that does not exist, and somebody would eventually rely on
    // it. The operational rule it was meant to carry — customer service ACTS, everyone else
    // WATCHES — lives in the wording of the alert, not in a header.
    note: 'Everyone here is emailed on the same visible To: line as customer service. Customer service is the desk that phones the consignee; everyone else is watching, not working it.',
    envEnforcesAllowlist: true,     // ALERT_CC already did — parseAlertCc, since 2026-09-03
  },
  {
    key: 'notifyCsTo',
    kind: 'email',
    envVar: 'NOTIFY_CS_TO',
    label: 'Marked-customer notice',
    when: 'Whenever a customer marked “email customer service” turns up on a board, within minutes of the scan finding it.',
    alwaysAlso: null,
    floorWhenEmpty: COMPANY_CS_ADDRESS,
    emptyNote: 'Falls back to customer service. This notice is addressed TO the desk that acts on it, so it cannot be emptied into silence.',
    envEnforcesAllowlist: false,    // NOTIFY_CS_TO never validated; flag it, do not silence it
  },
  {
    key: 'dayReportTo',
    kind: 'email',
    envVar: 'DAY_REPORT_TO',
    label: 'End-of-day report',
    when: '6:30p ET every day — what got delivered, what did not, and what is carrying over.',
    alwaysAlso: null,
    floorWhenEmpty: null,
    emptyNote: 'The report is still built and stored; nobody is mailed a copy.',
    envEnforcesAllowlist: false,    // DAY_REPORT_TO never validated; same reasoning
  },
];

export const CHANNEL_KEYS = RECIPIENT_CHANNELS.map((c) => c.key);

export const channelSpec = (key: string): ChannelSpec | null =>
  RECIPIENT_CHANNELS.find((c) => c.key === key) ?? null;

export interface Refusal { value: string; reason: string }

/**
 * PURE. Is this an address this system may send an internal alert to?
 *
 * The suffixes carry their own '@' on purpose. Against a BARE domain, endsWith() also accepts
 * a longer domain that merely ends with ours (prefix a hyphen and a word onto it) and ours
 * used as a subdomain of somebody else's (suffix a dot and another domain onto it) — two
 * strangers' mailboxes. lib/flag-alert.mts's tests pin both shapes; they are not written out
 * here because a company-domain address in source is a byte Netlify's secrets scan can read as
 * an env-var value and fail the deploy on (test/no-lifelike-addresses.test.mjs).
 */
export function internalEmail(addr: string): boolean {
  const lc = String(addr ?? '').trim().toLowerCase();
  return EMAILISH.test(lc) && ALERT_INTERNAL_SUFFIXES.some((suffix) => lc.endsWith(suffix));
}

export const OUTSIDE_REASON = `outside ${ALERT_INTERNAL_SUFFIXES.join(' and ')} — these alerts name customers and their freight`;

/**
 * PURE. Normalize ONE entry for a channel kind, or say why it is refused.
 *
 * `allowlist` decides whether a well-formed outside address is REFUSED or merely FLAGGED. It
 * is a parameter rather than a constant because of a promise this change makes: a site that
 * has saved nothing must alert exactly as it did before the screen existed. See envList().
 *
 * The refusal text is written to be read by whoever typed the thing, on the screen, next to
 * the field — not by a developer in a log. "not a 10-digit US mobile" tells somebody what to
 * do; "invalid" does not.
 */
export function normalizeEntry(
  raw: unknown,
  kind: ChannelKind,
  allowlist = true,
): { value: string | null; reason: string | null; warn: string | null } {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { value: null, reason: null, warn: null };   // blank is not a refusal, it is nothing
  if (kind === 'sms') {
    // NO allowlist parameter for phones, on purpose: this is not a policy check, it is the
    // SAME normalizePhone/validUsPhone lib/sms.mts hands SimpleTexting. A number refused here
    // is a number the transport would refuse anyway — so applying it to an env value changes
    // nothing except that the failure becomes readable before 9pm instead of after.
    const digits = normalizePhone(trimmed);
    if (!validUsPhone(digits)) return { value: null, reason: 'not a 10-digit US mobile number', warn: null };
    return { value: digits, reason: null, warn: null };
  }
  const lc = stripDisplayName(trimmed).toLowerCase();
  // Not an address at all is refused everywhere. Resend rejects the WHOLE message when one
  // recipient is malformed, so keeping a garbage entry would not "preserve" anything — it
  // would take the valid recipients down with it.
  if (!EMAILISH.test(lc)) return { value: null, reason: 'not an email address', warn: null };
  if (!internalEmail(lc)) {
    return allowlist
      ? { value: null, reason: OUTSIDE_REASON, warn: null }
      : { value: lc, reason: null, warn: OUTSIDE_REASON };
  }
  return { value: lc, reason: null, warn: null };
}

export interface ParsedList { accepted: string[]; rejected: Refusal[]; warned: Refusal[] }

/**
 * PURE. Turn anything list-shaped — an array from the browser, a pasted block, an env var —
 * into the entries this channel will accept, the ones it refused, and the ones it will use
 * but would not accept if they were typed today.
 *
 * Deduped in order, first occurrence wins, so a list pasted twice addresses each phone once.
 */
export function parseRecipientList(raw: unknown, kind: ChannelKind, allowlist = true): ParsedList {
  const parts = Array.isArray(raw) ? raw.flatMap((v) => splitEntries(v)) : splitEntries(raw);
  const accepted: string[] = [];
  const rejected: Refusal[] = [];
  const warned: Refusal[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const { value, reason, warn } = normalizeEntry(part, kind, allowlist);
    if (!value) {
      if (reason) rejected.push({ value: part, reason });
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    if (accepted.length >= MAX_PER_CHANNEL) {
      rejected.push({ value: part, reason: `over the ${MAX_PER_CHANNEL}-recipient limit for one channel` });
      continue;
    }
    accepted.push(value);
    if (warn) warned.push({ value: value, reason: warn });
  }
  return { accepted, rejected, warned };
}

/**
 * PURE. Validate a whole POST body into what may be stored, plus every refusal by name.
 *
 * ONLY KEYS THAT ARE PRESENT ARE TOUCHED. A body naming one channel edits one channel; the
 * other four keep whatever they had, which is what makes a field-masked write correct here
 * and a whole-document replace wrong. A key present with an empty array IS an edit — "send to
 * nobody" — and is stored as one.
 */
export function clampAlertRecipients(input: any): { config: Record<string, string[]>; rejected: Record<string, Refusal[]> } {
  const config: Record<string, string[]> = {};
  const rejected: Record<string, Refusal[]> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { config, rejected };
  for (const spec of RECIPIENT_CHANNELS) {
    if (!Object.prototype.hasOwnProperty.call(input, spec.key)) continue;
    const raw = input[spec.key];
    if (raw == null) continue;                                   // null means "leave it alone"
    const { accepted, rejected: refused } = parseRecipientList(raw, spec.kind);
    config[spec.key] = accepted;
    if (refused.length) rejected[spec.key] = refused;
  }
  return { config, rejected };
}

/**
 * PURE. The list a channel gets from the environment when nothing has been saved for it.
 *
 * Allowlisting follows the channel's own history, never a blanket rule — see
 * ChannelSpec.envEnforcesAllowlist for why that distinction is the whole safety argument.
 */
export function envList(spec: ChannelSpec, env: any = process.env): ParsedList {
  return parseRecipientList(env?.[spec.envVar], spec.kind, spec.envEnforcesAllowlist);
}

export type ListSource = 'saved' | 'env' | 'unset';

export interface ResolvedChannel {
  key: string;
  kind: ChannelKind;
  label: string;
  when: string;
  envVar: string;
  /** Exactly who the sender will address, floor included, in send order. */
  recipients: string[];
  /** The editable list — what the screen's rows are bound to, without the floor. */
  list: string[];
  source: ListSource;
  alwaysAlso: string | null;
  floorWhenEmpty: string | null;
  floorApplied: boolean;
  emptyNote: string;
  note: string | null;
  goesToLabel: string | null;
  /** Entries in the environment that could not be used at all, by name and with a reason. */
  envRejected: Refusal[];
  /**
   * Entries this channel IS using that the screen would not let anyone save today — an
   * outside address sitting in NOTIFY_CS_TO or DAY_REPORT_TO. Live, and flagged, because
   * turning them off silently would change who gets mail without anyone asking.
   */
  envWarned: Refusal[];
  /** Entries ON THE STORED DOCUMENT that this system refuses to mail or text. See below. */
  savedRejected: Refusal[];
}

/**
 * PURE. THE ANSWER TO "WHO GETS THIS ONE", resolved the way the sender resolves it.
 *
 * A saved list wins verbatim, empty included — see decision 1 in the header. The environment
 * is the fallback for a channel nobody has saved, so a site with no document behaves exactly
 * as it did before this file existed.
 *
 * NOTE THE ORDER OF THE LAST TWO STEPS. The floor is applied to the RESOLVED list, after the
 * saved/env choice, so "saved empty" and "env unset" reach the same floor by the same path —
 * there is no arrangement of document and environment that produces a channel with a floor
 * and nobody on it.
 *
 * AND THE STORED LIST IS RE-VALIDATED HERE, ON EVERY READ, WHICH IS NOT BELT-AND-BRACES.
 * Under the live firestore.rules every nuvizz_ops document is writable by anyone holding the
 * Firebase web config out of the public bundle — the endpoint's admin gate protects the WRITE
 * PATH, not the document. Validating only on write would mean a stranger could put an outside
 * address on the miss-window email, which names a customer, its PRO and its route. So the
 * allowlist is applied where it cannot be walked past: between the document and the sender.
 * Anything refused here is named in `savedRejected` rather than vanishing, because a
 * recipient who disappears in silence is the failure this whole area exists to end.
 */
export function resolveChannel(spec: ChannelSpec, stored: any, env: any = process.env): ResolvedChannel {
  const savedRaw = stored && typeof stored === 'object' ? stored[spec.key] : undefined;
  const hasSaved = Array.isArray(savedRaw);
  const fromEnv = envList(spec, env);
  // `true` is not a default here, it is the security control: the saved document is the one
  // an outsider could write (see the note above), so nothing comes off it unvalidated.
  const parsedSaved = hasSaved ? parseRecipientList(savedRaw, spec.kind, true) : null;

  const list = hasSaved ? parsedSaved!.accepted : fromEnv.accepted;
  const source: ListSource = hasSaved ? 'saved' : (fromEnv.accepted.length || fromEnv.rejected.length ? 'env' : 'unset');

  const floorApplied = !list.length && !!spec.floorWhenEmpty;
  const withFloor = floorApplied ? [spec.floorWhenEmpty as string] : list;
  const recipients = spec.alwaysAlso
    ? [spec.alwaysAlso, ...withFloor.filter((v) => v !== spec.alwaysAlso)]
    : withFloor;

  return {
    key: spec.key,
    kind: spec.kind,
    label: spec.label,
    when: spec.when,
    envVar: spec.envVar,
    recipients,
    list,
    source,
    alwaysAlso: spec.alwaysAlso,
    floorWhenEmpty: spec.floorWhenEmpty,
    floorApplied,
    emptyNote: spec.emptyNote,
    note: spec.note ?? null,
    goesToLabel: spec.goesToLabel ?? null,
    // Only worth reporting for a channel still running on its env var. Once a list is saved,
    // the env var is not what anybody is being mailed and naming its typos is noise.
    envRejected: hasSaved ? [] : fromEnv.rejected,
    envWarned: hasSaved ? [] : fromEnv.warned,
    savedRejected: parsedSaved?.rejected ?? [],
  };
}

/** PURE. Every channel resolved at once — the whole payload the screen renders. */
export function resolveAllChannels(stored: any, env: any = process.env): ResolvedChannel[] {
  return RECIPIENT_CHANNELS.map((spec) => resolveChannel(spec, stored, env));
}

/**
 * PURE. Just the send list for one channel — the shape a sender wants.
 *
 * Senders call THIS, never the stored document directly, so the list the screen prints and
 * the list the code uses are resolved by one function. That is the same invariant the daily
 * ceiling learned the hard way: a number displayed by one path and enforced by another is a
 * number nobody can trust.
 */
export function recipientsFor(key: string, stored: any, env: any = process.env): string[] {
  const spec = channelSpec(key);
  if (!spec) return [];
  return resolveChannel(spec, stored, env).recipients;
}
