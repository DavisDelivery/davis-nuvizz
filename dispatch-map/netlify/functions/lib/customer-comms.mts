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

import { getDoc, setDoc, deleteDoc, listDocs, createDocIfAbsent, etDayString, etHourString } from './firestore.mts';
import { normalizeMatchKey } from './match-key.mts';
import { emailEnabled, sendEmail } from './email.mts';
import { unsubSecret, unsubscribeUrl } from './unsubscribe.mts';

const OPS = 'nuvizz_ops';
const CONFIG_DOC = `${OPS}/customer_comms_config`;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The merge fields the template editor advertises. Exported from HERE, next to the
// stopVars() that supplies them, so the editor's list and the renderer cannot drift.
export const MERGE_FIELDS = [
  'pro', 'customer', 'deliveredDate', 'deliveredTime', 'deliveredWhen',
  'address', 'address2', 'city', 'state', 'zip', 'cityStateZip', 'pieces', 'weight',
  'trackingUrl', 'reviewUrl', 'unsubscribeUrl', 'year',
];

// ── SENDER DOMAIN STATUS ─────────────────────────────────────────────────────
//
// The "DNS is not verified yet — every send is rejected" panel on the Communications tab
// used to be HARDCODED. It was written while davisdelivery.com genuinely was unverified,
// and it kept saying so afterwards: Chad, looking at a live program that had just put out
// 25 emails with 25 delivered, asked "What is this yellow window for?"
//
// A warning that cannot stop warning is worse than no warning. It sits on the one screen
// somebody checks to find out whether email is working, and it contradicts the answer.
//
// So ask Resend. One GET, no NuVizz calls, and it tells the truth in BOTH directions —
// including the direction that matters later, when a record is edited or expires and sends
// start bouncing with nothing on screen to explain why.

export interface DomainStatus {
  /** null = we could not tell (no key, API down). NEVER guessed — see below. */
  verified: boolean | null;
  domain: string | null;
  status: string | null;
  /** Only the records still failing, so a partly-published domain says which one is left. */
  pending: Array<{ type: string; name: string; value: string }>;
  error?: string;
}

/** The domain half of "Name <box@domain>" or "box@domain". PURE. */
export function senderDomain(from: string): string | null {
  const m = /<([^>]*)>/.exec(String(from || ''));
  const addr = (m ? m[1] : String(from || '')).trim();
  const at = addr.lastIndexOf('@');
  // > 0, not >= 0: '@example.com' has a domain but no mailbox in front of it, and that is
  // not a sender. Found by the test below.
  if (at <= 0) return null;
  const d = addr.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

/**
 * Read one Resend domain's verification state. PURE given `fetchImpl`.
 *
 * Fails to `verified: null`, never to `false`. "I could not check" and "your DNS is
 * broken" are different claims, and showing the second when you mean the first is exactly
 * the failure this replaces.
 */
export async function readDomainStatus(
  from: string,
  apiKey: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DomainStatus> {
  const domain = senderDomain(from);
  const none = { verified: null as boolean | null, domain, status: null, pending: [] };
  if (!domain) return { ...none, error: 'no sender domain' };
  if (!apiKey) return { ...none, error: 'RESEND_API_KEY not set' };
  try {
    const r = await fetchImpl('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!r.ok) return { ...none, error: `resend ${r.status}` };
    const j: any = await r.json().catch(() => null);
    const list: any[] = Array.isArray(j?.data) ? j.data : [];
    const hit = list.find((d) => String(d?.name || '').toLowerCase() === domain);
    // Registered domains we can see, but not THIS one: that is a real, reportable answer
    // ("nothing is going to send"), not an inability to check.
    if (!hit) return { verified: false, domain, status: 'not_registered', pending: [] };
    const status = String(hit.status || '').toLowerCase();
    const records: any[] = Array.isArray(hit.records) ? hit.records : [];
    const pending = records
      .filter((rec) => String(rec?.status || '').toLowerCase() !== 'verified')
      .map((rec) => ({ type: String(rec?.type || ''), name: String(rec?.name || ''), value: String(rec?.value || '') }));
    return { verified: status === 'verified', domain, status, pending };
  } catch (e: any) {
    return { ...none, error: e?.message || 'domain read failed' };
  }
}

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
  // Chad asked for notifications@davisdelivery.com, and as of v0.54.85 that is what this is.
  //
  // The two things that blocked it are done: the Resend plan was upgraded (it previously
  // refused to add a second domain at all — 403 "You have reached the domain limit"), and
  // davisdelivery.com is now registered in Resend as domain 8eb3cbb7.
  //
  // WHAT IS NOT DONE, and it is the one thing that decides whether mail actually leaves:
  // the domain's DNS. Until these three records resolve, Resend REJECTS every send from
  // this address — it does not fall back to a working sender, it fails the send:
  //     TXT  resend._domainkey   p=MIGfMA0GCSqG…   (DKIM)
  //     MX   send                feedback-smtp.us-east-1.amazonses.com   priority 10
  //     TXT  send                v=spf1 include:amazonses.com ~all
  // All three hang off `send.` and `resend._domainkey.`, NOT the apex, so publishing them
  // does not disturb the existing davisdelivery.com mail setup.
  //
  // The sweep trigger IS wired now (customer-comms-sweep-background.mts), so the [TEST]
  // button is no longer the only path that can attempt a send. What holds the mail is
  // `enabled` below, which defaults to false and is flipped only from the UI.
  //
  // To fall back while waiting, put the warehouse address in More → Customer
  // emails → Sender — but know that the FIRST save from that screen writes the whole config
  // document to Firestore, htmlTemplate included, after which template changes in code stop
  // reaching the site. Prefer waiting for DNS over taking that trade.
  fromAddress: 'Davis Delivery Service <notifications@davisdelivery.com>',
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
 * It fails OPEN when the variable is unset — Chad's explicit call ("get rid of this need
 * for a token"), and consistent with the rest of this app: there is no login anywhere,
 * nuvizz-write takes unauthenticated writes to the vendor itself, and the dispatchers who
 * can reach this URL are the people meant to edit this config. The prompt was costing a
 * real operator more than the gate was worth against a hypothetical one.
 *
 * What still holds without the token: TEST sends stay allow-listed to Davis inboxes
 * (testRecipientAllowed), enabling still refuses while Resend is unconfigured, the daily
 * cap still clamps, and the live sweep still does not exist until it ships. Setting
 * COMMS_ADMIN_TOKEN re-arms the gate with no code change, and the UI sends the header
 * whenever it has a value.
 */
export function adminTokenOk(req: Request): boolean {
  const want = String(process.env.COMMS_ADMIN_TOKEN || '').trim();
  if (!want) return true;
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
// NOTE ON comms_email / comms_opt_out: BOTH ARE WRITABLE AS OF v0.54.78 — the customer-notes
// editor gained the red "No delivery emails to this customer" suppression toggle and the
// per-customer address override (see App.jsx, the comms_opt_out block). This comment
// previously said nothing wrote them and that the feature must not be enabled until
// something did, because an opt-out you cannot honour is worse than no opt-out. That
// condition is now MET, and it was a precondition of wiring the trigger at all.

export interface Recipient {
  email: string | null;
  optedOut: boolean;
  matchKey: string | null;
  name?: string;
  source?: 'notes' | 'order';
  /** The notes doc could not be READ (not merely absent). We cannot know whether this
   *  customer opted out, so the caller must decline to send. */
  notesUnavailable?: boolean;
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
/**
 * Is this row a CUSTOMER DELIVERY — the only thing this feature is entitled to email about?
 *
 * DELIVERED alone is not enough. Every stop on the board carries a stopType, 'DO' for a
 * drop-off and 'PU' for a pickup (nuvizz-list.mts derives it, and enrichment overwrites it
 * from /stop/info). A completed PICKUP is also normalizedStatus DELIVERED — it means "we
 * collected the freight", not "your freight arrived". Emailing the shipper "Delivered — PRO
 * 12345, your delivery is complete" the moment we take custody is wrong on its face, and it
 * would go out at pickup volume, to the party most likely to notice.
 *
 * Unknown/absent stopType is treated as a DELIVERY, deliberately: enrichment is the
 * authority and a not-yet-enriched row has no type at all. Excluding those would silently
 * drop real customers, which is the failure this feature exists to prevent — whereas the
 * thing we are guarding against announces itself with an explicit 'PU'. PURE → unit-tested.
 */
export function isCustomerDelivery(stop: any): boolean {
  if (String(stop?.normalizedStatus || '').toUpperCase() !== 'DELIVERED') return false;
  return String(stop?.stopType || '').trim().toUpperCase() !== 'PU';
}

export function usableMatchKey(stop: any): string | null {
  const key = normalizeMatchKey(stop?.businessName, stop?.addr1, stop?.city, stop?.zip);
  return /[a-z0-9]/i.test(String(key || '')) ? key : null;
}

export async function resolveRecipient(stop: any): Promise<Recipient> {
  const matchKey = usableMatchKey(stop);
  if (!matchKey) return chooseRecipient(null, stop, null);
  // FAIL CLOSED ON AN UNREADABLE NOTES DOC. This used to be `.catch(() => null)`, which
  // collapsed "Firestore errored" into "this customer has no notes" — and the ONLY thing
  // that records an opt-out is that document. So a transient read failure did not merely
  // lose a preference; it emailed a customer who had explicitly asked us to stop, and did
  // it silently. This module's own note says an opt-out you cannot honour is worse than no
  // opt-out; honouring it only when the network agrees is the same thing.
  //
  // A missing document is NOT an error — getDoc resolves null for that, which is the
  // ordinary case for the vast majority of customers and still sends.
  try {
    const notes = await getDoc(`customer_notes/${matchKey}`);
    return chooseRecipient(notes, stop, matchKey);
  } catch (e: any) {
    console.warn(`[customer-comms] notes read failed for ${matchKey}: ${e?.message}`);
    return { email: null, optedOut: false, matchKey, notesUnavailable: true };
  }
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
 * Every merge value is DATA — a customer name, an address, a pro number — and it lands in an
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

// ── TRACKING PORTAL LINKS ────────────────────────────────────────────────────
//
// The portal is ONE page reached from several places, and until now every arrival looked
// identical to it: the delivery email's "Track" button, its "Rate this delivery" button and
// a customer who bookmarked the site all landed on the same URL carrying the same nothing.
// So when a review came in, "where did this come from?" had no answer — the stored record
// had no such field and the page had never been told.
//
// `src` is that missing sentence. It rides on the link, the portal reads it on arrival and
// keeps it for the session, and it is POSTed with the review and stored on the record.
//
// A query parameter for the same reason `rate=1` is one: the portal's own initFromUrl parses
// the query string and has no reader for a fragment.
//
// HONEST ABOUT ITS LIMITS. A forwarded email carries the FORWARDER's tag, and a bookmark,
// a retype, or a reload that drops the query string carries none and reads as `direct`. This
// is right for the ordinary case, which is the case worth sizing — it is not an audit trail.
//
// Carried even when there is no PRO. There is nothing to track and nothing to rate on a bare
// link, but the click still came out of an email, and that is the fact `src` exists to keep.
export const TRACKING_ORIGIN = 'https://tracking.davisdelivery.com/';

// Where the unsubscribe link points. This app's own site, because the endpoint that honours
// it lives here. Overridable so a custom domain can be moved onto later without a code change.
export const SITE_ORIGIN = (process.env.COMMS_SITE_ORIGIN || 'https://dd-dispatch-map.netlify.app').replace(/\/+$/, '');

export function trackingLink(pro: string, extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams();
  if (pro) qs.set('pro', pro);
  for (const [k, v] of Object.entries(extra)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `${TRACKING_ORIGIN}?${s}` : TRACKING_ORIGIN;
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
    // No `driver`. Chad, Aug 2026: "Want drivers name removed from these emails."
    //
    // Removed as a VALUE, not just from DEFAULT_HTML below, because DEFAULT_HTML is only
    // the fallback — readConfig prefers the htmlTemplate saved in Firestore, and the saved
    // one carries the old {{#driver}} block. Deleting the markup here would have left the
    // name in every live email. With no value, renderTemplate drops {{#driver}}…{{/driver}}
    // whole (label included) and renders a bare {{driver}} as empty, so the name cannot
    // reach a customer through ANY template — saved, default, or hand-edited later.
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
    trackingUrl: trackingLink(pro, { src: 'track-email' }),
    // The same PAGE as trackingUrl — the star rating is a card ON the tracking page, not a
    // separate route — but no longer the same URL. Chad: "when they click that rate my
    // delivery in the email, it takes them directly to the tracking page with the rate my
    // delivery already opened up, ready to click on stars."
    //
    // It used to be byte-identical to trackingUrl, so nothing told the page WHY the customer
    // had come. The page renders the quote banner above the review card, so tapping "Rate my
    // delivery" landed them on an advert with the stars below the fold — on a phone, most
    // people never scroll to them.
    //
    // `rate=1` is that missing signal, and a query parameter rather than the '#review'
    // fragment this once carried: that fragment pointed at nothing (the page has no element
    // with the id, never reads location.hash, and renders itself by script into <div id="app">
    // AFTER load, so there is no anchor to jump to at parse time). A query parameter is read
    // by the page's own initFromUrl, which already parses `pro` the same way.
    //
    // Still its own merge field, so the button can be pointed straight at Google — or
    // anywhere else — from the Communications tab without touching this file.
    reviewUrl: trackingLink(pro, pro ? { rate: '1', src: 'review-email' } : { src: 'review-email' }),
    // The customer's own way off these emails. Signed, because a matchKey is derived from a
    // business's public name and address and would otherwise let anyone unsubscribe anyone.
    // Empty when no signing secret is configured, which is what makes the footer below fall
    // back to "reply to this email" rather than shipping a link that cannot work.
    unsubscribeUrl: unsubscribeUrl(usableMatchKey(stop) || '', SITE_ORIGIN, unsubSecret()),
    // ET, not the UTC runtime's year — otherwise a New Year's Eve send stamps next year.
    year: etDayString().slice(0, 4),
  };
}

/**
 * PURE. Guarantee the email carries a way off the list, whatever the template says.
 *
 * THE LIVE TEMPLATE LIVES IN FIRESTORE, edited from the Communications tab — DEFAULT_HTML
 * below is only the fallback. So adding an unsubscribe footer to the default would put it in
 * exactly zero real emails: the saved template wins, and the saved one predates this.
 *
 * A template that places {{unsubscribeUrl}} deliberately keeps control of where it sits.
 * Anything else gets this appended. The one thing that must not happen is a delivery email
 * going out with no way off it — that is the situation that made a customer reply
 * "unsubscribe" in words and wait for someone to notice.
 *
 * With no signing secret configured there is no working link, so it falls back to asking
 * them to reply — which is honest, and is what was already happening.
 */
export function withUnsubscribeFooter(html: string, url: string, replyTo?: string): string {
  const body = String(html || '');
  // BOTH FORMS. The template is rendered with escapeVars, so a template that places
  // {{unsubscribeUrl}} itself emits the ESCAPED url (& becomes &amp;) — comparing only the
  // raw one never matched, and the email went out with the template's link AND an appended
  // footer. Two unsubscribe links, in exactly the case this guard exists to prevent.
  if (url && (body.includes(url) || body.includes(escapeHtml(url)))) return body;
  if (/id="dds-unsub"/.test(body)) return body;             // already appended
  const inner = url
    ? `Don't want delivery emails? <a href="${url}" style="color:#5A6B7C;text-decoration:underline;">Unsubscribe</a>.`
    : `Don't want delivery emails? Reply to this message and we'll take you off the list.`;
  return `${body}
<table role="presentation" id="dds-unsub" width="100%" cellpadding="0" cellspacing="0" style="background:#EDF1F5;">
<tr><td align="center" style="padding:0 12px 26px;">
  <div style="max-width:600px;width:100%;font-family:'DM Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#7C8B9A;text-align:center;">
    You're getting this because we delivered freight to you.<br>${inner}
  </div>
</td></tr></table>`;
}

/**
 * The headers that put a native Unsubscribe button in Gmail and Outlook.
 *
 * List-Unsubscribe-Post is RFC 8058 one-click: the client POSTs and the customer is done,
 * with no page and no round trip. It is only honoured alongside an https URL, so it is
 * omitted entirely when there is no link to give.
 */
export function unsubscribeHeaders(url: string, replyTo?: string): Record<string, string> {
  const parts: string[] = [];
  if (url) parts.push(`<${url}>`);
  if (replyTo) parts.push(`<mailto:${replyTo}?subject=unsubscribe>`);
  if (!parts.length) return {};
  return {
    'List-Unsubscribe': parts.join(', '),
    ...(url ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}),
  };
}

/**
 * @param opts.neutralizeUnsubscribe  A [TEST] send is built from a REAL delivered stop and
 * goes to a Davis inbox. With a live footer, anyone in that inbox clicking Unsubscribe would
 * opt out an actual customer — and the confirmation page would show that customer's name
 * back to them. The test path passes true, so the footer renders the reply-to fallback
 * instead of a working link that suppresses somebody who never asked.
 */
export function buildMessage(
  stop: any, date: string, cfg: CommsConfig, opts: { neutralizeUnsubscribe?: boolean } = {},
): { subject: string; html: string; vars: Record<string, string> } {
  const vars = stopVars(stop, date);
  if (opts.neutralizeUnsubscribe) vars.unsubscribeUrl = '';
  const rendered = renderTemplate(cfg.htmlTemplate, escapeVars(vars));
  return {
    subject: normalizeSubject(renderTemplate(cfg.subjectTemplate, vars)),
    html: withUnsubscribeFooter(rendered, vars.unsubscribeUrl, cfg.replyTo),
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

/**
 * WHICH BOARD DATES ONE SCHEDULED RUN SWEEPS.
 *
 * Today, always. Plus YESTERDAY, but only in the early hours — and that second
 * date is not housekeeping, it is the difference between a customer getting
 * their email and never getting it.
 *
 * Freight delivered at 23:50 ET is written to YESTERDAY's board. By the time the
 * next run fires, etDayString() has already rolled to the new day, so a
 * today-only sweep would step straight over that delivery and never come back to
 * it — every late-evening customer silently dropped, on a feature whose entire
 * promise is that the email always arrives. isSweepableBoardDate already permits
 * yesterday for exactly this reason ("a scan running just after ET midnight
 * still writes yesterday's board"); this is the caller that uses that allowance.
 *
 * Bounded to the early window because the cost is a FULL board read per date per
 * run. Sweeping yesterday all day long would double the Firestore read volume
 * for ever, to catch stragglers that the first few runs after midnight have
 * already caught — and the ledger makes every pass after the first a no-op
 * anyway. Six hours is many runs' worth of margin on a boundary measured in
 * minutes.
 *
 * DST is a non-issue by construction: the schedule is an INTERVAL (every 30
 * minutes) rather than a fixed hour, so it does not care that ET is UTC-4 in
 * summer and UTC-5 in winter, and the window below is tested against ET itself
 * rather than against the cron clock. PURE → unit-tested.
 */
export const YESTERDAY_SWEEP_BEFORE_ET_HOUR = 6;

/** Yesterday, from a YYYY-MM-DD string. Self-contained so this module gains no
 *  new cross-module dependency for one line of arithmetic. */
export function dayBefore(ymd: string): string {
  // DATE_RE only pins the SHAPE, and a NaN check alone is not enough either:
  // '2026-13-45' is caught by it, but '2026-02-30' is NOT — V8 rolls that over to
  // March 2nd and reports success, so this would hand back a real-looking day one
  // side of the wrong month. That matters because the caller below uses ±1 day as
  // the duplicate-send guard; a silently shifted neighbour checks the wrong ledger.
  // parseYmd makes the date spell itself back. (An unchecked throw would also take
  // down a whole sweep, since sweepDates runs before the per-date try/catch.)
  const d = parseYmd(ymd);
  if (!d) return '';
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Tomorrow, from a YYYY-MM-DD string. Same strict round-trip rule as dayBefore. */
export function dayAfter(ymd: string): string {
  const d = parseYmd(ymd);
  if (!d) return '';
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function sweepDates(now: Date = new Date()): string[] {
  const today = etDayString(now);
  const hour = Number(etHourString(now));
  if (!Number.isFinite(hour) || hour >= YESTERDAY_SWEEP_BEFORE_ET_HOUR) return [today];
  const y = dayBefore(today);
  // Newest first: if a run is ever cut short, the day that matters most is done.
  return y ? [today, y] : [today];
}

// ── SEND-LOG RANGES + ROLLUPS ────────────────────────────────────────────────
//
// The ledger is already stored one subcollection PER DAY, so the history has always been
// day-shaped underneath. What the log endpoint did with it was flatten every day into one
// list sorted by time — Chad, Aug 2026: "needs to be done by the day and have ranges and
// months, not just a long compilation of all the emails that we've sent."
//
// These turn a request into an explicit set of dates, and a set of entries back into
// per-day and per-month rollups. All PURE → unit-tested. Reading Firestore stays in the
// endpoint; deciding WHICH days to read, and what the totals are, lives here.

export const MONTH_RE = /^\d{4}-\d{2}$/;

/** Every day costs two Firestore reads (the ledger list + the status doc), so a range is
 *  bounded. A quarter is the most a page load may spend; anything longer is CLIPPED and
 *  says so — a silently shortened range reads as "that month was quiet" when it was
 *  simply never looked at. */
export const MAX_LOG_DAYS = 92;

/**
 * A YYYY-MM-DD as a real Date, or null.
 *
 * Stricter than the validate-the-parse rule used elsewhere in this file, because that rule
 * has a hole my own tests found: `new Date('2026-02-30T00:00:00Z')` does NOT return Invalid
 * Date — V8 ROLLS IT OVER to March 2nd and reports success. So '2026-02-30' would sail
 * through both DATE_RE (right shape) and a NaN check (parsed fine) and silently become a
 * different day, which for a date RANGE means quietly reading the wrong days and showing
 * the answer as though it were the one asked for. '2026-13-45' is caught by the NaN check;
 * '2026-02-30' is only caught by asking the parsed date to spell itself back.
 */
export function parseYmd(ymd: string): Date | null {
  const v = String(ymd || '');
  if (!DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === v ? d : null;
}

/** A calendar month as [first, last]. Returns null on anything that is not YYYY-MM, and
 *  validates the PARSE, not just the shape — '2026-13' matches the pattern and is not a
 *  month, and Date#toISOString throws on it rather than returning something wrong. */
export function monthRange(month: string): { from: string; to: string } | null {
  if (!MONTH_RE.test(String(month || ''))) return null;
  const first = parseYmd(`${month}-01`);
  if (!first) return null;
  const last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1);
  last.setUTCDate(0);                       // day 0 of next month = last day of this one
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** The days from `from` to `to` inclusive, NEWEST FIRST, bounded by MAX_LOG_DAYS.
 *  Reversed bounds are accepted and swapped rather than returning nothing: a from/to the
 *  wrong way round is a slip, and an empty log is a bad way to report it. */
export function datesInRange(from: string, to: string, cap = MAX_LOG_DAYS):
  { dates: string[]; requested: number; clipped: boolean; from: string; to: string } {
  const empty = { dates: [] as string[], requested: 0, clipped: false, from: '', to: '' };
  let a = parseYmd(from), b = parseYmd(to);
  if (!a || !b) return empty;
  if (a.getTime() > b.getTime()) { const t = a; a = b; b = t; }

  const requested = Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
  const take = Math.min(requested, Math.max(1, cap));
  const dates: string[] = [];
  // Walk BACK from the newest day, so a clipped range keeps the most recent days —
  // the ones somebody looking at a send log is nearly always asking about.
  for (let i = 0; i < take; i++) {
    dates.push(new Date(b.getTime() - i * 86400000).toISOString().slice(0, 10));
  }
  return {
    dates,
    requested,
    clipped: requested > take,
    from: dates[dates.length - 1] || '',
    to: dates[0] || '',
  };
}

export interface LogRange {
  mode: 'date' | 'month' | 'range' | 'days';
  dates: string[]; from: string; to: string; requested: number; clipped: boolean;
}

/**
 * Turn the query string into the days to read. Precedence is most-specific first:
 * an exact ?date=, then ?month=, then ?from=/?to=, then ?days= back from today.
 *
 * `today` is passed in rather than read here so the whole thing stays pure.
 */
export function resolveLogRange(
  params: { date?: string; month?: string; from?: string; to?: string; days?: number | string },
  today: string,
): LogRange {
  const none: LogRange = { mode: 'days', dates: [], from: '', to: '', requested: 0, clipped: false };
  // Shape is not enough: '2026-13-45' matches DATE_RE, and every branch below does date
  // arithmetic on this anchor — an unreal one throws out of toISOString rather than
  // returning something wrong.
  const anchorDate = parseYmd(today);
  if (!anchorDate) return none;
  const anchor = today;

  const date = String(params.date || '');
  if (DATE_RE.test(date)) {
    const r = datesInRange(date, date);
    return { mode: 'date', ...r };
  }

  const month = String(params.month || '');
  if (MONTH_RE.test(month)) {
    const m = monthRange(month);
    if (m) {
      // A month that has not finished yet stops at TODAY. Listing tomorrow's empty days
      // as zero-send rows invites reading them as days the sweep skipped.
      const to = m.to > anchor ? anchor : m.to;
      // Asking for a month that has not started yet is empty, not the whole month.
      if (m.from > anchor) return { mode: 'month', dates: [], from: m.from, to: m.from, requested: 0, clipped: false };
      return { mode: 'month', ...datesInRange(m.from, to) };
    }
  }

  const from = String(params.from || ''), to = String(params.to || '');
  if (DATE_RE.test(from) || DATE_RE.test(to)) {
    // One end given is a half-open range: from X to today, or the single day X.
    const a = DATE_RE.test(from) ? from : to;
    const b = DATE_RE.test(to) ? to : anchor;
    return { mode: 'range', ...datesInRange(a, b) };
  }

  const n = Math.min(Math.max(Math.floor(Number(params.days) || 1), 1), MAX_LOG_DAYS);
  const first = anchorDate.getTime() - (n - 1) * 86400000;
  return { mode: 'days', ...datesInRange(new Date(first).toISOString().slice(0, 10), anchor) };
}

export interface DayRollup {
  date: string; total: number; sent: number; failed: number; inflight: number;
}

/** Count one bucket of entries. The three outcomes are the same split the endpoint's
 *  totals use: `ok` sent, claimed-but-never-confirmed `inflight` (NOT safe to retry),
 *  and everything else failed. */
export function tallyEntries(entries: any[]): { total: number; sent: number; failed: number; inflight: number } {
  let sent = 0, failed = 0, inflight = 0;
  for (const e of entries || []) {
    if (e?.ok) sent++;
    else if (e?.claimed) inflight++;
    else failed++;
  }
  return { total: (entries || []).length, sent, failed, inflight };
}

/** Per-day rows, newest first. `dates` drives the shape rather than the entries, so a day
 *  that was READ and had nothing still gets a zero row — "we looked and it was quiet" is
 *  a different answer from "that day is not in this range", and the log has to tell them
 *  apart. */
export function rollupByDay(dates: string[], entries: any[]): DayRollup[] {
  const byDate = new Map<string, any[]>();
  for (const d of dates) byDate.set(d, []);
  for (const e of entries || []) {
    const d = String(e?.date || '');
    if (byDate.has(d)) byDate.get(d)!.push(e);
  }
  return [...byDate.entries()]
    .map(([date, es]) => ({ date, ...tallyEntries(es) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export interface MonthRollup extends DayRollup { month: string; days: number; }

/** Per-month rows, newest first, summed from the day rows so the two can never disagree.
 *  `days` counts days actually READ in that month, not the length of the month. */
export function rollupByMonth(days: DayRollup[]): MonthRollup[] {
  const byMonth = new Map<string, MonthRollup>();
  for (const d of days || []) {
    const m = String(d.date || '').slice(0, 7);
    if (!MONTH_RE.test(m)) continue;
    const cur = byMonth.get(m) || { month: m, date: m, days: 0, total: 0, sent: 0, failed: 0, inflight: 0 };
    cur.days++; cur.total += d.total; cur.sent += d.sent; cur.failed += d.failed; cur.inflight += d.inflight;
    byMonth.set(m, cur);
  }
  return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
}

/** The months worth offering in a picker: this month back through `count-1` earlier ones. */
export function recentMonths(today: string, count = 12): string[] {
  const d = parseYmd(today);
  if (!d) return [];
  const out: string[] = [];
  d.setUTCDate(1);
  for (let i = 0; i < Math.max(1, count); i++) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
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
  /** Has this key already been sent under some OTHER board date? In the seam with the rest
   *  of the trio because it is now part of the same property they exist to protect — one
   *  email per PRO ever — and a guard against double-sending that cannot itself be tested
   *  is not much of a guard. */
  priorSend: (date: string, key: string) => Promise<any>;
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
/**
 * Too fast, not broken. A 429 means the request was refused for pace alone — nothing was
 * queued, the claim is released, and the same customer is sent on the next attempt. It must
 * NOT count toward the failure circuit: five of these in a row is a busy minute, not an
 * outage, and halting a healthy run on it is how a day's mail ends up hours late.
 */
export function isRateLimited(error?: string): boolean {
  return /^Resend HTTP 429/.test(String(error || ''));
}

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
    send: sendEmail, recipient: resolveRecipient,
    priorSend: (dt, k) => getDoc(sentDoc(dt, k)),
    ...(opts.deps || {}),
  };
  const cfg = opts.cfg || (await readConfig());
  const pro = String(stop?.pro || stop?.primaryPro || stop?.stopNbr || '');
  const key = ledgerKey(stop);
  if (!key) return { pro, skipped: 'no_stop_nbr' };
  if (!cfg.enabled && !opts.force) return { pro, key, skipped: 'disabled' };
  if (!emailEnabled()) return { pro, key, skipped: 'email_not_configured' };

  const status = String(stop?.normalizedStatus || '').toUpperCase();
  // The SAME predicate the sweep filters on, so the two can never drift apart — this is the
  // last gate before a customer is emailed, and it must not be the more permissive one.
  if (!isCustomerDelivery(stop) && !opts.force) {
    const why = status === 'DELIVERED' ? 'pickup_not_delivery' : `not_delivered(${status || 'unknown'})`;
    return { pro, key, skipped: why };
  }
  if (isStaleDelivery(stop, date) && !opts.force) return { pro, key, skipped: 'stale_delivery' };

  let to = opts.toOverride || '';
  let customerName = String(stop?.businessName || '');
  if (!to) {
    const r = await d.recipient(stop);
    if (r.optedOut) return { pro, key, skipped: 'opted_out' };
    // Not "no notes" — notes UNREADABLE. The opt-out lives in that document, so sending now
    // would be sending in ignorance of it. Declining costs this customer a delayed email;
    // the next sweep retries and the ledger has no claim, so nothing is lost permanently.
    if (r.notesUnavailable) return { pro, key, skipped: 'notes_unavailable' };
    if (!r.email) return { pro, key, skipped: 'no_email_on_file' };
    to = r.email;
    if (r.name) customerName = String(r.name);
  }
  if (!isEmailAddress(to)) return { pro, key, skipped: 'bad_recipient' };

  const { subject, html, vars } = buildMessage(stop, date, cfg);

  // CLAIM, ATOMICALLY, BEFORE SENDING. The precondition is evaluated inside Firestore's
  // commit, so two overlapping sweeps cannot both win it. A claim that cannot be written
  // is not a reason to send anyway — it is the reason NOT to, because without a durable
  // claim nothing stops the next sweep sending the same email again.
  // ── ALREADY EMAILED ON A NEIGHBOURING BOARD DATE? ────────────────────────
  // The ledger is per board date (nuvizz_ops/customer_comms_<date>/sent), so the atomic
  // claim below only makes this stop unique WITHIN one date. The promise on the tin, and
  // the one printed on the screen, is one email per PRO EVER.
  //
  // Those differ the moment a delivered stop appears on two board dates — a rolled-forward
  // or re-dated row, which this module already knows happens (it is what isStaleDelivery
  // exists for, and that guard's two-day tolerance lets a one-day shift straight through).
  // The stop is then claimed once under each date and the customer is emailed twice about
  // the same freight. The early-hours yesterday sweep makes that a routine path rather than
  // a rare one.
  //
  // ledgerKey is stable across dates by construction (normalised stopNbr, de-zeroed), so
  // the neighbouring days can be checked directly. ±1 day only: that is the whole window
  // isSweepableBoardDate will ever hand us, so a wider search would read documents that
  // cannot exist. Costs one getDoc per neighbour per stop, and only for stops that got
  // past every cheaper skip above.
  //
  // Fails CLOSED, like every other read on this path: if we cannot tell whether we already
  // emailed this customer, we do not email them again.
  for (const neighbour of [dayBefore(date), dayAfter(date)]) {
    if (!neighbour) continue;
    let prior: any;
    try {
      prior = await d.priorSend(neighbour, key);
    } catch (e: any) {
      console.warn(`[customer-comms] neighbour ledger read failed for ${key} on ${neighbour}: ${e?.message}`);
      return { pro, key, skipped: 'neighbour_ledger_unavailable' };
    }
    // A RELEASED claim leaves no document, so only a real prior send is found here.
    if (prior) return { pro, key, skipped: 'already_sent_other_date' };
  }

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

  const res = await d.send({
    to, subject, html, replyTo: cfg.replyTo, from: cfg.fromAddress || undefined,
    // Puts Gmail's and Outlook's own Unsubscribe control on the message — one click, no page.
    // The mailto: fallback is what a customer replying "unsubscribe" in words was already
    // doing by hand; naming it in the header at least routes it somewhere deliberate.
    headers: unsubscribeHeaders(vars.unsubscribeUrl, cfg.replyTo),
  });

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

/** How many SENDS between re-reads of the program switch mid-sweep. See the abort check in
 *  sweepDelivered: small enough that "switch off to stop it" is true in practice, large
 *  enough that the extra config reads are a rounding error beside the sends themselves. */
export const ABORT_POLL_EVERY = 25;

/**
 * PACING. Sends are issued one at a time in a plain loop, and the first live run measured
 * 25 emails in 12.5 seconds — 2.0/second, which is exactly Resend's documented default
 * rate limit. It succeeded, so the limit is at least that; running AT a ceiling is not the
 * same as running under one.
 *
 * This is a floor on the interval between send STARTS, not a sleep added to each send. A
 * send already takes ~500ms of its own round trips, so on a healthy run this adds ~100ms
 * and the wall-clock barely moves; it only really bites when Resend is answering fast
 * enough that we would otherwise outrun it. That matters because the run has a finite
 * budget of wall-clock too (a Netlify background function is bounded), so a fixed sleep per
 * send would be the wrong shape entirely — it would tax the slow case that needs no taxing.
 */
export const MIN_SEND_INTERVAL_MS = 600;

/** After a 429, how long to hold off before the next attempt. */
export const RATE_LIMIT_BACKOFF_MS = 2000;

export interface SweepResult {
  ran: boolean; sent: number; failed: number;
  skipped: Record<string, number>;
  capped?: boolean; circuitOpen?: boolean; reason?: string;
  /** The program switch was turned off while this sweep was running, and it stopped. */
  abandoned?: boolean;
}

export async function sweepDelivered(
  stops: any[],
  date: string = etDayString(),
  opts: { today?: string; budgetCeiling?: number } = {},
): Promise<SweepResult> {
  const skipped: Record<string, number> = {};
  const bump = (k: string, n = 1) => { skipped[k] = (skipped[k] || 0) + n; };
  const all = Array.isArray(stops) ? stops : [];

  if (!isSweepableBoardDate(date, opts.today || etDayString())) {
    await writeSweepStatus(date, { considered: 0, sent: 0, failed: 0, reason: 'stale_board_date' });
    return { ran: false, sent: 0, failed: 0, skipped: {}, reason: 'stale_board_date' };
  }

  const cfg = await readConfig();
  // NOT recorded: `disabled` is the steady state forty-eight times a day while the program
  // is off, and writing a document each time would bury the days that matter under noise.
  // It is also the one outcome nobody needs a record of — the switch itself says so.
  if (!cfg.enabled) return { ran: false, sent: 0, failed: 0, skipped: {}, reason: 'disabled' };
  if (!emailEnabled()) {
    // Switched ON but unable to send: exactly the state that must never look like a quiet day.
    await writeSweepStatus(date, { considered: 0, sent: 0, failed: 0, reason: 'email_not_configured' });
    return { ran: false, sent: 0, failed: 0, skipped: {}, reason: 'email_not_configured' };
  }

  // Count only what this feature is about. Reporting the whole ~600-stop board as
  // "skipped" buries the handful of numbers anyone actually reads.
  // isCustomerDelivery, not a bare status check: a completed PICKUP is also DELIVERED, and
  // emailing the shipper "your delivery is complete" when we have just collected the freight
  // is wrong on its face. See isCustomerDelivery.
  const delivered = all.filter(isCustomerDelivery);
  if (!delivered.length) {
    // Nothing to do, and no reason to spend a ledger read finding that out. Future board
    // dates hit this on every scan.
    await writeSweepStatus(date, { considered: 0, sent: 0, failed: 0, reason: 'no_delivered_stops' });
    return { ran: true, sent: 0, failed: 0, skipped: {}, reason: 'no_delivered_stops' };
  }

  // Fail CLOSED on an unreadable ledger. An empty read that really meant "Firestore is
  // down" would look exactly like "nobody has been emailed yet" and re-send the day.
  let already: number;
  try {
    already = Object.keys(await readLedger(date)).length;
  } catch (e: any) {
    console.warn(`[customer-comms] ledger read failed for ${date}: ${e?.message}`);
    await writeSweepStatus(date, { considered: delivered.length, sent: 0, failed: 0, reason: 'ledger_unavailable', errors: [String(e?.message || e)] });
    return { ran: false, sent: 0, failed: 0, skipped: {}, reason: 'ledger_unavailable' };
  }

  // THE CAP IS PER BOARD DATE; THE PROMISE IS PER DAY. The ledger lives under
  // customer_comms_<date>, so each date starts with its own full budget — and between
  // 00:00 and 06:00 ET this sweep runs TWO dates. A cap of 1000 could therefore put out
  // 2000 emails inside one calendar day, while the enable dialog says "up to 1000 a day".
  // The caller passes what is left of the run's allowance so the two dates share one
  // ceiling, and the number on the screen is the number that can actually be sent.
  let budget = Math.max(0, cfg.dailyCap - already);
  if (typeof opts.budgetCeiling === 'number') budget = Math.min(budget, Math.max(0, opts.budgetCeiling));
  if (budget <= 0) {
    await writeSweepStatus(date, { considered: delivered.length, sent: 0, failed: 0, capped: true, skipped: { daily_cap: delivered.length } });
    return { ran: true, sent: 0, failed: 0, skipped: { daily_cap: delivered.length }, capped: true };
  }

  let sent = 0, failed = 0, consecutiveFailures = 0, circuitOpen = false, abandoned = false;
  let lastSendStart = 0;
  let paceMs = MIN_SEND_INTERVAL_MS;
  let rateLimited = 0;
  const errors: string[] = [];
  let checked = 0;
  for (const stop of delivered) {
    if (budget <= 0) { bump('daily_cap'); continue; }
    if (circuitOpen) { bump('circuit_open'); continue; }
    if (abandoned) { bump('switched_off'); continue; }

    // THE OFF SWITCH HAS TO ACTUALLY STOP IT. cfg is read once, before the loop, so a sweep
    // of several hundred stops runs for minutes on a snapshot of the config. Someone
    // watching the first wrong email land and diving for the switch would have changed
    // nothing — the run in flight keeps going to the end of the board. Both the confirm
    // dialog and the red LIVE banner promise "switch off to stop it", so this is the code
    // owing the UI a guarantee it already made on its behalf.
    //
    // Re-read every ABORT_POLL_EVERY sends: one small document per 25 emails is nothing
    // beside a send, and it bounds how much mail an abandoned run can still put out.
    // Checked on SENDS rather than on stops, so a board of skips costs no extra reads.
    if (checked >= ABORT_POLL_EVERY) {
      checked = 0;
      // An unreadable config does NOT abort — that would let a Firestore blip halt a healthy
      // run mid-board. The pre-loop read already established consent; this only looks for a
      // deliberate withdrawal of it.
      const live = await readConfig().catch(() => null);
      if (live && !live.enabled) {
        abandoned = true;
        console.warn(`[customer-comms] program switched OFF mid-sweep on ${date} — stopping after ${sent} sent`);
        bump('switched_off');
        continue;
      }
    }

    // Hold the pace. Measured from the last send START, so a slow send pays nothing extra.
    if (lastSendStart) {
      const wait = (lastSendStart + paceMs) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    lastSendStart = Date.now();

    try {
      const r = await sendForStop(stop, date, { cfg });
      if (r.skipped) { bump(r.skipped); continue; }
      if (r.ok) {
        sent++; budget--; checked++; consecutiveFailures = 0;
      } else if (isRateLimited(r.error)) {
        // Refused for pace. The claim was released, so this customer is not lost — they are
        // simply reached on the next pass. Slow down for the rest of the run rather than
        // spending a circuit-breaker life on it.
        failed++;
        rateLimited++;
        paceMs = Math.min(paceMs * 2, 5000);
        if (errors.length < 5 && r.error) errors.push(`${r.key}: ${r.error}`);
        await new Promise((r2) => setTimeout(r2, RATE_LIMIT_BACKOFF_MS));
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

  await writeSweepStatus(date, { considered: delivered.length, sent, failed, capped: budget <= 0, circuitOpen, abandoned, skipped, errors, ...(rateLimited ? { rateLimited } : {}) });
  return { ran: true, sent, failed, skipped, capped: budget <= 0, circuitOpen, abandoned, ...(rateLimited ? { rateLimited } : {}) };
}

/**
 * The per-day status snapshot, so this feature can never be an INVISIBLE no-op — the same
 * diagnostic cs-notify keeps, for the same reason. Without it a day where all 600 stops
 * skipped `no_email_on_file` reads identically to a day the sweep never ran. Best-effort.
 */
// EVERY OUTCOME EXCEPT `disabled` WRITES ONE OF THESE. Five exits used to write nothing at
// all, which made a sweep that could not run byte-for-byte identical to a day with nothing
// to do: silence either way. That is precisely the confusion this document exists to
// prevent, so the early returns now record their reason too. `disabled` is excluded on
// purpose — it is the steady state while the switch is off, and 48 documents a day saying
// "off" would bury the ones that matter.
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
// THE MASTHEAD. The URL this template originally shipped with,
// tracking.davisdelivery.com/logo.png, is a 404 — that site serves no static assets at all
// (its favicon 404s too; it is a pure SPA that renders everything into <div id="app">), so
// every send would have opened with a broken image.
//
// The logo now comes from public/davis-logo-email.png on THIS app's own site, which is the
// only Davis host we control that actually serves files today (map./dispatch. do not
// resolve). It is the real mark, white-margin trimmed and rebuilt for email: 520×167 so it
// stays sharp at the 260px it displays, and 24 KB rather than the 129 KB of the full-size
// original. The band behind it is WHITE because the mark is blue-on-white — on the navy
// band it would have been a white rectangle.
//
// The alt text is the fallback, not an afterthought: Outlook and Gmail block remote images
// by default, so a good share of recipients see only that string on first open. It names the
// company and the tagline, and the font/colour styles on the <img> are what those clients
// apply when rendering it.
//
// TO MOVE IT to a branded URL later, swap the src from the Communications tab — htmlTemplate
// lives in Firestore, so it needs no redeploy.
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
  <tr><td style="background:#ffffff;padding:22px 32px 18px;border-bottom:1px solid #E4EAF0;">
    <img src="https://dd-dispatch-map.netlify.app/davis-logo-email.png" width="260" height="84" alt="Davis Delivery Service — family owned since 1985" style="display:block;border:0;width:260px;max-width:100%;height:auto;color:#123A63;font-family:'DM Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:17px;font-weight:700;">
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
        <div style="font-size:14px;color:#6B5A3E;line-height:1.6;padding:8px 0 16px;">Tap a star on your tracking page — it takes about thirty seconds, and it helps a family-owned business more than you'd think.</div>
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
