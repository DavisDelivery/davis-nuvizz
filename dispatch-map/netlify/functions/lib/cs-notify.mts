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
    let changed = false;
    for (const [key, stop] of hits) {
      if (notified[key]) continue; // already emailed today
      const { subject, text, html } = buildEmail(stop, date);
      const res = await sendEmail({ to, subject, text, html });
      if (res.ok) { notified[key] = new Date().toISOString(); changed = true; sent++; }
      else { failed++; console.warn(`[cs-notify] send failed for ${key}: ${res.error}`); }
    }
    if (changed) {
      try { await setDoc(docPath, { notified, updated_at: new Date().toISOString(), date }); }
      catch (e: any) { console.warn(`[cs-notify] dedup write failed: ${e?.message}`); }
    }
  }

  // Status snapshot so the feature can never be an INVISIBLE no-op again. Read
  // nuvizz_ops/cs_notify_status__<date> to diagnose: marked=0 → nobody has the flag on;
  // matched=0 while marked>0 → the customer's match-key drifted (NuVizz returned a slightly
  // different name/address than when the flag was set); sent>0 → it's working. Best-effort.
  try {
    await setDoc(`${OPS_COLLECTION}/cs_notify_status__${date}`, {
      date, at: new Date().toISOString(), recipients: to,
      marked: marked.size, matched: hits.size, sent, failed, skipped: skipped || null,
    });
  } catch (e: any) { console.warn(`[cs-notify] status write failed: ${e?.message}`); }

  return { skipped, matched: hits.size, sent, failed };
}
