// unsubscribe.mts — the customer's own way off the delivery-confirmation emails.
//
// Chad: a customer replied "unsubscribe" today and he had to go turn her emails off by hand.
//
//   GET  /unsubscribe?k=&t=   a person clicked the footer link — show a confirmation page
//   POST /unsubscribe?k=&t=   actually stop the emails (the page's button, AND Gmail's
//                             native one-click header per RFC 8058)
//   POST ?k=&t=&undo=1        put them back on, offered on the confirmation page
//
// ── WHY GET DOES NOT UNSUBSCRIBE, EVEN THOUGH CHAD ASKED FOR AUTOMATIC ───────
//
// Corporate mail filters and link-preview bots fetch every URL in an email before the human
// ever sees it. If GET unsubscribed, those scanners would silently unsubscribe customers who
// never touched the link — and the failure is invisible, because the customer simply stops
// getting delivery confirmations and never learns why. This is the exact reason RFC 8058
// specifies one-click unsubscribe as a POST rather than a GET.
//
// It is still automatic in the way Chad meant: nobody at Davis touches anything. Gmail and
// Outlook show their own Unsubscribe button, which POSTs and is genuinely one click; anyone
// clicking the footer link gets one plain button and is done. What it is not is
// "unsubscribed by a robot that was only looking".
//
// ── THE WRITE ────────────────────────────────────────────────────────────────
//
// FIELD-MASKED, never a whole-document write. customer_notes docs carry the dispatcher's
// receiving hours, which the flag engine reads to predict missed windows — and setDoc in
// this repo REPLACES a document rather than merging it. A blind write of the suppression
// flag would take those hours with it and quietly stop flagging that customer forever.
//
// ZERO NuVizz calls.
import { isFirestoreEnabled, getDoc, updateDocFields } from './lib/firestore.mts';
import {
  unsubSecrets, verifyToken, verifyUndo, signUndo, validKeyShape, optOutPatch, optInPatch,
} from './lib/unsubscribe.mts';

const NOTES = 'customer_notes';

const page = (title: string, body: string, status = 200) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title} — Davis Delivery Service</title>
<style>
  body{margin:0;background:#EDF1F5;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16202B}
  .wrap{max-width:560px;margin:0 auto;padding:32px 16px}
  .card{background:#fff;border-radius:6px;padding:28px 26px;box-shadow:0 1px 3px rgba(16,32,43,.08)}
  h1{font-size:20px;margin:0 0 12px;color:#123A63}
  p{font-size:15px;line-height:1.6;color:#5A6B7C;margin:0 0 14px}
  .who{font-weight:600;color:#16202B}
  button{font:inherit;font-size:15px;font-weight:700;padding:14px 26px;border-radius:4px;border:0;cursor:pointer;min-height:48px}
  .go{background:#123A63;color:#fff}
  .undo{background:#fff;color:#123A63;border:1px solid #C3D0DC}
  .foot{font-size:12px;color:#7C8B9A;margin-top:22px;text-align:center}
</style></head><body><div class="wrap"><div class="card">${body}</div>
<div class="foot">Davis Delivery Service &middot; family owned since 1985</div></div></body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } },
);

const esc = (v: any) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);

// THE PATH IS DECLARED HERE AS WELL AS IN netlify.toml, and that redundancy is deliberate.
// A Netlify function's default address is /.netlify/functions/unsubscribe; the pretty
// /unsubscribe the emails carry only exists because something maps it. The toml redirect
// does that, but it sits in the same file as a `/*` SPA catch-all, and one reordering would
// serve the dispatch app at this URL instead — returning 200 to Gmail's one-click POST while
// unsubscribing nobody. The customer would have told Gmail to stop, been told it worked, and
// kept receiving mail; the next step after that is the spam button, and nothing on our side
// would show it happening.
export const config = { path: '/unsubscribe' };

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const key = String(url.searchParams.get('k') || '').trim();
  const token = String(url.searchParams.get('t') || '').trim();
  const { sign, accept } = unsubSecrets();

  // SHAPE FIRST, before this string is ever interpolated into a Firestore path. The
  // signature already gates it, but `customer_notes/${key}` built by concatenation must not
  // be able to walk out of its collection even if the signature check is ever weakened.
  // normalizeMatchKey only emits word characters, so anything else is not a real key.
  //
  // A bad, missing or unsigned link then gets the SAME neutral answer as a good one, and
  // never says whether the key was real — otherwise this endpoint answers "is this business
  // a customer of yours" to anyone holding a URL.
  const ok = validKeyShape(key) && verifyToken(key, token, accept);

  if (req.method === 'GET') {
    if (!ok) {
      return page('Unsubscribe', `<h1>This link has expired or is not valid</h1>
        <p>We could not read this unsubscribe link. Reply to any delivery email and we will take you off the list by hand.</p>`);
    }
    let name = '';
    try { name = String((await getDoc(`${NOTES}/${key}`))?.raw_name || ''); } catch { /* not required */ }
    return page('Unsubscribe', `<h1>Stop delivery emails?</h1>
      <p>These are the confirmations we send ${name ? `<span class="who">${esc(name)}</span>` : 'you'} when a shipment is delivered — the PRO number, what was delivered, and a link to the proof of delivery.</p>
      <p>If you stop them, we will not email you when future freight arrives. Your deliveries are unaffected.</p>
      <form method="POST">
        <button class="go" type="submit">Yes, stop these emails</button>
      </form>`);
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  }

  // RFC 8058 one-click: Gmail POSTs "List-Unsubscribe=One-Click" as a form body. It never
  // sees this page — it wants a 2xx and nothing else — but a human pressing the button on
  // the page above lands here too, so it must render something either way.
  if (!ok) return page('Unsubscribe', `<h1>This link is not valid</h1>
    <p>Reply to any delivery email and we will take you off the list by hand.</p>`);
  if (!isFirestoreEnabled()) return page('Unsubscribe', `<h1>Something went wrong</h1>
    <p>We could not record that just now. Please reply to any delivery email and we will do it by hand.</p>`, 503);

  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();

  // UNDO IS A DIFFERENT PERMISSION and carries its own short-lived token. The unsubscribe
  // token must never re-subscribe anybody: a forwarded link, a mail gateway's log or a
  // scanner replaying URLs would otherwise be able to put a customer who opted out BACK on
  // the list, and Davis would keep mailing someone who asked us to stop.
  const undoAt = Number(url.searchParams.get('u') || 0);
  const undoTok = String(url.searchParams.get('ut') || '');
  if (url.searchParams.get('undo') === '1') {
    if (!verifyUndo(key, undoAt, undoTok, accept, nowMs)) {
      return page('Unsubscribe', `<h1>That link has expired</h1>
        <p>The "put me back on the list" link is only good for a short while. Reply to any delivery email and we'll switch them back on.</p>`);
    }
    try {
      await updateDocFields(`${NOTES}/${key}`, optInPatch(at));
    } catch (e: any) {
      console.error('resubscribe write failed:', e?.message);
      return page('Unsubscribe', `<h1>Something went wrong</h1>
        <p>Please reply to any delivery email and we'll do it by hand.</p>`, 500);
    }
    return page('Resubscribed', `<h1>You're back on the list</h1>
      <p>We'll email you when your next delivery is completed.</p>`);
  }

  try {
    await updateDocFields(`${NOTES}/${key}`, optOutPatch({
      source: 'customer', at, via: 'email-link',
      // NOT taken from the query string. An unsigned ?e= is attacker-supplied, and writing
      // it onto the customer's record would let anyone put a chosen address in Chad's
      // unsubscribe list. The address we actually mailed is on the send ledger; this field
      // is left empty rather than filled with something unverified.
    }));
  } catch (e: any) {
    console.error('unsubscribe write failed:', e?.message);
    return page('Unsubscribe', `<h1>Something went wrong</h1>
      <p>We could not record that just now. Please reply to any delivery email and we will do it by hand.</p>`, 500);
  }

  return page('Unsubscribed', `<h1>Done — no more delivery emails</h1>
    <p>We've taken you off delivery confirmations. Your freight is unaffected, and you can still track any shipment from the PRO number on your paperwork.</p>
    <p>Changed your mind?</p>
    <form method="POST" action="?k=${encodeURIComponent(key)}&t=${encodeURIComponent(token)}&undo=1&u=${nowMs}&ut=${sign ? signUndo(key, nowMs, sign) : ''}">
      <button class="undo" type="submit">Put me back on the list</button>
    </form>`);
};
