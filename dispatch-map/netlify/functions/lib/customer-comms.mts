// lib/customer-comms.mts
//
// "Email the customer when their delivery is complete."
//
// WHY THIS EXISTS. NuVizz already sends a delivery-complete email, but it is not
// ours: it carries no Davis branding, no photo, no way to reply to a human, and no
// way to ask how the delivery went. This sends OUR email instead, off data we
// already have.
//
// ZERO NUVIZZ CALLS — and that is a hard requirement, not a nice-to-have (see
// CLAUDE.md). The trigger is a stop the scans ALREADY wrote to our board cache with
// normalizedStatus === 'DELIVERED', and the recipient comes off that same cached
// stop. Nothing here ever touches the vendor.
//
// SAFETY, because this points at ~600 stops/day and a bad loop emailing a real
// customer forty times is not recoverable:
//   1. DISABLED BY DEFAULT. enabled=false until switched on in the UI.
//   2. CLAIM BEFORE SEND, ATOMICALLY. The ledger entry is a Firestore create-if-absent
//      (createDocIfAbsent) whose precondition is evaluated inside the commit, so of two
//      racing sweeps exactly one wins the claim and only the winner sends. A claim that
//      cannot be written means NO send — never a send without a durable claim.
//   3. DAILY CAP (default 25), sized so the first live day is a trickle you can watch,
//      not a firehose. Read it as "about 25", not "at most 25": each sweep derives its
//      budget from one ledger read, so two overlapping sweeps can each get a full budget.
//      Every message still goes to a DISTINCT delivery — the claim in (2) guarantees that —
//      so the worst case is more correct emails than you authorised, never a duplicate.
//   4. BOARD-DATE FRESHNESS. A sweep refuses any board older than yesterday, so a
//      backfill or a hand-passed ?date= can never mail customers about old deliveries.
//   5. PER-CUSTOMER OPT-OUT. customer_notes.comms_opt_out === true is honoured — see
//      the note on the writer below before trusting this.
//   6. BEST-EFFORT. Nothing here throws. A mail failure must never break a scan —
//      same contract as cs-notify.
//
// Env: RESEND_API_KEY + RESEND_FROM (see lib/email.mts). Config below overrides the
// sender and reply-to per-site without a redeploy.

import { getDoc, setDoc, deleteDoc, listDocs, createDocIfAbsent, etDayString } from './firestore.mts';
import { normalizeMatchKey } from './match-key.mts';
import { emailEnabled, sendEmail } from './email.mts';

const OPS = 'nuvizz_ops';
const CONFIG_DOC = `${OPS}/customer_comms_config`;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The merge fields the template editor advertises. Exported from HERE, next to the
// stopVars() that supplies them, so the editor's list and the renderer cannot drift.
export const MERGE_FIELDS = [
  'pro', 'customer', 'driver', 'deliveredDate', 'deliveredTime', 'deliveredWhen',
  'address', 'address2', 'city', 'state', 'zip', 'cityStateZip', 'pieces', 'weight',
  'trackingUrl', 'reviewUrl', 'year',
];

// ── CONFIG ───────────────────────────────────────────────────────────────────

export interface CommsConfig {
  enabled: boolean;
  fromAddress: string;
  replyTo: string;
  subjectTemplate: string;
  htmlTemplate: string;
  dailyCap: number;
  updatedAt?: string;
  updatedBy?: string;
}

export const MAX_HTML_TEMPLATE = 64 * 1024;   // one Firestore field, and no email needs more
export const MAX_SUBJECT = 200;               // Resend rejects unbounded subjects outright
export const MAX_DAILY_CAP = 2000;

export const DEFAULT_CONFIG: CommsConfig = {
  // OFF until deliberately switched on. A feature that mails customers must never
  // start sending because it happened to deploy.
  enabled: false,
  // EMPTY means "use RESEND_FROM" — the address cs-notify already sends from, so it is
  // the one sender known to be verified in Resend. Setting this overrides the sender for
  // customer mail only; an address on an UNVERIFIED domain makes Resend reject every
  // send, so writeConfig validates the shape and the operator must verify the domain.
  fromAddress: '',
  replyTo: 'customerservice@davisdelivery.com',
  subjectTemplate: 'Delivered — PRO {{pro}}',
  htmlTemplate: '', // seeded from DEFAULT_HTML on first read
  dailyCap: 25,
};

export function clampDailyCap(n: any): number | null {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.min(Math.floor(v), MAX_DAILY_CAP);
}

// A single address, optionally wrapped in a display name: "a@b.com" or "Name <a@b.com>".
// Deliberately strict — this string is handed to Resend as a header, and a comma or a
// newline in it is how one address becomes several. PURE → unit-tested.
export function isSenderAddress(s: any): boolean {
  const v = String(s ?? '').trim();
  if (!v || v.length > 200 || /[\r\n\t,;]/.test(v)) return false;
  const m = /^(?:[^<>]{1,120}\s)?<?([^<>\s@]+@[^<>\s@]+\.[^<>\s@]{2,})>?$/.exec(v);
  return !!m;
}

// A bare recipient address. Same anti-injection rules, no display name.
export function isEmailAddress(s: any): boolean {
  const v = String(s ?? '').trim();
  return !!v && v.length <= 200 && !/[\r\n\t,;<>\s]/.test(v) && /^[^@]+@[^@]+\.[^@]{2,}$/.test(v);
}

/**
 * Optional shared-secret gate for the two endpoints that DO something (rewrite the config,
 * send a message) rather than just report.
 *
 * Be honest about what this is: the site has no login, so any token the UI holds ships in
 * the bundle — the same limitation debug-capture states about its own. It stops a drive-by,
 * not a determined attacker.
 *
 * It fails CLOSED. Unset, these two endpoints refuse rather than open, which is the opposite
 * of the read-only functions next door and deliberate: the config document PERSISTS. An
 * anonymous PUT writes htmlTemplate, fromAddress, replyTo and enabled into
 * nuvizz_ops/customer_comms_config, readConfig falls back to DEFAULT_CONFIG only when that
 * doc is ABSENT, and the first live sweep uses whatever is stored — so "ships disabled" is a
 * property of the default, not of the state on disk a month from now. Closed costs nothing
 * today (nothing in src/ calls these yet) and it forces the variable to be set before the
 * feature can be operated at all.
 */
export function adminTokenOk(req: Request): boolean {
  const want = String(process.env.COMMS_ADMIN_TOKEN || '').trim();
  if (!want) return false;
  const url = (() => { try { return new URL(req.url); } catch { return null; } })();
  const got = String(req.headers.get('x-comms-token') || url?.searchParams.get('token') || '').trim();
  return !!got && got === want;
}

/**
 * Who a TEST send may reach. The test endpoint works while the feature is disabled — that
 * is the whole point — so it is the one live send path on day one, and an unvalidated ?to=
 * makes it a public mailer. Defaults to the company domain; COMMS_TEST_ALLOWED_TO takes a
 * comma-separated list of full addresses and/or @domain suffixes. PURE → unit-tested.
 */
export function testRecipientAllowed(to: string, allow = process.env.COMMS_TEST_ALLOWED_TO): boolean {
  if (!isEmailAddress(to)) return false;
  const rules = String(allow || '@davisdelivery.com').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const lc = String(to).trim().toLowerCase();
  return rules.some((r) => (r.startsWith('@') ? lc.endsWith(r) : lc === r));
}

export async function readConfig(): Promise<CommsConfig> {
  const doc = await getDoc(CONFIG_DOC).catch(() => null);
  if (!doc) return { ...DEFAULT_CONFIG, htmlTemplate: DEFAULT_HTML };
  return {
    enabled: doc.enabled === true,
    // '' is meaningful (fall back to RESEND_FROM), so take the stored value verbatim.
    fromAddress: String(doc.fromAddress || ''),
    replyTo: String(doc.replyTo || DEFAULT_CONFIG.replyTo),
    subjectTemplate: String(doc.subjectTemplate || DEFAULT_CONFIG.subjectTemplate),
    htmlTemplate: String(doc.htmlTemplate || DEFAULT_HTML),
    // A cap of 0 is meaningful (pause without disabling), so only fall back when absent.
    dailyCap: Number.isFinite(Number(doc.dailyCap)) ? Number(doc.dailyCap) : DEFAULT_CONFIG.dailyCap,
    updatedAt: doc.updatedAt || undefined,
    updatedBy: doc.updatedBy || undefined,
  };
}

export async function writeConfig(cfg: Partial<CommsConfig>, by = 'dispatch-ui'): Promise<CommsConfig> {
  const cur = await readConfig();
  const next: CommsConfig = {
    ...cur,
    ...cfg,
    // Never let a bad payload turn the cap into NaN — that would compare false against
    // every guard and effectively remove the ceiling.
    dailyCap: clampDailyCap(cfg.dailyCap ?? cur.dailyCap) ?? cur.dailyCap,
    enabled: cfg.enabled === undefined ? cur.enabled : cfg.enabled === true,
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  };
  await setDoc(CONFIG_DOC, next);
  return next;
}

// ── LEDGER (dedup + the send log the UI reads) ───────────────────────────────
//
// ONE DOC PER SEND: nuvizz_ops/customer_comms_<YYYY-MM-DD>/sent/<key>, holding
//   { at, to, customer, subject, ok, id?, error?, claimed? }
//
// Per-send docs rather than one map on a day doc, because the doc is the LOCK. setDoc is
// a maskless PATCH — a full-document replace (firestore.mts documents the production
// incident where that silently wiped a counter) — so a read-modify-write of one shared
// `sent` map would let two overlapping sweeps drop each other's entries, and a dropped
// entry means a customer emailed twice. A create-if-absent on its own doc is an atomic
// claim instead: whoever wins it owns the send.
//
// The parent doc nuvizz_ops/customer_comms_<date> is the per-day STATUS snapshot (see
// writeSweepStatus) — subcollections do not require it to exist.

const sentCollection = (date: string) => `${OPS}/customer_comms_${date}/sent`;
const sentDoc = (date: string, key: string) => `${sentCollection(date)}/${key}`;

export interface LedgerEntry {
  at: string; to: string; customer?: string; subject?: string;
  // The doc id is the normalised stop number (see ledgerKey); `pro` is the number as the
  // board displays it, carried so the log can show what a dispatcher would recognise
  // rather than the de-zeroed key.
  pro?: string;
  ok: boolean; id?: string; error?: string; claimed?: boolean;
}

/**
 * The dedup key for a stop.
 *
 * stopNbr, NOT pro. LIVE_LIST_FIELDS pins stopNbr to the list value precisely because
 * /stop/info can return the same number in a different format (leading zeros), and it
 * pointedly does NOT pin `pro` — mergeEnrich copies the drifted value straight onto it.
 * Keying on `pro` would therefore write the claim under one spelling and read it under
 * another once a stop is enriched, and the customer gets a second email. Leading zeros
 * are stripped so both spellings collapse to the same key either way.
 *
 * Also sanitised: this becomes a Firestore document id. PURE → unit-tested.
 */
export function ledgerKey(stop: any): string {
  const raw = String(stop?.stopNbr || stop?.pro || stop?.primaryPro || '').trim().replace(/^0+/, '');
  // Reject on the RAW value, before sanitising: '.' and '..' are illegal Firestore ids, but
  // sanitising turns them into the perfectly legal '_' and '__', so a guard placed after the
  // rewrite never fires and junk data quietly claims a key. Requiring one alphanumeric
  // character covers '', '.', '..', '0000' and punctuation-only junk in one test.
  if (!/[A-Za-z0-9]/.test(raw)) return '';
  const key = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
  return /^__.*__$/.test(key) ? '' : key;   // Firestore reserves __…__ ids
}

/** Every send recorded for a date, keyed by ledgerKey. Throws if Firestore is unreachable. */
export async function readLedger(date: string): Promise<Record<string, LedgerEntry>> {
  const docs = await listDocs(sentCollection(date));
  const out: Record<string, LedgerEntry> = {};
  for (const d of docs) { const { _id, ...rest } = d; out[String(_id)] = rest as LedgerEntry; }
  return out;
}

/** Atomic claim. true = this call owns the send; false = someone already has it. */
async function claimSend(date: string, key: string, entry: LedgerEntry): Promise<boolean> {
  return createDocIfAbsent(sentDoc(date, key), entry);
}

async function finalizeSend(date: string, key: string, entry: LedgerEntry): Promise<void> {
  await setDoc(sentDoc(date, key), entry);
}

/** Hand the claim back so a later sweep can retry — used only on a definitive rejection. */
async function releaseClaim(date: string, key: string): Promise<void> {
  await deleteDoc(sentDoc(date, key));
}

// ── RECIPIENT + OPT-OUT ──────────────────────────────────────────────────────
//
// The cached stop DOES carry an email, and that is the only address populated today:
// normalizeStop builds contact{name,phone,sms,email} off the /stop/info destination
// contact, `contact` is not a LIVE list field so mergeEnrich carries it forward, and
// writeStops persists the whole stop. Davis fills it in themselves — the bulk-order
// "Consignee email" field maps to to.contact.email, and the BOL already reads it.
//
// customer_notes is the OVERRIDE layer, matching the precedence the phone lookup already
// uses: a dispatcher's correction must beat whatever the order carried, and it carries to
// the customer's NEXT order too.
//
// NOTE ON comms_email / comms_opt_out: nothing WRITES these yet. The notes editor renders
// name/phone/role contacts and a notify_cs toggle, and has no email field. Reading them
// here is forward-compatible, not a shipped guarantee — the opt-out is only real once the
// notes editor gains the toggle, which lands with the UI half. Do not enable this feature
// before then: an opt-out you cannot honour is worse than no opt-out.

export interface Recipient {
  email: string | null;
  optedOut: boolean;
  matchKey: string | null;
  name?: string;
  source?: 'notes' | 'order';
}

/**
 * The recipient decision, split out from the Firestore read so it can be unit-tested.
 * PURE.
 */
export function chooseRecipient(notes: any, stop: any, matchKey: string | null): Recipient {
  if (notes?.comms_opt_out === true) {
    return { email: null, optedOut: true, matchKey, name: notes.raw_name };
  }
  const override = String(notes?.comms_email || notes?.email || '').trim();
  const orderEmail = String(stop?.contact?.email || '').trim();
  const picked = override || orderEmail;
  return {
    email: isEmailAddress(picked) ? picked : null,
    optedOut: false,
    matchKey,
    name: notes?.raw_name,
    source: override ? 'notes' : 'order',
  };
}

/**
 * normalizeMatchKey always returns "<name>__<street>__<city>__<zip>", so an all-blank stop
 * yields the literal "______" — truthy, and a key every address-less stop would SHARE. The
 * key is only usable if it has actual content in it. PURE.
 */
export function usableMatchKey(stop: any): string | null {
  const key = normalizeMatchKey(stop?.businessName, stop?.addr1, stop?.city, stop?.zip);
  return /[a-z0-9]/i.test(String(key || '')) ? key : null;
}

export async function resolveRecipient(stop: any): Promise<Recipient> {
  const matchKey = usableMatchKey(stop);
  const notes = matchKey ? await getDoc(`customer_notes/${matchKey}`).catch(() => null) : null;
  return chooseRecipient(notes, stop, matchKey);
}

// ── TEMPLATE ─────────────────────────────────────────────────────────────────
//
// Deliberately dumb substitution — no expressions, no eval. The template is editable from
// the UI, so it must never be able to run anything. Two forms only:
//   {{field}}            — the value, or nothing at all when the field is unknown/empty
//   {{#field}}…{{/field}} — the body, but only when that field has a value
// The section form exists so an absent value can take its own label with it (no "DRIVER"
// heading over a blank line, no dangling "at" with no time). One level, no nesting, no
// negation — anything more is an expression language, which is exactly what this is not.

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  const withSections = String(tpl || '').replace(
    /\{\{#\s*([a-zA-Z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g,
    (_m, k: string, body: string) => (vars[k] ? body : ''),
  );
  return withSections.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Every merge value is DATA — a customer name, an address, a driver — and it lands in an
 * HTML document in someone's inbox. NuVizz carries whatever the shipper typed, so a
 * consignee name containing markup would otherwise be rendered as markup by Gmail and
 * Outlook. Escape at the HTML render only; a subject line is not HTML. PURE.
 */
export function escapeHtml(s: any): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function escapeVars(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = escapeHtml(v);
  return out;
}

/** A header, not a body: no CR/LF (injection), and bounded or Resend rejects the send. */
export function normalizeSubject(s: string): string {
  return String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_SUBJECT);
}

/**
 * Read a naive "YYYY-MM-DDTHH:MM" wall-clock stamp into its parts.
 *
 * deliveredDTTM has NO offset — parseSchedDate builds it from NuVizz's local display time
 * and nuvizz-list says so in as many words ("local — used for date bucketing + route
 * ordering, not absolute-tz math"). Netlify runs UTC, so `new Date(stamp)` reads it as UTC
 * and formatting that in America/New_York shifts it 4-5 hours BACKWARDS — every email
 * would show a delivery time hours early, and anything before ~5am would show the previous
 * DAY. So never parse it; read the digits. PURE → unit-tested.
 */
export function parseNaiveStamp(s: any): { date: string; hh: number; mm: number } | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(String(s ?? '').trim());
  if (!m) return null;
  const hh = +m[2], mm = +m[3];
  return hh > 23 || mm > 59 ? null : { date: m[1], hh, mm };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : String(ymd ?? '');
}

export function formatClock(hh: number, mm: number): string {
  return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

export function stopVars(stop: any, date: string): Record<string, string> {
  const pro = String(stop?.pro || stop?.primaryPro || stop?.stopNbr || '');
  const stamp = parseNaiveStamp(stop?.deliveredDTTM);
  const dDate = formatDay(stamp ? stamp.date : date);
  const dTime = stamp ? formatClock(stamp.hh, stamp.mm) : '';

  const city = String(stop?.city || '');
  const state = String(stop?.state || '');   // list rows carry no state; enrichment fills it
  const zip = String(stop?.zip || '');
  const cityState = [city, state].filter(Boolean).join(', ');
  const cityStateZip = [cityState, zip].filter(Boolean).join(' ');

  // NuVizz mislabels its freight fields and the scan relabels them: normalized `pallets`
  // is TOTAL pieces. An un-enriched list row has no `pallets`, but it does carry cartons
  // (= pallets/skids) and volume (= loose), which add up to the same total.
  const listPieces = Number(stop?.cartons || 0) + Number(stop?.volume || 0);
  const pieces = stop?.pallets != null ? String(stop.pallets) : (listPieces > 0 ? String(listPieces) : '');

  return {
    pro,
    customer: String(stop?.businessName || ''),
    driver: String(stop?.driverName || ''),
    deliveredDate: dDate,
    deliveredTime: dTime,
    deliveredWhen: dTime ? `${dDate} at ${dTime}` : dDate,
    address: String(stop?.addr1 || ''),
    // The suite/unit line. Freight goes to a dock, and "Ste 200" is often the difference
    // between the right door and the wrong one — showing the customer an address we
    // delivered to with the unit silently dropped reads as us having got it wrong.
    address2: String(stop?.addr2 || ''),
    city, state, zip, cityStateZip,
    pieces,
    weight: stop?.weight != null ? String(stop.weight) : '',
    trackingUrl: pro ? `https://tracking.davisdelivery.com/?pro=${encodeURIComponent(pro)}` : 'https://tracking.davisdelivery.com/',
    reviewUrl: pro ? `https://tracking.davisdelivery.com/?pro=${encodeURIComponent(pro)}#review` : 'https://tracking.davisdelivery.com/',
    // ET, not the UTC runtime's year — otherwise a New Year's Eve send stamps next year.
    year: etDayString().slice(0, 4),
  };
}

export function buildMessage(stop: any, date: string, cfg: CommsConfig): { subject: string; html: string; vars: Record<string, string> } {
  const vars = stopVars(stop, date);
  return {
    subject: normalizeSubject(renderTemplate(cfg.subjectTemplate, vars)),
    html: renderTemplate(cfg.htmlTemplate, escapeVars(vars)),
    vars,
  };
}

// ── FRESHNESS ────────────────────────────────────────────────────────────────
//
// Nothing upstream bounds the date a sweep can be handed: the refresh entrypoint takes a
// ?date= straight off the query string and the manual scan forwards it verbatim. Without a
// bound, one ?date=<six weeks ago> would sweep an old board against a fresh empty ledger
// and mail real customers about ancient deliveries. Yesterday is allowed because a scan
// running just after ET midnight still writes yesterday's board. PURE → unit-tested.

export const MAX_BOARD_AGE_DAYS = 1;

export function isSweepableBoardDate(date: string, today: string = etDayString()): boolean {
  if (!DATE_RE.test(String(date || '')) || !DATE_RE.test(String(today || ''))) return false;
  const t = Date.parse(`${today}T00:00:00Z`);
  const d = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(d)) return false;
  const days = Math.round((t - d) / 86400000);
  // Future board dates are harmless (they carry no delivered stops) but bounded anyway so
  // a typo'd year cannot open an unbounded window.
  return days <= MAX_BOARD_AGE_DAYS && days >= -7;
}

/**
 * A stop whose delivery stamp is well before its own board date — a rolled-forward or
 * re-dated row. Fails OPEN when the stamp is missing or unparseable: the board-date guard
 * above is what actually bounds this, and DELIVERED rows on the list path always carry a
 * stamp. PURE → unit-tested.
 */
export function isStaleDelivery(stop: any, date: string, maxAgeDays = 2): boolean {
  const stamp = parseNaiveStamp(stop?.deliveredDTTM);
  if (!stamp || !DATE_RE.test(String(date || ''))) return false;
  const d = Date.parse(`${date}T00:00:00Z`);
  const s = Date.parse(`${stamp.date}T00:00:00Z`);
  if (Number.isNaN(d) || Number.isNaN(s)) return false;
  return Math.round((d - s) / 86400000) > maxAgeDays;
}

// ── SEND ONE ─────────────────────────────────────────────────────────────────

export interface SendOutcome {
  pro: string; key?: string; skipped?: string; ok?: boolean; to?: string; error?: string;
  retryable?: boolean;
}

// The claim/send/release trio, injectable ONLY so the ordering can be unit-tested. That
// ordering — claim wins before anything is sent, a failed claim sends nothing, an ambiguous
// failure keeps its claim — is the single property that stops a customer being emailed
// twice, and it is not something to leave verified by inspection alone. Production always
// takes the defaults.
export interface SendDeps {
  claim: (date: string, key: string, entry: LedgerEntry) => Promise<boolean>;
  finalize: (date: string, key: string, entry: LedgerEntry) => Promise<void>;
  release: (date: string, key: string) => Promise<void>;
  send: typeof sendEmail;
  recipient: (stop: any) => Promise<Recipient>;
}

/**
 * Resend answered and REFUSED the message — nothing was created — so the claim can safely be
 * handed back and a later sweep retries.
 *
 * TWO things are deliberately NOT this, because both mean "we do not know":
 *   • a thrown/network failure (no `Resend HTTP` prefix) — Resend may have accepted before
 *     the socket died;
 *   • a 5xx or a 408 — those come from a gateway, which can time out AFTER Resend accepted
 *     and queued the message.
 * Releasing a claim in either case is how a customer gets a second email, which is the one
 * outcome this whole module exists to prevent. A 429 IS a refusal: the API rejected the
 * request and queued nothing, so that claim is released and retried.
 * PURE → unit-tested.
 */
export function isDefinitiveRejection(error?: string): boolean {
  const m = /^Resend HTTP (\d{3})/.exec(String(error || ''));
  if (!m) return false;
  const s = Number(m[1]);
  return s >= 400 && s < 500 && s !== 408;
}

export async function sendForStop(
  stop: any,
  date: string,
  opts: { cfg?: CommsConfig; force?: boolean; toOverride?: string; deps?: Partial<SendDeps> } = {},
): Promise<SendOutcome> {
  const d: SendDeps = {
    claim: claimSend, finalize: finalizeSend, release: releaseClaim,
    send: sendEmail, recipient: resolveRecipient, ...(opts.deps || {}),
  };
  const cfg = opts.cfg || (await readConfig());
  const pro = String(stop?.pro || stop?.primaryPro || stop?.stopNbr || '');
  const key = ledgerKey(stop);
  if (!key) return { pro, skipped: 'no_stop_nbr' };
  if (!cfg.enabled && !opts.force) return { pro, key, skipped: 'disabled' };
  if (!emailEnabled()) return { pro, key, skipped: 'email_not_configured' };

  const status = String(stop?.normalizedStatus || '').toUpperCase();
  if (status !== 'DELIVERED' && !opts.force) return { pro, key, skipped: `not_delivered(${status || 'unknown'})` };
  if (isStaleDelivery(stop, date) && !opts.force) return { pro, key, skipped: 'stale_delivery' };

  let to = opts.toOverride || '';
  let customerName = String(stop?.businessName || '');
  if (!to) {
    const r = await d.recipient(stop);
    if (r.optedOut) return { pro, key, skipped: 'opted_out' };
    if (!r.email) return { pro, key, skipped: 'no_email_on_file' };
    to = r.email;
    if (r.name) customerName = String(r.name);
  }
  if (!isEmailAddress(to)) return { pro, key, skipped: 'bad_recipient' };

  const { subject, html } = buildMessage(stop, date, cfg);

  // CLAIM, ATOMICALLY, BEFORE SENDING. The precondition is evaluated inside Firestore's
  // commit, so two overlapping sweeps cannot both win it. A claim that cannot be written
  // is not a reason to send anyway — it is the reason NOT to, because without a durable
  // claim nothing stops the next sweep sending the same email again.
  let owned: boolean;
  try {
    owned = await d.claim(date, key, {
      at: new Date().toISOString(), to, customer: customerName, subject, pro, ok: false, claimed: true,
    });
  } catch (e: any) {
    console.warn(`[customer-comms] claim write failed for ${key}: ${e?.message}`);
    return { pro, key, skipped: 'claim_failed' };
  }
  if (!owned) return { pro, key, skipped: 'already_sent' };

  const res = await d.send({ to, subject, html, replyTo: cfg.replyTo, from: cfg.fromAddress || undefined });

  if (!res.ok && isDefinitiveRejection(res.error)) {
    // Resend refused it, so nothing was delivered and nothing is in flight. Release the
    // claim rather than leaving the customer permanently suppressed by a failure — an
    // outage would otherwise burn the day's cap on mail that never went out.
    await d.release(date, key).catch((e: any) =>
      console.warn(`[customer-comms] claim release failed for ${key}: ${e?.message}`));
    return { pro, key, ok: false, to, error: res.error, retryable: true };
  }

  await d.finalize(date, key, {
    at: new Date().toISOString(), to, customer: customerName, subject, pro,
    ok: res.ok, ...(res.id ? { id: res.id } : {}), ...(res.error ? { error: res.error } : {}),
    // A send that neither succeeded nor was refused stays CLAIMED: it may have landed.
    ...(res.ok ? {} : { claimed: true }),
  }).catch((e: any) => console.warn(`[customer-comms] result write failed for ${key}: ${e?.message}`));

  return { pro, key, ok: res.ok, to, error: res.error };
}

// ── SWEEP A DAY'S BOARD ──────────────────────────────────────────────────────
//
// Called after a scan writes a date's stops. Reads only the cache. Honours the daily cap
// and stops cleanly when it is reached rather than partially sending past it.

export const FAILURE_CIRCUIT = 5;

export interface SweepResult {
  ran: boolean; sent: number; failed: number;
  skipped: Record<string, number>;
  capped?: boolean; circuitOpen?: boolean; reason?: string;
}

export async function sweepDelivered(
  stops: any[],
  date: string = etDayString(),
  opts: { today?: string } = {},
): Promise<SweepResult> {
  const skipped: Record<string, number> = {};
  const bump = (k: string, n = 1) => { skipped[k] = (skipped[k] || 0) + n; };
  const all = Array.isArray(stops) ? stops : [];

  if (!isSweepableBoardDate(date, opts.today || etDayString())) {
    return { ran: false, sent: 0, failed: 0, skipped: {}, reason: 'stale_board_date' };
  }

  const cfg = await readConfig();
  if (!cfg.enabled) return { ran: false, sent: 0, failed: 0, skipped: {}, reason: 'disabled' };
  if (!emailEnabled()) return { ran: false, sent: 0, failed: 0, skipped: {}, reason: 'email_not_configured' };

  // Count only what this feature is about. Reporting the whole ~600-stop board as
  // "skipped" buries the handful of numbers anyone actually reads.
  const delivered = all.filter((s) => String(s?.normalizedStatus || '').toUpperCase() === 'DELIVERED');
  if (!delivered.length) {
    // Nothing to do, and no reason to spend a ledger read finding that out. Future board
    // dates hit this on every scan.
    return { ran: true, sent: 0, failed: 0, skipped: {}, reason: 'no_delivered_stops' };
  }

  // Fail CLOSED on an unreadable ledger. An empty read that really meant "Firestore is
  // down" would look exactly like "nobody has been emailed yet" and re-send the day.
  let already: number;
  try {
    already = Object.keys(await readLedger(date)).length;
  } catch (e: any) {
    console.warn(`[customer-comms] ledger read failed for ${date}: ${e?.message}`);
    return { ran: false, sent: 0, failed: 0, skipped: {}, reason: 'ledger_unavailable' };
  }

  let budget = Math.max(0, cfg.dailyCap - already);
  if (budget <= 0) {
    await writeSweepStatus(date, { considered: delivered.length, sent: 0, failed: 0, capped: true, skipped: { daily_cap: delivered.length } });
    return { ran: true, sent: 0, failed: 0, skipped: { daily_cap: delivered.length }, capped: true };
  }

  let sent = 0, failed = 0, consecutiveFailures = 0, circuitOpen = false;
  const errors: string[] = [];
  for (const stop of delivered) {
    if (budget <= 0) { bump('daily_cap'); continue; }
    if (circuitOpen) { bump('circuit_open'); continue; }
    try {
      const r = await sendForStop(stop, date, { cfg });
      if (r.skipped) { bump(r.skipped); continue; }
      if (r.ok) {
        sent++; budget--; consecutiveFailures = 0;
      } else {
        failed++; consecutiveFailures++;
        if (errors.length < 5 && r.error) errors.push(`${r.key}: ${r.error}`);
        // A retryable rejection released its claim, so it costs no budget — otherwise a
        // Resend outage would spend the whole day's cap on mail that never went out.
        if (!r.retryable) budget--;
        if (consecutiveFailures >= FAILURE_CIRCUIT) {
          circuitOpen = true;
          console.warn(`[customer-comms] ${FAILURE_CIRCUIT} consecutive failures on ${date} — stopping the sweep`);
        }
      }
    } catch (e: any) {
      // Never let one bad stop end the sweep — or break the scan that called us.
      bump('threw');
      if (errors.length < 5) errors.push(String(e?.message || e));
    }
  }

  await writeSweepStatus(date, { considered: delivered.length, sent, failed, capped: budget <= 0, circuitOpen, skipped, errors });
  return { ran: true, sent, failed, skipped, capped: budget <= 0, circuitOpen };
}

/**
 * The per-day status snapshot, so this feature can never be an INVISIBLE no-op — the same
 * diagnostic cs-notify keeps, for the same reason. Without it a day where all 600 stops
 * skipped `no_email_on_file` reads identically to a day the sweep never ran. Best-effort.
 */
export async function writeSweepStatus(date: string, s: Record<string, any>): Promise<void> {
  try {
    await setDoc(`${OPS}/customer_comms_${date}`, { date, at: new Date().toISOString(), ...s });
  } catch (e: any) {
    console.warn(`[customer-comms] status write failed for ${date}: ${e?.message}`);
  }
}

export async function readSweepStatus(date: string): Promise<any | null> {
  return getDoc(`${OPS}/customer_comms_${date}`).catch(() => null);
}

// ── DEFAULT TEMPLATE ─────────────────────────────────────────────────────────
// Table-based and inline-styled: Gmail and Outlook strip <style> blocks, so every rule is
// on the element and the layout is tables.
//
// NO IMAGE IN THE HEADER, and that is deliberate rather than lazy. The masthead is a styled
// text wordmark because (a) the URL this template shipped with,
// tracking.davisdelivery.com/logo.png, is a 404 — every send would have opened with a broken
// image — and (b) Outlook and Gmail block remote images by default, so even a working logo is
// blank on first view for a large share of recipients. Text always renders.
//
// TO USE THE REAL LOGO: host it somewhere stable (the repo's copy is
// dispatch-map/public/davis-logo.jpg) and swap this block for an <img> from the
// Communications tab — htmlTemplate lives in Firestore, so it needs no redeploy. Note the
// asset is blue-on-WHITE, so give it a white header band rather than this navy one, keep it
// under ~40 KB, and always set alt text: that alt is what the blocked-image case shows.
//
// NO PHONE NUMBER, deliberately. Netlify's secrets scan greps every file here for the
// VALUES of this site's env vars, and SIMPLETEXTING_FROM is an account phone — a bare
// ten-digit number in this file reads as that credential and kills the deploy, with a
// build-script exit code and nothing else to go on. Anything of that shape belongs in the
// runtime config instead: htmlTemplate lives in Firestore, so a phone number can be added
// from the Communications tab without ever entering the repo. See test/no-lifelike-\
// addresses.test.mjs, which enforces this, and HANDOFF.md for how the trap was found.

export const DEFAULT_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EDF1F5;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:4px;overflow:hidden;font-family:'DM Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td style="background:#123A63;padding:22px 32px;">
    <div style="font-size:23px;font-weight:700;letter-spacing:3px;color:#fff;line-height:1;">DAVIS</div>
    <div style="font-size:11px;font-weight:600;letter-spacing:3.4px;color:#8FB2D4;padding-top:5px;">DELIVERY SERVICE</div>
    <div style="font-size:11px;color:#6E90B4;padding-top:5px;font-style:italic;">Family owned since 1985</div>
  </td></tr>
  <tr><td style="background:#1B7A4B;padding:13px 32px;text-align:center;color:#fff;font-size:15px;font-weight:700;">
    &#10003;&nbsp; DELIVERED &nbsp;<span style="color:#B8E2CB;font-weight:400;">{{deliveredWhen}}</span>
  </td></tr>
  <tr><td style="padding:32px 32px 20px;">
    <div style="font-size:21px;font-weight:700;color:#16202B;">Your freight has been delivered.</div>
    <div style="font-size:15px;color:#5A6B7C;line-height:1.6;padding-top:10px;">
      Hi {{customer}} — our driver completed your delivery. Details are below. Just reply to this email if anything doesn't look right.
    </div>
  </td></tr>
  <tr><td style="padding:0 32px;">
    <table role="presentation" width="100%" style="border:1px solid #D6DFE8;border-radius:3px;">
      <tr><td style="background:#F7F9FB;border-bottom:1px dashed #C3D0DC;padding:14px 20px;">
        <div style="font-size:10px;letter-spacing:1.6px;color:#7C8B9A;text-transform:uppercase;">Pro Number</div>
        <div style="font-family:'Courier New',monospace;font-size:22px;font-weight:700;color:#123A63;letter-spacing:1px;">{{pro}}</div>
      </td></tr>
      <tr><td style="padding:18px 20px;font-size:14px;color:#16202B;">
        <div style="font-size:10px;letter-spacing:1.2px;color:#7C8B9A;text-transform:uppercase;padding-bottom:4px;">Delivered To</div>
        <div style="font-weight:600;line-height:1.5;">{{customer}}<br><span style="font-weight:400;color:#5A6B7C;">{{address}}{{#address2}}<br>{{address2}}{{/address2}}<br>{{cityStateZip}}</span></div>
        {{#driver}}<div style="font-size:10px;letter-spacing:1.2px;color:#7C8B9A;text-transform:uppercase;padding:14px 0 4px;">Driver</div>
        <div style="font-weight:600;">{{driver}}</div>{{/driver}}
        <div style="border-top:1px dashed #C3D0DC;margin-top:14px;padding-top:12px;">
          <a href="{{trackingUrl}}" style="color:#123A63;font-size:13px;font-weight:600;text-decoration:none;">View full tracking &rarr;</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:26px 32px 0;">
    <table role="presentation" width="100%" style="background:#FDF7EA;border:1px solid #F0DCB4;border-radius:3px;"><tr>
      <td style="padding:22px 24px;" align="center">
        <div style="font-size:16px;font-weight:700;color:#16202B;">How did we do?</div>
        <div style="font-size:14px;color:#6B5A3E;line-height:1.6;padding:8px 0 16px;">Thirty seconds of feedback helps us keep your freight moving right.</div>
        <a href="{{reviewUrl}}" style="display:inline-block;background:#E8A317;color:#16202B;font-size:15px;font-weight:700;text-decoration:none;padding:13px 34px;border-radius:3px;">Rate this delivery</a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:30px 32px 0;">
    <div style="border-top:1px solid #E4EAF0;padding-top:22px;">
      <div style="font-size:10px;letter-spacing:1.6px;color:#7C8B9A;text-transform:uppercase;padding-bottom:14px;">Also hauling for Georgia shippers</div>
      <table role="presentation" width="100%"><tr>
        <td width="33%" valign="top" style="padding-right:10px;"><div style="font-size:14px;font-weight:700;color:#123A63;">LTL &amp; Truckload</div><div style="font-size:13px;color:#5A6B7C;line-height:1.5;">Statewide final mile, one pallet or a full trailer.</div></td>
        <td width="33%" valign="top" style="padding:0 5px;"><div style="font-size:14px;font-weight:700;color:#123A63;">Tile &amp; Flooring</div><div style="font-size:13px;color:#5A6B7C;line-height:1.5;">Liftgate and specialty handling for fragile freight.</div></td>
        <td width="33%" valign="top" style="padding-left:10px;"><div style="font-size:14px;font-weight:700;color:#123A63;">Expedited</div><div style="font-size:13px;color:#5A6B7C;line-height:1.5;">Same-day and time-critical runs across metro Atlanta.</div></td>
      </tr></table>
      <div style="padding-top:16px;"><a href="https://davisdelivery.com/contact/request-a-quote/" style="display:inline-block;border:1.5px solid #123A63;color:#123A63;font-size:14px;font-weight:700;text-decoration:none;padding:11px 26px;border-radius:3px;">Request a quote</a></div>
    </div>
  </td></tr>
  <tr><td style="padding:28px 32px 32px;">
    <div style="border-top:1px solid #E4EAF0;padding-top:20px;font-size:12px;color:#7C8B9A;line-height:1.7;">
      <strong style="color:#16202B;font-size:13px;">Davis Delivery Service, Inc.</strong><br>
      Buford, Georgia &nbsp;·&nbsp; <a href="https://davisdelivery.com" style="color:#123A63;text-decoration:none;">davisdelivery.com</a><br>
      <span style="color:#93A3B3;">Replies to this email reach our customer service team.</span><br>
      <span style="color:#A8B5C2;font-size:11px;">You're receiving this because Davis Delivery completed a freight delivery to your address. Reply with "unsubscribe" and we'll stop sending them.</span>
    </div>
  </td></tr>
</table>
</td></tr></table>`;
