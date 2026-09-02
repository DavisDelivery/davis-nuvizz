// cs-notify-test.mts
//
// Fire ONE test of the "Email customer service when scheduled" feature on demand,
// so a dispatcher can confirm the CS email actually arrives — without waiting for a
// scan, without needing the customer's notify_cs flag set, and without touching the
// per-date dedup. It builds the SAME email cs-notify sends (buildEmail) and sends it
// to the SAME configured recipients (NOTIFY_CS_TO), with a [TEST] subject prefix.
//
// ZERO NuVizz calls: the customer's stop is read from our own board cache
// (nuvizz_stop_index) — never a vendor call.
//
//   POST /.netlify/functions/cs-notify-test
//     ?date=YYYY-MM-DD   the board day to pull the sample stop from (default: ET today)
//     ?pro=<pro>         match the stop by PRO number, OR
//     ?matchKey=<key>    match by customer match key, OR
//     (neither)          use the first stop on that day's board
//     ?to=<email>        OPTIONAL recipient override (else NOTIFY_CS_TO) — lets you
//                        send the test to yourself before wiring the CS list.
//
// Reports the exact outcome (configured?, recipients, sent id, or error) so a
// misconfigured RESEND_*/NOTIFY_CS_TO surfaces plainly instead of silently no-op'ing.

import { isFirestoreEnabled, readStops, etDayString } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';
import { emailEnabled, sendEmail } from './lib/email.mts';
import { adminTokenOk, testRecipientAllowed } from './lib/customer-comms.mts';
import { buildEmail, csRecipients } from './lib/cs-notify.mts';
import { normalizeMatchKey } from './lib/match-key.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  const J = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers });

  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' });
  // User gate — inert until AUTH_REQUIRED=true on the site (lib/require-user.mts).
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  // A TEST MAILER IS STILL A MAILER, AND THIS ONE WAS OPEN TO THE WORLD.
  //
  // GET /api/cs-notify-test?to=anyone@anywhere.com sent a real consignee's name, address,
  // PRO, load and driver to an arbitrary address, from the SPF/DKIM-signed davisdelivery.com
  // — no token, no method check, no recipient allowlist, and no ledger entry. Anything that
  // fetches a URL could fire it: a link preview in a chat app, a crawler, a copied link in a
  // ticket. It burns the same verified domain the customer delivery-email program sends from,
  // so abuse lands on OUR sending reputation and reaches customers as us.
  //
  // The three gates already existed in this repo — customer-comms-test uses all of them on
  // the same lib. This endpoint simply never adopted them.
  //
  //   POST-only            a GET is what a preview bot issues; a mailer is not a safe GET
  //   adminTokenOk         the same x-comms-token gate the sibling test endpoint requires
  //   testRecipientAllowed ?to= must match COMMS_TEST_ALLOWED_TO (defaults to @davisdelivery.com),
  //                        so a test can never reach a customer even with the token
  //
  // ?dryRun=1 stays reachable without any of this: it sends nothing, and the whole point of
  // a dry run is that anyone debugging the wiring can use it.
  const isDryRun = new URL(req.url).searchParams.get('dryRun') === '1';
  if (!isDryRun) {
    if (req.method !== 'POST') {
      return J({ ok: false, error: 'POST required — this endpoint sends real email. Use ?dryRun=1 to inspect without sending.' }, 405);
    }
    if (!adminTokenOk(req)) {
      return J({ ok: false, error: 'not authorised — send COMMS_ADMIN_TOKEN as the x-comms-token header' }, 403);
    }
  }

  const url = new URL(req.url);
  const date = DATE_RE.test(String(url.searchParams.get('date') || '')) ? String(url.searchParams.get('date')) : etDayString();
  const pro = String(url.searchParams.get('pro') || '').trim();
  const matchKey = String(url.searchParams.get('matchKey') || '').trim();
  const toOverride = String(url.searchParams.get('to') || '').trim();
  // ?dryRun=1 → resolve config + the sample stop and report what WOULD be sent, WITHOUT
  // sending. Lets you confirm the feature is wired (and to whom) before any real email.
  const dryRun = url.searchParams.get('dryRun') === '1';

  // Configuration check FIRST — the #1 reason a "test" would silently do nothing.
  // NOTIFY_CS_TO wins; else csRecipients() falls back to the company CS inbox (the send path does
  // the same, so this test reflects exactly where a real scheduled email would go).
  // An override may only ever address an internal mailbox. Without this, the token alone
  // would still let a real consignee's details be posted to any address on earth.
  if (toOverride && !isDryRun && !testRecipientAllowed(toOverride)) {
    return J({ ok: false, error: 'pass ?to=<an allowed address> so a test can never reach a customer (see COMMS_TEST_ALLOWED_TO)' }, 400);
  }
  const recipients = toOverride ? [toOverride] : csRecipients();
  if (!emailEnabled()) {
    return J({ ok: false, configured: false, reason: 'email_disabled',
      detail: 'RESEND_API_KEY and/or RESEND_FROM are not set on this site — the CS-email feature is a no-op until they are.' });
  }

  // Find the sample stop on the day's board (our cache — zero NuVizz).
  const { stops } = await readStops(TENANT, date);
  if (!stops.length) return J({ ok: false, error: `no cached stops for ${date} to build a sample from` });

  let stop: any = null;
  if (pro) {
    const want = pro.replace(/^0+/, '');
    stop = stops.find((s: any) => {
      const cands = [s.pro, s.primaryPro, ...(Array.isArray(s.pros) ? s.pros : [])].filter(Boolean).map((p: any) => String(p));
      return cands.some((p: string) => p === pro || p.replace(/^0+/, '') === want);
    });
  } else if (matchKey) {
    stop = stops.find((s: any) => normalizeMatchKey(s.businessName, s.addr1, s.city, s.zip) === matchKey);
  } else {
    stop = stops[0];
  }
  if (!stop) return J({ ok: false, error: `no stop on ${date} matched ${pro ? `pro=${pro}` : matchKey ? `matchKey=${matchKey}` : '(first stop)'}` });

  const built = buildEmail(stop, date);
  if (dryRun) {
    return J({ ok: true, dryRun: true, configured: true, date, recipients,
      customer: stop.businessName || null, pro: stop.pro || stop.primaryPro || null,
      wouldSendSubject: `[TEST] ${built.subject}` });
  }
  const res = await sendEmail({
    to: recipients,
    subject: `[TEST] ${built.subject}`,
    text: `*** THIS IS A TEST of the Dispatch Map "email CS when scheduled" feature ***\n\n${built.text}`,
    html: `<p style="margin:0 0 12px;padding:8px 12px;background:#fef9c3;border:1px solid #fde047;border-radius:6px;font-family:system-ui,Arial,sans-serif;font-size:13px;color:#713f12"><b>This is a TEST</b> of the Dispatch Map “email customer service when scheduled” feature. No action needed.</p>${built.html}`,
  });

  return J({
    ok: res.ok,
    configured: true,
    date,
    recipients,
    customer: stop.businessName || null,
    pro: stop.pro || stop.primaryPro || null,
    sentId: res.id || null,
    error: res.error || null,
  });
};
