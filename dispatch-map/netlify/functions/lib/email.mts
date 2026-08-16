// lib/email.mts
//
// Minimal transactional-email sender via Resend (https://resend.com). Used by the
// scan to alert customer service when an opted-in ("notify CS") customer first
// appears on a day's board.
//
// Env:
//   RESEND_API_KEY  — Resend API key (required; absent ⇒ emailEnabled() false).
//   RESEND_FROM     — verified sender, e.g. "Davis Dispatch <no-reply@davisdelivery.com>".
//                     Must be on a domain verified in the Resend account.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function emailEnabled(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM;
}

export interface SendEmailArgs {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  // Per-send sender OVERRIDE. Omit (the case for every cs-notify send) and RESEND_FROM is
  // used exactly as before. Customer-facing mail wants a different, branded sender from the
  // internal alerts, and that address is edited at runtime from Firestore — so it cannot come
  // from an env var. Whatever is passed must still be on a domain verified in Resend, or the
  // API rejects the send; callers are expected to validate before storing one.
  from?: string;
}

// Sends one email. Best-effort: returns {ok} and never throws, so a mail failure
// can never break a scan. Caller decides whether to record dedup state on ok.
export async function sendEmail(args: SendEmailArgs): Promise<{ ok: boolean; id?: string; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  // RESEND_FROM stays REQUIRED even when a caller overrides the sender: it is the
  // known-verified address, so its absence still means "this site cannot send" and
  // emailEnabled() keeps telling the truth.
  const envFrom = process.env.RESEND_FROM;
  if (!key || !envFrom) return { ok: false, error: 'RESEND_API_KEY/RESEND_FROM not set' };
  const from = (args.from || '').trim() || envFrom;
  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: Array.isArray(args.to) ? args.to : [args.to],
        subject: args.subject,
        ...(args.html ? { html: args.html } : {}),
        ...(args.text ? { text: args.text } : {}),
        ...(args.replyTo ? { reply_to: args.replyTo } : {}),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `Resend HTTP ${resp.status} ${body.slice(0, 200)}` };
    }
    const data: any = await resp.json().catch(() => ({}));
    return { ok: true, id: data?.id };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'send failed' };
  }
}
