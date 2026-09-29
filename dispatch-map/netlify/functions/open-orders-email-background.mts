// open-orders-email-background.mts — the 5:30p open-orders email to customer service.
//
// Chad, 2026-09-29: "at 5:25, I want to run a refresh scan so that everything and all the data
// is fresh. And then five minutes after that, I want to send the email to customer service of
// every planned delivery that's undelivered still." Recipients: customer service and Chad.
//
// WHAT IT DOES: weekdays from 5:30p ET it reads today's board, and once the 5:25p pinned scan
// has stamped both lists (scan-plan.mts PINNED_SCANS) it emails every planned order not yet
// delivered (lib/open-orders.mts) to the '5:30p open orders' list (Diagnostics → Alert
// recipients; customer service always on it). If the scan has not landed by 5:45p it sends on
// the board as it stands and says how old it is. Once a day: the sent stamp is written only
// after the mailer confirms, so a failed send is retried by the next firing inside the window.
//
// DST: cron is UTC. 21:xx and 22:xx UTC cover 5:30p ET in both EDT and EST; the ET clock in
// sendDecision decides which firing is real, exactly as the 6:30 report does.
//
// INSPECTABILITY: open-orders-email.mts is the schedule-free twin — the same builder over the
// same board, and what this function would do now, without sending anything.
//
// Data diet: Firestore only. ZERO NuVizz calls — the scan is the pinned one, not this.
//
// PUT IT BACK: OPEN_ORDERS_EMAIL=off (house switch shape), or revert this commit. The 5:25p
// scan is its own switch (SCAN_PINS).
import { isFirestoreEnabled, readStops, etDayString, getDoc, setDoc, readScanKindStamps, readAlertRecipients } from './lib/firestore.mts';
import { recipientsFor } from './lib/alert-recipients.mts';
import { emailEnabled, sendEmail } from './lib/email.mts';
import { buildOpenOrders, sendDecision, inSendWindow, openOrdersSubject, openOrdersText, openOrdersHtml, openOrdersPath, openOrdersEmailEnabled, etClock, etTime, boardAsOf } from './lib/open-orders.mts';

const TENANT = 'davis';

export default async (): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!openOrdersEmailEnabled()) return J({ ok: true, note: 'OPEN_ORDERS_EMAIL=off' });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  const now = new Date();
  const { hour, minute, weekday } = etClock(now);
  const date = etDayString(now);
  const out: any = { ok: true, date, etHour: hour, etMinute: minute };
  if (!inSendWindow(weekday, hour, minute)) return J({ ...out, note: 'outside the weekday 5:30–6:00p ET window' });
  try {
    const record = await getDoc(openOrdersPath(date)).catch(() => null);
    const stamps = await readScanKindStamps().catch(() => ({} as Record<string, string>));
    const d = sendDecision({ weekday, hour, minute, nowMs: now.getTime(), stamps, alreadySent: !!record?.sentAt });
    out.decision = d;
    if (d.action !== 'send') return J(out);

    const { stops } = await readStops(TENANT, date);
    const report = buildOpenOrders(stops || [], { date });
    out.report = { planned: report.planned, delivered: report.delivered, open: report.open.length };
    if (!report.planned) {
      // A day with nothing planned (a holiday) is not news for customer service.
      out.note = 'no planned orders on the board today — nothing sent';
      return J(out);
    }
    if (!emailEnabled()) { out.note = 'RESEND_API_KEY/RESEND_FROM not set'; return J(out); }
    let stored: any = null;
    try { stored = await readAlertRecipients(); } catch (e: any) { out.recipientStoreError = String(e?.message || e); }
    const to = recipientsFor('openOrdersTo', stored);
    const asOf = etTime(boardAsOf(stamps));
    const res = await sendEmail({
      to,
      subject: openOrdersSubject(report),
      text: openOrdersText(report, asOf),
      html: openOrdersHtml(report, asOf),
    });
    // Never report an intent as an outcome: what the mailer answered.
    out.emailed = res.ok;
    out.recipientCount = to.length;
    const at = new Date().toISOString();
    if (res.ok) {
      out.sentStamped = await setDoc(openOrdersPath(date), { date, sentAt: at, recipientCount: to.length, open: report.open.length, planned: report.planned, fresh: d.fresh, boardAsOf: boardAsOf(stamps) });
    } else {
      out.emailError = res.error;
      out.failureRecorded = await setDoc(openOrdersPath(date), { date, lastFailureAt: at, lastFailure: String(res.error || '').slice(0, 300) });
      console.error(`[open-orders] ${date}: NOT sent — the mailer's answer is on ${openOrdersPath(date)}.lastFailure; the next firing inside the window retries`);
    }
  } catch (e: any) {
    out.ok = false;
    out.error = String(e?.message || e);
  }
  return J(out, out.ok ? 200 : 500);
};

// Every 5 minutes through 21:00–22:59 UTC on weekdays: 5:30p ET is 21:30 UTC in EDT and 22:30
// UTC in EST. Firings outside 5:30–6:00p ET return after the clock check with no reads.
export const config = { schedule: '*/5 21,22 * * 1-5' };
