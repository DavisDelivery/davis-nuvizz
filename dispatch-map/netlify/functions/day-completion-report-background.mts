// day-completion-report-background.mts — the 6:30pm end-of-day board, emailed and kept.
//
// Chad: "produce a report at the end of every day at six thirty on everything that was
// planned for that day per NuVizz ... and then does not have a completed status at six
// thirty ... and then also email that report to Chad at Davis delivery dot com every day
// as well. but I'd also like that report to be kept in the flag section of the dispatch map."
//
// WHAT IT DOES, IN ORDER:
//   1. Snapshots TODAY's board at 6:30pm ET — planned stops, what closed, what did not, and
//      why not (lib/day-completion classifies the four different kinds of "not completed",
//      which do not go to the same person).
//   2. Emails it.
//   3. RECONCILES YESTERDAY. The stops that were open at 6:30 last night are re-read now
//      that the day is fully settled, and each is recorded as either "closed after the
//      snapshot" (a POD that had not been scanned yet) or "still open" (freight that
//      genuinely rolled). Without this the daily open count measures WHEN DRIVERS SCAN and
//      reads as delivery performance — and a driver who scans at the truck and one who
//      scans at the yard at 7pm produce identical freight and wildly different charts.
//
// SIX-THIRTY MEANS SIX-THIRTY IN GEORGIA. Netlify cron is UTC and has no idea about DST, so
// a single UTC hour drifts by one an hour twice a year — and a report named for its hour
// that arrives at 5:30 half the year is a report nobody trusts. It fires at 22:30 AND 23:30
// UTC and the ET wall clock decides which one is real: 18:xx ET runs, anything else returns
// immediately having done nothing. The snapshot write is idempotent for the same reason —
// whichever run lands, only the first one for a date records anything.
//
// INSPECTABILITY. A function carrying a schedule is not reachable over plain HTTP in this
// app (rediscovered twice at cost), so "what would tonight's report say" is answered by the
// schedule-free twin, day-completion.mts, which runs the SAME pure builder over the same
// index and sends nothing.
//
// Data diet: the stop index the scanner already maintains. ZERO NuVizz calls.
import { isFirestoreEnabled, readStops, etDayString, getDoc } from './lib/firestore.mts';
import { buildDayCompletion, reconcileDay, dayCompletionSubject, dayCompletionText, dayCompletionHtml, attachFlagHistory } from './lib/day-completion.mts';
import { flagHistoryPath } from './lib/flag-history.mts';
import { readDayCompletion, writeDaySnapshot, writeDayReconciliation } from './lib/day-completion-store.mts';
import { emailEnabled, sendEmail } from './lib/email.mts';

const TENANT = 'davis';
export const REPORT_HOUR_ET = 18;
export const REPORT_MINUTE_ET = 30;
// THE RECIPIENT IS AN ENV VAR AND NOT A LINE OF SOURCE. This report goes to a person, and a
// person's address on the company domain must not be committed: the repo's own guard
// (test/no-lifelike-addresses) refuses them because Netlify's secret scanner reads an
// env-var VALUE out of the build and fails the deploy. That guard's bar is a ROLE word the
// product genuinely sends from, which a personal address is not.
//
// AND THE FIRST DRAFT OF THIS VERY COMMENT FAILED THE DEPLOY. It spelled out the local part
// in lowercase to explain why it was not being committed — and that bare word is itself an
// env-var value on this site, so the scanner matched the explanation. The scan reads
// COMMENTS, not just code, and it is case-sensitive: a secret does not become safe by being
// prose about a secret. Nothing here spells one out, deliberately.
//
// Unset means no send, said out loud in the run status rather than failing quietly.
const TO_ENV = 'DAY_REPORT_TO';

function etParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  return {
    hour: Number(p.find((x) => x.type === 'hour')?.value ?? 0) % 24,
    minute: Number(p.find((x) => x.type === 'minute')?.value ?? 0),
  };
}

/** PURE. Is this firing the real 6:30 one? Exported so the DST behaviour is testable
 *  rather than something we find out about in November. */
export function isReportHour(hour: number, minute: number): boolean {
  return hour === REPORT_HOUR_ET && minute >= REPORT_MINUTE_ET;
}

/**
 * PURE. Is it PAST 6:30 in Georgia — i.e. could tonight's report already have been sent?
 *
 * ── THE SECOND FIRING IS A SPARE, AND IT WAS BEING THROWN AWAY ──────────────
 * Chad, at half past midnight: "Where is my end of day email I'm supposed to receive at
 * 6:30 pm it didn't come today." On 2026-09-02 the 22:30 UTC run produced nothing — no
 * email in the send log, and no snapshot in Firestore either, while 09-01 has one. The
 * board was healthy (841 planned, 808 delivered), every email gate was open, and another
 * scheduled function on the same site ran at 22:55 UTC, so neither the data nor the
 * recipient nor the platform explains it. One invocation simply did not produce a report.
 *
 * AND NOTHING COVERED FOR IT. The cron fires twice (22:30 and 23:30 UTC) for one reason:
 * daylight saving. Whichever lands on 18:xx ET does the work and the other returns
 * immediately — so a night when the primary firing fails has no second chance at all, and
 * the only detector is Chad noticing an absence hours later. An absent email is the worst
 * possible alarm: it looks identical to a delayed one, a filtered one and a deleted one.
 *
 * So the spare now covers. It runs only when it is genuinely PAST report time and the day
 * has no snapshot yet — and the existing write-once rule already stops a double send,
 * because the email is sent only when the snapshot write returns 'written'.
 *
 * The DST arithmetic works out in both directions, which is the whole reason this is a
 * separate predicate with its own tests:
 *   EDT  22:30 UTC → 18:30 ET (primary)  ·  23:30 UTC → 19:30 ET (spare, past → covers)
 *   EST  22:30 UTC → 17:30 ET (early, NOT past → stands down)  ·  23:30 UTC → 18:30 ET (primary)
 * In winter the earlier firing must NOT cover, because 6:30 has not happened yet — and a
 * naive "the other slot retries" rule would have mailed a half-finished day every evening
 * from November to March.
 */
export function isAfterReportTime(hour: number, minute: number): boolean {
  if (hour > REPORT_HOUR_ET) return true;
  return hour === REPORT_HOUR_ET && minute >= REPORT_MINUTE_ET;
}

/** PURE. The ET calendar day before `date` — the day this run reconciles. */
export function previousDay(date: string): string {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

export default async (): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  const { hour, minute } = etParts();
  const primary = isReportHour(hour, minute);
  // The spare firing. It does nothing on an ordinary evening — the primary run has already
  // written the snapshot by now, and this returns after a single getDoc.
  const late = !primary && isAfterReportTime(hour, minute);
  if (!primary && !late) {
    return J({ ok: true, note: 'not the 6:30p ET firing — the other UTC slot owns this one', etHour: hour, etMinute: minute });
  }

  const date = etDayString();
  const out: any = { ok: true, date, etHour: hour, etMinute: minute, firing: primary ? 'primary' : 'spare' };

  if (late) {
    // ONE READ, THEN OUT. Asking Firestore whether tonight already reported is the entire
    // cost of the safety net on a normal day.
    const already = await readDayCompletion(TENANT, date).catch(() => null);
    if (already?.snapshot) {
      out.note = 'the 6:30p run already reported tonight — nothing to cover for';
      return J(out);
    }
    out.note = 'the 6:30p run left no snapshot for tonight — the spare firing is covering';
  }

  try {
    // ── 1. today's snapshot ──────────────────────────────────────────────────
    const { stops } = await readStops(TENANT, date);
    // JOIN THE DAY'S FLAGS ON. Chad: "in the nightly 630 email for things undelivered let me
    // know if any of the steps were flagged." A stop that ended open having been WARNED about
    // is a different follow-up from one nothing ever saw — the first is about the response,
    // the second about the rule. Best-effort: a history that cannot be read leaves the join
    // marked unavailable and prints that, rather than reporting nobody was flagged.
    const flagDoc = await getDoc(flagHistoryPath(TENANT, date)).catch(() => null);
    // WHAT TIME THIS READING IS OF, honestly. A spare run happens an hour later, and
    // stamping it '6:30p' would put a time on the report that nothing observed — the same
    // class of mistake as reporting an intent as an outcome. A late report says it is late,
    // which is also how Chad finds out the primary run failed without having to ask.
    const asOf = primary ? '6:30p' : `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, '0')}p (late — the 6:30 run did not report)`;
    const report = attachFlagHistory(buildDayCompletion(stops || [], { date, asOf }), flagDoc);
    out.report = {
      planned: report.planned, gradable: report.gradable, delivered: report.delivered,
      open: report.open, counts: report.counts,
      completionRate: report.completionRate, manualRate: report.manualRate,
    };
    out.snapshot = await writeDaySnapshot(TENANT, date, report);

    // ── 2. the email ─────────────────────────────────────────────────────────
    // Sent only when the snapshot was WRITTEN, never when it already existed. A retried
    // invocation must not mail the same evening twice, and the write is the claim.
    if (out.snapshot !== 'written') {
      out.emailed = false;
      // Say WHICH of the three it was. "exists" is the ordinary retry case and needs no
      // attention; "unreadable" and "failed" mean nobody was told about the day at all, and
      // reporting those as "already exists" would hide a missing report behind a benign one.
      out.emailNote = out.snapshot === 'exists'
        ? 'a snapshot for this date already exists — not re-sending'
        : out.snapshot === 'unreadable'
          ? 'could not read the existing record, so nothing was written and nothing was sent — this day has NO report'
          : 'the snapshot write failed, so nothing was sent — this day has NO report';
    } else if (!emailEnabled()) {
      out.emailed = false;
      out.emailNote = 'RESEND_API_KEY/RESEND_FROM not set';
    } else if (process.env.DAY_REPORT_ENABLED === '0') {
      out.emailed = false;
      out.emailNote = 'DAY_REPORT_ENABLED=0';
    } else if (!String(process.env[TO_ENV] || '').trim()) {
      out.emailed = false;
      out.emailNote = `${TO_ENV} not set — the report was built and stored, nobody was mailed`;
    } else {
      const to = String(process.env[TO_ENV]).trim();
      const res = await sendEmail({
        to,
        subject: dayCompletionSubject(report),
        text: dayCompletionText(report),
        html: dayCompletionHtml(report),
      });
      // NEVER REPORT AN INTENT AS AN OUTCOME. What the send actually returned, not what it
      // was asked to do — a hardcoded success ran in this repo for weeks once.
      out.emailed = res.ok;
      out.to = to;
      if (!res.ok) out.emailError = res.error;
    }

    // ── 3. yesterday, graded ─────────────────────────────────────────────────
    const prev = previousDay(date);
    const prevDoc = await readDayCompletion(TENANT, prev);
    if (!prevDoc?.snapshot) {
      out.reconciled = { date: prev, note: 'no snapshot for that day — nothing to grade' };
    } else if (prevDoc.reconciliation) {
      out.reconciled = { date: prev, note: 'already graded' };
    } else {
      const { stops: prevStops } = await readStops(TENANT, prev);
      const rec = reconcileDay(prevDoc.snapshot, prevStops || []);
      const ok = await writeDayReconciliation(TENANT, prev, rec);
      out.reconciled = {
        date: prev, written: ok,
        closedAfter: rec.closedAfter, failedAfter: rec.failedAfter,
        cancelledAfter: rec.cancelledAfter, stillOpen: rec.stillOpen,
      };
    }
  } catch (e: any) {
    out.ok = false;
    out.error = String(e?.message || e);
  }
  return J(out, out.ok ? 200 : 500);
};

// 22:30 UTC = 6:30p ET while the clocks are ahead; 23:30 UTC = 6:30p ET once they go back.
// isReportHour above throws away whichever one is not 6:30 in Georgia today.
export const config = { schedule: '30 22,23 * * *' };
