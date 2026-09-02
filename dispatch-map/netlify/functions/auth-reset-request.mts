// auth-reset-request.mts — POST { identifier } (username OR email) → always 200.
//
// The response is the same whether or not the account exists, has an email, or is
// active: "if that account has an email on file, a link is on its way". Anything more
// specific is an enumeration oracle. What actually happens is logged server-side.
//
// A link is minted only when: the account exists and is active, has an email, Resend
// is configured, and no link was requested in the last two minutes (so a stranger
// hammering the form cannot fill a dispatcher's inbox). The link is single-use and
// expires after RESET_TTL_MINUTES; only its SHA-256 is stored.

import { readJsonBody, jsonResponse, clientIp, throttled } from './lib/require-user.mts';
import { normalizeUsername, normalizeEmail, newResetToken, RESET_TTL_MINUTES } from './lib/auth-core.mts';
import { getUser, findUserByEmail, patchUser, storeReady } from './lib/auth-store.mts';
import { authMailEnabled, sendResetEmail } from './lib/auth-mail.mts';

const REQUEST_GAP_MS = 2 * 60_000;

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST only' }, 405);
  const mailConfigured = authMailEnabled();
  const generic = () => jsonResponse({
    ok: true,
    mailConfigured,
    message: mailConfigured
      ? 'If that account has an email on file, a reset link has been sent.'
      : 'Password reset by email is not configured on this site — ask an admin to reset your password.',
  });

  const ip = clientIp(req);
  if (throttled(`reset:${ip}`, 10, 10 * 60_000)) return generic();
  if (!storeReady()) return generic();

  const b = await readJsonBody(req);
  if (!b.ok) return b.response;
  const raw = String(b.body.identifier ?? b.body.username ?? b.body.email ?? '').trim();
  if (!raw) return jsonResponse({ ok: false, error: 'identifier required' }, 400);

  try {
    const doc = normalizeUsername(raw) ? await getUser(raw) : await findUserByEmail(normalizeEmail(raw));
    if (!doc) { console.log(`[auth-reset-request] no account for identifier (ip=${ip})`); return generic(); }
    if (doc.active === false) { console.log(`[auth-reset-request] inactive user=${doc.username}`); return generic(); }
    if (!doc.email) { console.log(`[auth-reset-request] user=${doc.username} has no email on file`); return generic(); }
    if (!mailConfigured) { console.log(`[auth-reset-request] user=${doc.username} — mail not configured`); return generic(); }
    const last = doc.resetRequestedAt ? Date.parse(String(doc.resetRequestedAt)) : NaN;
    if (Number.isFinite(last) && Date.now() - last < REQUEST_GAP_MS) {
      console.log(`[auth-reset-request] user=${doc.username} — link already sent recently`);
      return generic();
    }
    const { token, hash } = newResetToken();
    const now = Date.now();
    await patchUser(doc.username, {
      resetTokenHash: hash,
      resetExpiresAt: new Date(now + RESET_TTL_MINUTES * 60_000).toISOString(),
      resetRequestedAt: new Date(now).toISOString(),
    });
    const sent = await sendResetEmail(doc.email, { displayName: doc.displayName, username: doc.username, token });
    console.log(`[auth-reset-request] user=${doc.username} link ${sent ? 'sent' : 'NOT sent'} (ip=${ip})`);
  } catch (e: any) {
    console.error('[auth-reset-request] failed:', e?.message || e);
  }
  return generic();
};
