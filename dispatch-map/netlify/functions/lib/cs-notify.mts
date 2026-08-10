// lib/cs-notify.mts
//
// "Email customer service when a marked customer is scheduled." A customer is
// "marked" by the per-customer notify_cs flag in customer_notes (set in the map's
// notes editor). When the scan finds such a customer on a day's board, CS gets ONE
// email per customer per delivery date — the FIRST time that customer appears in a
// scan that day. Dedup is persisted so the ~15-min scans never re-send.
//
// Wired into refresh-stops-core after each date's stops are written. Fully
// best-effort: any failure here is logged and swallowed, never breaking a scan.
//
// Env: RESEND_API_KEY + RESEND_FROM (sender) and NOTIFY_CS_TO (recipient[s],
// comma-separated). If any are unset the feature is a no-op.

import { getDoc, setDoc, runQuery } from './firestore.mts';
import { normalizeMatchKey } from './match-key.mts';
import { emailEnabled, sendEmail } from './email.mts';

const OPS_COLLECTION = 'nuvizz_ops';

// In-process cache of the opted-in match_key set (a scan touches today+tomorrow,
// so this avoids re-querying within one invocation). Short TTL so toggles in the
// UI take effect within a minute on a warm instance.
let __markedCache: { at: number; set: Map<string, string> } | null = null;
const MARKED_TTL_MS = 60_000;

async function loadMarkedCustomers(): Promise<Map<string, string>> {
  if (__markedCache && Date.now() - __markedCache.at < MARKED_TTL_MS) return __markedCache.set;
  const rows = await runQuery({
    from: [{ collectionId: 'customer_notes' }],
    where: { fieldFilter: { field: { fieldPath: 'notify_cs' }, op: 'EQUAL', value: { booleanValue: true } } },
  });
  // Map match_key (doc id) → display name (best-effort).
  const set = new Map<string, string>();
  for (const r of rows) set.set(String(r._id), r.raw_name || '');
  __markedCache = { at: Date.now(), set };
  return set;
}

// If NOTIFY_CS_TO is unset, fall back to the company CS inbox instead of silently disabling the
// whole feature — a missing env var used to make every scheduled scan a no-op (nowhere to send).
// The env var still WINS when set (comma-separated for multiple recipients).
export const CS_DEFAULT_TO = 'customerservice@davisdelivery.com';
export function csRecipients(): string[] {
  const raw = String(process.env.NOTIFY_CS_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : [CS_DEFAULT_TO];
}

// ── WHICH DAYS GET A NOTIFY PASS ─────────────────────────────────────────────
//
// Chad, 8/10: "DSV came in on Friday. The moment the scan picked it up on Friday,
// it should have sent the email. Why is it sending the email today? It's too late."
//
// The email used to ride the scan's WRITE targets — today plus the next 1-2 business
// days, and those future days are only added from 10:00 ET (the scanTomorrow* gate in
// scan-schedule). So a marked customer whose delivery date sat outside that narrow
// horizon could not be reported at all, however many scans had already SEEN the order:
// an order landing Friday for Tuesday waited until Monday's first post-10am scan.
//
// The rows were already in hand. The active saved search is a ±7d pull and the scan
// buckets EVERY date in it, so notifying the rest of the pull costs ZERO extra NuVizz
// calls — it is the same data, previously discarded. This picks the days the write
// loop did not already cover: forward-looking only (a past day's board is history),
// bounded by the pull's own reach so a stray far-future row can't spray emails.
//
// PURE → unit-tested in test/cs-notify-window.test.mjs.
export const NOTIFY_PULL_HORIZON_DAYS = 7;

export function pendingNotifyDates(
  pullDates: Iterable<string>,
  today: string,
  alreadyNotified: Iterable<string> = [],
  horizonDays: number = NOTIFY_PULL_HORIZON_DAYS,
): string[] {
  const done = new Set<string>();
  for (const d of alreadyNotified) if (d) done.add(String(d));
  const last = new Date(Date.parse(today + 'T00:00:00Z') + Math.max(0, horizonDays) * 86400000)
    .toISOString().slice(0, 10);
  const out = new Set<string>();
  for (const raw of pullDates) {
    const d = String(raw || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;   // junk key → never a notify day
    if (d < today || d > last) continue;            // past is history; beyond the pull is noise
    if (done.has(d)) continue;                      // the write loop already notified this day
    out.add(d);
  }
  return [...out].sort();
}

// ── THE LEDGER ───────────────────────────────────────────────────────────────
//
// nuvizz_ops/cs_notify__<deliveryDate> records what has already gone out for that
// delivery date, on TWO axes:
//
//   notified[matchKey]   — the customer. One email per marked customer per date,
//                          whichever of their orders triggered it.
//   notifiedStops[nbr]   — the order. Needed because the same stop is now seen in
//                          two shapes: as a raw saved-search row (the early pass,
//                          which fires the moment the order appears in a pull) and
//                          again on its write day, after enrichment has replaced the
//                          address with the /stop/info version. If those two texts
//                          normalize to even slightly different match keys — a
//                          "STE 200" that becomes "Suite 200", an ATTN line that
//                          moves — the customer axis alone would not recognise the
//                          second sighting and CS would get the same order twice.
//
// PURE → unit-tested. Either axis matching means "already sent".
export interface NotifyLedger { notified?: Record<string, string>; notifiedStops?: Record<string, string> }

export function alreadySent(ledger: NotifyLedger | null | undefined, matchKey: string, stopNbr: any): boolean {
  if (!ledger) return false;
  if (matchKey && ledger.notified?.[matchKey]) return true;
  const nbr = String(stopNbr ?? '').trim();
  return !!(nbr && ledger.notifiedStops?.[nbr]);
}

export function buildEmail(stop: any, date: string): { subject: string; text: string; html: string } {
  const name = stop.businessName || '(unknown customer)';
  const addr = [stop.addr1, stop.addr2, stop.city, stop.state, stop.zip].filter(Boolean).join(', ');
  const pro = stop.primaryPro || stop.pro || (Array.isArray(stop.pros) ? stop.pros[0] : null) || '—';
  const load = stop.routeName || stop.loadNbr || '—';
  const driver = stop.driverName || '—';
  const lines = [
    `Marked customer scheduled for delivery on ${date}:`,
    '',
    `Customer: ${name}`,
    `Address:  ${addr || '—'}`,
    `PRO:      ${pro}`,
    `Load:     ${load}`,
    `Driver:   ${driver}`,
    `Stop #:   ${stop.stopNbr || '—'}`,
    '',
    'This is an automated notification from Dispatch Map. Do not reply.',
  ];
  const text = lines.join('\n');
  const html = `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;color:#0f172a">
    <p style="margin:0 0 12px">Marked customer scheduled for delivery on <b>${date}</b>:</p>
    <table style="border-collapse:collapse">
      <tr><td style="padding:2px 12px 2px 0;color:#64748b">Customer</td><td><b>${name}</b></td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#64748b">Address</td><td>${addr || '—'}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#64748b">PRO</td><td>${pro}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#64748b">Load</td><td>${load}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#64748b">Driver</td><td>${driver}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#64748b">Stop #</td><td>${stop.stopNbr || '—'}</td></tr>
    </table>
    <p style="margin:12px 0 0;color:#94a3b8;font-size:12px">Automated notification from Dispatch Map — do not reply.</p>
  </div>`;
  return { subject: `Scheduled ${date}: ${name}`, text, html };
}

// Cross-reference one date's scanned stops against the opted-in customers and
// email CS for any first-seen-today. Returns a small summary for the scan log.
export async function notifyMarkedCustomers(
  date: string,
  stops: any[],
  opts: { statusWhenIdle?: boolean } = {},
): Promise<{ skipped?: string; matched: number; sent: number; failed: number }> {
  const to = csRecipients();
  const marked = await loadMarkedCustomers();

  // First scanned stop per opted-in match_key (dedupe within this batch).
  const hits = new Map<string, any>();
  for (const s of stops || []) {
    if (!s) continue;
    const key = normalizeMatchKey(s.businessName, s.addr1, s.city, s.zip);
    if (marked.has(key) && !hits.has(key)) hits.set(key, s);
  }

  let sent = 0, failed = 0;
  let skipped: string | undefined;
  if (!emailEnabled()) {
    skipped = 'email_disabled';   // RESEND_API_KEY / RESEND_FROM not set — nothing can send
  } else if (hits.size) {
    // Dedup doc: which match_keys have already been emailed for THIS delivery date.
    const docPath = `${OPS_COLLECTION}/cs_notify__${date}`;
    const doc = (await getDoc(docPath)) as any;
    const notified: Record<string, string> = (doc && typeof doc.notified === 'object' && doc.notified) || {};
    // Second axis — the stop NUMBER. See alreadySent above for why the customer key
    // alone is not enough once the same order can be seen un-enriched and enriched.
    const notifiedStops: Record<string, string> = (doc && typeof doc.notifiedStops === 'object' && doc.notifiedStops) || {};
    let changed = false;
    for (const [key, stop] of hits) {
      const nbr = String(stop?.stopNbr ?? '').trim();
      if (alreadySent({ notified, notifiedStops }, key, nbr)) continue; // already emailed today
      // Re-check the ledger right before each send: a manual "Scan now" overlapping the
      // scheduled scan used to read the doc once up front, so both invocations saw an
      // empty ledger and CS got the same email twice. A fresh read narrows that window
      // to a single in-flight send, and the per-send write below closes it for the rest
      // of the batch (before: the ledger was only written after ALL sends, so a mid-loop
      // crash also re-sent everything on the next scan).
      try {
        const liveDoc = (await getDoc(docPath)) as any;
        const liveNotified = (liveDoc && typeof liveDoc.notified === 'object' && liveDoc.notified) || {};
        const liveStops = (liveDoc && typeof liveDoc.notifiedStops === 'object' && liveDoc.notifiedStops) || {};
        Object.assign(notified, liveNotified);
        Object.assign(notifiedStops, liveStops);
        if (alreadySent({ notified, notifiedStops }, key, nbr)) continue;
      } catch { /* ledger read is best-effort — proceed on the snapshot */ }
      const { subject, text, html } = buildEmail(stop, date);
      const res = await sendEmail({ to, subject, text, html });
      if (res.ok) {
        const at = new Date().toISOString();
        notified[key] = at; if (nbr) notifiedStops[nbr] = at;
        changed = true; sent++;
        try { await setDoc(docPath, { notified, notifiedStops, updated_at: at, date }); }
        catch (e: any) { console.warn(`[cs-notify] dedup write failed after ${key}: ${e?.message}`); }
      } else { failed++; console.warn(`[cs-notify] send failed for ${key}: ${res.error}`); }
    }
    if (changed) {
      try { await setDoc(docPath, { notified, notifiedStops, updated_at: new Date().toISOString(), date }); }
      catch (e: any) { console.warn(`[cs-notify] dedup write failed: ${e?.message}`); }
    }
  }

  // Status snapshot so the feature can never be an INVISIBLE no-op again. Read
  // nuvizz_ops/cs_notify_status__<date> to diagnose: marked=0 → nobody has the flag on;
  // matched=0 while marked>0 → the customer's match-key drifted (NuVizz returned a slightly
  // different name/address than when the flag was set); sent>0 → it's working. Best-effort.
  //
  // statusWhenIdle:false is for the early pass over the rest of the pull — it sweeps ~5 extra
  // days on every scan, and stamping a "nothing here" doc for each of them, every 30 minutes,
  // would be several hundred pointless writes a day. Those days still get a status doc the
  // moment they actually match a marked customer, and the real board days (the write targets)
  // keep stamping unconditionally, so the diagnostic Chad relies on is unchanged.
  if (opts.statusWhenIdle === false && !hits.size) return { skipped, matched: 0, sent, failed };
  try {
    await setDoc(`${OPS_COLLECTION}/cs_notify_status__${date}`, {
      date, at: new Date().toISOString(), recipients: to,
      marked: marked.size, matched: hits.size, sent, failed, skipped: skipped || null,
    });
  } catch (e: any) { console.warn(`[cs-notify] status write failed: ${e?.message}`); }

  return { skipped, matched: hits.size, sent, failed };
}
