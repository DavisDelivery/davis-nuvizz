// lib/auth-mail.mts — the two emails the user system sends.
//
// Both carry a link into the app with a one-time token in the query string. The token
// is the only secret in the message; nothing about the account beyond the username and
// display name is included, and every merge value is HTML-escaped (a display name is
// typed by an admin, but "typed by staff" has produced live markup before — cs-notify).

import { sendEmail, emailEnabled } from './email.mts';
import { RESET_TTL_MINUTES } from './auth-core.mts';

export const SITE_ORIGIN = (process.env.AUTH_APP_URL || process.env.COMMS_SITE_ORIGIN || 'https://dd-dispatch-map.netlify.app').replace(/\/+$/, '');

export function esc(s: any): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

/** The page the client must serve: it reads ?u= and ?t= and POSTs them to auth-reset-confirm. */
export function resetLink(username: string, token: string): string {
  return `${SITE_ORIGIN}/reset-password?u=${encodeURIComponent(username)}&t=${encodeURIComponent(token)}`;
}

export function buildResetEmail(args: { displayName: string; username: string; link: string; invite?: boolean }): { subject: string; html: string; text: string } {
  const who = esc(args.displayName || args.username);
  const ttl = RESET_TTL_MINUTES;
  const subject = args.invite ? 'Set your Davis Dispatch password' : 'Reset your Davis Dispatch password';
  const lead = args.invite
    ? `An account has been created for you on Davis Dispatch (username <b>${esc(args.username)}</b>). Set your password to sign in:`
    : `Someone asked to reset the password for <b>${esc(args.username)}</b> on Davis Dispatch. If that was you, use this link:`;
  const html = `<!doctype html><html><body style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.5">
<p>Hi ${who},</p>
<p>${lead}</p>
<p><a href="${esc(args.link)}" style="display:inline-block;background:#1e5b92;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${args.invite ? 'Set password' : 'Reset password'}</a></p>
<p style="color:#555;font-size:13px">This link works once and expires in ${ttl} minutes. If you did not ask for it, you can ignore this email — your password has not changed.</p>
<p style="color:#555;font-size:13px">If the button does not work, paste this into your browser:<br>${esc(args.link)}</p>
<p>— Davis Delivery dispatch</p>
</body></html>`;
  const text = `Hi ${args.displayName || args.username},\n\n${args.invite
    ? `An account has been created for you on Davis Dispatch (username ${args.username}). Set your password here:`
    : `Someone asked to reset the password for ${args.username} on Davis Dispatch. If that was you, use this link:`}\n\n${args.link}\n\nThis link works once and expires in ${ttl} minutes. If you did not ask for it, ignore this email — your password has not changed.\n\n— Davis Delivery dispatch\n`;
  return { subject, html, text };
}

export function authMailEnabled(): boolean {
  return emailEnabled();
}

/** Best-effort: never throws. Returns whether Resend accepted it. */
export async function sendResetEmail(to: string, args: { displayName: string; username: string; token: string; invite?: boolean }): Promise<boolean> {
  const msg = buildResetEmail({ ...args, link: resetLink(args.username, args.token) });
  const r = await sendEmail({ to, subject: msg.subject, html: msg.html, text: msg.text });
  if (!r.ok) console.warn('[auth-mail] send failed:', r.error);
  return r.ok;
}
