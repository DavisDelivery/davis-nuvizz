// lib/sms-store.mts
//
// One place to persist SMS messages (both directions) into Firestore `sms_messages`
// so the app can show two-way conversation threads. Inbound is written by the
// SimpleTexting webhook; outbound by send-sms after a successful send.
//
// Doc shape: { direction:'in'|'out', contactPhone (the OTHER party, normalized),
//   accountPhone, text, driverName?, label?, messageId?, at (ISO, used for ordering) }.

import crypto from 'node:crypto';
import { setDoc } from './firestore.mts';
import { normalizePhone } from './sms.mts';

const COLLECTION = 'sms_messages';

// PURE. The vendor's messageId becomes the doc id under sms_messages/ — a path segment. A
// SimpleTexting id is a short token today, but the value arrives on a public webhook, so a
// '/' or '..' in it would address a different document. Anything outside the plain id
// alphabet is replaced by its sha256 hex: still stable (the same inbound retry still
// de-dupes to the same doc), never a path. Exported for tests.
export const SMS_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
export function smsDocId(messageId: string): string {
  return SMS_ID_RE.test(messageId) ? messageId : crypto.createHash('sha256').update(messageId).digest('hex');
}

export async function recordSmsMessage(m: {
  direction: 'in' | 'out';
  contactPhone: any;
  accountPhone?: any;
  text?: string;
  driverName?: string | null;
  label?: string | null;
  messageId?: string | null;
  at?: string;
}): Promise<void> {
  const contactPhone = normalizePhone(m.contactPhone);
  const at = m.at || new Date().toISOString();
  // Stable id: prefer the vendor messageId; else direction+phone+time so a retry
  // of the same inbound webhook de-dupes but distinct sends don't collide.
  const id = m.messageId
    ? smsDocId(String(m.messageId))
    : `${m.direction}_${contactPhone}_${Date.parse(at) || Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    await setDoc(`${COLLECTION}/${id}`, {
      direction: m.direction,
      contactPhone: contactPhone || null,
      accountPhone: normalizePhone(m.accountPhone) || null,
      text: m.text || '',
      driverName: m.driverName || null,
      label: m.label || null,
      messageId: m.messageId || null,
      at,
    });
  } catch (e: any) { console.warn(`[sms-store] record failed: ${e?.message}`); }
}
