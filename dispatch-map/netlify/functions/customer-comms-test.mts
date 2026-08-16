// customer-comms-test.mts
//
// Fire ONE delivery email on demand so you can see the real thing in your own inbox
// before it ever points at a customer. Mirrors cs-notify-test: same builder, same
// sender, same config — only the recipient and a [TEST] subject differ.
//
//   GET  ?date=YYYY-MM-DD&pro=<pro>&preview=1   → rendered HTML, sends nothing
//   GET  ?coverage=1&date=YYYY-MM-DD            → how many delivered stops have an
//                                                 address on file (the go/no-go number)
//   POST ?date=&pro=&to=you@davisdelivery.com   → sends one [TEST] email
//
// Works with enabled=false — that is the point, verify BEFORE switching on — and a test
// never consumes the daily cap or blocks the real send: it sends directly and writes no
// ledger entry at all.
//
// The recipient is ALLOWLISTED (COMMS_TEST_ALLOWED_TO, default @davisdelivery.com).
// This endpoint is live from the moment the branch deploys, while the feature itself is
// still off, so it is the one path that can actually put mail on the wire — an
// unvalidated ?to= would make it a public mailer on a verified Davis domain.
//
// ZERO NuVizz calls — the sample stop comes from our own board cache.

import { isFirestoreEnabled, readStops, etDayString } from './lib/firestore.mts';
import { emailEnabled, sendEmail } from './lib/email.mts';
import {
  readConfig, buildMessage, resolveRecipient, adminTokenOk, testRecipientAllowed, DATE_RE,
} from './lib/customer-comms.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const dateRaw = String(url.searchParams.get('date') || '');
    const date = DATE_RE.test(dateRaw) ? dateRaw : etDayString();
    const pro = String(url.searchParams.get('pro') || '').trim();
    const to = String(url.searchParams.get('to') || '').trim();
    const preview = url.searchParams.get('preview') === '1';
    const coverage = url.searchParams.get('coverage') === '1';

    const cfg = await readConfig();
    const { stops } = await readStops(TENANT, date);
    if (!stops.length) return J({ ok: false, error: `no cached stops for ${date}` });

    const delivered = stops.filter((s: any) => String(s?.normalizedStatus || '').toUpperCase() === 'DELIVERED');

    // COVERAGE — the number that decides whether this feature is worth turning on. An
    // address only exists on a stop the scan enriched AND whose shipper filled in the
    // optional consignee-email field, so it cannot be guessed from the code. Firestore
    // only: one cached-board read plus one customer_notes read per delivered stop.
    if (coverage) {
      // SAMPLED and CONCURRENT. One customer_notes read per stop, and a busy day delivers
      // several hundred — done one at a time that overruns Netlify's 10s default and comes
      // back as an HTML 502 the client cannot parse. The sample is reported so the number
      // is never mistaken for a full census.
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 150, 1), 600);
      const sample = delivered.slice(0, limit);
      let withEmail = 0, optedOut = 0, fromNotes = 0, fromOrder = 0;
      let i = 0;
      const worker = async () => {
        while (i < sample.length) {
          const r = await resolveRecipient(sample[i++]);
          if (r.optedOut) { optedOut++; continue; }
          if (r.email) { withEmail++; r.source === 'notes' ? fromNotes++ : fromOrder++; }
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      return J({
        ok: true, coverage: true, date,
        stops: stops.length, delivered: delivered.length,
        sampled: sample.length, truncated: sample.length < delivered.length,
        withEmail, optedOut, withoutEmail: sample.length - withEmail - optedOut,
        bySource: { notes: fromNotes, order: fromOrder },
        pct: sample.length ? Math.round((withEmail / sample.length) * 100) : 0,
      });
    }

    // Prefer a genuinely delivered stop so the preview shows real timestamps rather
    // than a blank delivered-at line.
    let stop: any = null;
    if (pro) {
      const want = pro.replace(/^0+/, '');
      stop = stops.find((s: any) => [s.pro, s.primaryPro, s.stopNbr, ...(Array.isArray(s.pros) ? s.pros : [])]
        .filter(Boolean).map(String)
        .some((p: string) => p === pro || p.replace(/^0+/, '') === want));
      if (!stop) return J({ ok: false, error: `no stop on ${date} matched pro=${pro}` });
    } else {
      stop = delivered[0] || stops[0];
    }

    const { subject, html, vars } = buildMessage(stop, date, cfg);
    const recip = await resolveRecipient(stop);

    if (preview || req.method === 'GET') {
      return J({
        ok: true, preview: true, date,
        pro: vars.pro, customer: vars.customer,
        status: stop?.normalizedStatus || null,
        subject,
        html,
        // What the real send WOULD do with this stop — the two reasons a live send
        // most often skips, visible before you turn anything on.
        recipientOnFile: recip.email, recipientSource: recip.source || null, optedOut: recip.optedOut,
        config: {
          enabled: cfg.enabled,
          // The address the send will ACTUALLY use, not the stored override — an empty
          // override falls back to RESEND_FROM, and a preview that showed the stored
          // value would be reporting a sender the very next send does not use.
          from: cfg.fromAddress || process.env.RESEND_FROM || null,
          replyTo: cfg.replyTo, dailyCap: cfg.dailyCap,
        },
        resendConfigured: emailEnabled(),
      });
    }

    if (!adminTokenOk(req)) {
      return J({ ok: false, error: 'not authorised — set COMMS_ADMIN_TOKEN on this site and send it as the x-comms-token header' }, 403);
    }
    if (!emailEnabled()) {
      return J({ ok: false, error: 'RESEND_API_KEY / RESEND_FROM not set — nothing can send yet.' }, 400);
    }
    if (!testRecipientAllowed(to)) {
      return J({ ok: false, error: 'pass ?to=<an allowed address> so a test can never reach a customer (see COMMS_TEST_ALLOWED_TO)' }, 400);
    }

    const res = await sendEmail({
      to,
      subject: `[TEST] ${subject}`,
      html: `<p style="margin:0 0 12px;padding:8px 12px;background:#fef9c3;border:1px solid #fde047;border-radius:6px;font-family:system-ui,Arial,sans-serif;font-size:13px;color:#713f12"><b>This is a TEST</b> of the Davis delivery-complete email. No action needed.</p>${html}`,
      replyTo: cfg.replyTo,
      from: cfg.fromAddress || undefined,
    });

    return J({ ok: res.ok, test: true, date, pro: vars.pro, to, sentId: res.id || null, error: res.error || null });
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'failed' }, 500);
  }
};
