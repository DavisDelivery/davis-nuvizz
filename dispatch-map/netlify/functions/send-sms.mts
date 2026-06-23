// send-sms.mts
//
// Client-facing endpoint to send SMS via SimpleTexting (the browser can't hold
// the API key). Accepts a single message or a batch (bulk-to-selection).
//
//   POST /.netlify/functions/send-sms
//   Body: { to, text }  OR  { text, recipients: [{ to, label? }] }
//   → { ok, sent, failed, capped, results: [{ to, label, ok, id?, error? }] }
//
// Guardrails (this endpoint sends billable SMS and has no user auth):
//   • SMS_DAILY_CAP (default 500) — a per-ET-day ceiling tracked in Firestore so
//     a bug or abuse can't blast unlimited texts / cost. Overflow is "capped".
//   • Per-request batch limit (200).
// NOTE: there is no app-level auth yet; the cap bounds blast radius. Add real
// auth (Firebase App Check / signed request) before exposing this widely.

import { smsEnabled, sendSms } from './lib/sms.mts';
import { isFirestoreEnabled, getDoc, setDoc, etDayString } from './lib/firestore.mts';

const OPS = 'nuvizz_ops';
const BATCH_LIMIT = 200;

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'POST only' }), { status: 405, headers: cors });

  if (!smsEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'SMS not configured (SIMPLETEXTING_API_KEY unset)' }), { status: 503, headers: cors });
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false, error: 'invalid JSON' }), { status: 400, headers: cors }); }

  const text = String(body?.text ?? '').trim();
  let recipients: { to: string; label?: string }[] = Array.isArray(body?.recipients)
    ? body.recipients.map((r: any) => ({ to: String(r?.to ?? ''), label: r?.label }))
    : (body?.to ? [{ to: String(body.to), label: body?.label }] : []);
  // De-dupe by phone, drop blanks.
  const seen = new Set<string>();
  recipients = recipients.filter((r) => r.to && !seen.has(r.to) && seen.add(r.to));

  if (!text) return new Response(JSON.stringify({ ok: false, error: 'text required' }), { status: 400, headers: cors });
  if (!recipients.length) return new Response(JSON.stringify({ ok: false, error: 'no recipients' }), { status: 400, headers: cors });
  if (recipients.length > BATCH_LIMIT) return new Response(JSON.stringify({ ok: false, error: `too many recipients (max ${BATCH_LIMIT})` }), { status: 400, headers: cors });

  // Daily cap (best-effort; skipped if Firestore is off).
  const cap = Number(process.env.SMS_DAILY_CAP) || 500;
  const day = etDayString();
  const capPath = `${OPS}/sms__${day}`;
  let used = 0;
  if (isFirestoreEnabled()) {
    try { const d = (await getDoc(capPath)) as any; used = Number(d?.count) || 0; } catch { /* treat as 0 */ }
  }
  const remaining = Math.max(0, cap - used);

  const results: any[] = [];
  let sent = 0, failed = 0, capped = 0;
  for (const r of recipients) {
    if (sent >= remaining) { capped++; results.push({ to: r.to, label: r.label, ok: false, error: 'daily cap reached' }); continue; }
    const res = await sendSms({ to: r.to, text });
    if (res.ok) { sent++; results.push({ to: r.to, label: r.label, ok: true, id: res.id }); }
    else { failed++; results.push({ to: r.to, label: r.label, ok: false, error: res.error }); }
  }

  if (isFirestoreEnabled() && sent > 0) {
    try { await setDoc(capPath, { count: used + sent, day, updated_at: new Date().toISOString() }); } catch { /* best-effort */ }
  }

  return new Response(JSON.stringify({ ok: failed === 0 && capped === 0, sent, failed, capped, cap, results }), { status: 200, headers: cors });
};
