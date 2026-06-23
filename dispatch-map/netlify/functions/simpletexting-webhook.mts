// simpletexting-webhook.mts
//
// Receives inbound-SMS (and other) events from SimpleTexting and stores incoming
// messages in Firestore so the app's Messages inbox can show customer replies.
//
// Registered with SimpleTexting via POST /v2/api/webhooks pointing at:
//   https://dd-dispatch-map.netlify.app/.netlify/functions/simpletexting-webhook?token=<secret>
// triggers: ["INCOMING_MESSAGE"].
//
// The URL is public, so we require a shared secret (SIMPLETEXTING_WEBHOOK_SECRET)
// in the ?token= query to reject spoofed posts.
//
// Inbound payload (per the API docs — SingleReportDtoWebhookMessageDto):
//   { reportId, webhookId, type: "INCOMING_MESSAGE", values: {
//       messageId, text, subject, mediaItems[], accountPhone, contactPhone, timestamp } }
// SimpleTexting may send a single object or a batch array; we handle both.

import { isFirestoreEnabled, setDoc } from './lib/firestore.mts';
import { normalizePhone } from './lib/sms.mts';

const COLLECTION = 'sms_inbound';

function asReports(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.reports)) return body.reports;
  if (body && typeof body === 'object') return [body];
  return [];
}

export default async (req: Request): Promise<Response> => {
  // Always 200 quickly so SimpleTexting doesn't retry-storm us; problems are logged.
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (req.method === 'GET') return ok(); // health/verification ping
  if (req.method !== 'POST') return new Response('method', { status: 405 });

  const secret = process.env.SIMPLETEXTING_WEBHOOK_SECRET;
  if (secret) {
    const token = new URL(req.url).searchParams.get('token');
    if (token !== secret) { console.warn('[st-webhook] bad token'); return new Response('forbidden', { status: 403 }); }
  }

  let body: any;
  try { body = await req.json(); } catch { return ok(); }

  if (!isFirestoreEnabled()) { console.warn('[st-webhook] firestore off; dropping event'); return ok(); }

  let stored = 0;
  for (const r of asReports(body)) {
    const type = r?.type || r?.values?.type;
    if (type && type !== 'INCOMING_MESSAGE') continue; // only inbound replies for now
    const v = r?.values || r;
    const contactPhone = normalizePhone(v?.contactPhone);
    const text = v?.text ?? '';
    if (!contactPhone && !text) continue;
    const id = String(v?.messageId || r?.reportId || `${contactPhone}_${Date.now()}`);
    try {
      await setDoc(`${COLLECTION}/${id}`, {
        messageId: v?.messageId || null,
        contactPhone,
        accountPhone: normalizePhone(v?.accountPhone) || null,
        text,
        subject: v?.subject || null,
        mediaItems: Array.isArray(v?.mediaItems) ? v.mediaItems : [],
        timestamp: v?.timestamp || null,
        received_at: new Date().toISOString(),
        type: 'INCOMING_MESSAGE',
      });
      stored++;
    } catch (e: any) { console.warn(`[st-webhook] store failed: ${e?.message}`); }
  }
  console.log(`[st-webhook] stored=${stored}`);
  return ok();
};
