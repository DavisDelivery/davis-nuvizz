// day-completion.mts — the end-of-day board, on demand and read-only.
//
// THE SCHEDULE-FREE TWIN of day-completion-report-background. A function carrying
// config.schedule is not reachable over plain HTTP in this app — a property this repo has
// rediscovered twice at cost — so the evening job could email a report every night that
// nobody, including whoever wrote it, could ask a question of. That is the wrong shape for
// anything that reaches an inbox.
//
// This runs the SAME pure builder over the same stop index and NEVER sends, never writes.
//   ?date=YYYY-MM-DD   any board day (defaults to today)
//   ?history=1         the stored daily snapshots, newest first, for the charts
//   ?full=1            include the open-stop and unable lists (omitted by default: a 700-stop
//                      day is a large payload and the counts answer most questions)
//   ?email=1           the exact text that would be sent, so the message can be read before
//                      it reaches anyone
//
// Read-only. Firestore only. ZERO NuVizz calls.
import { isFirestoreEnabled, readStops, etDayString } from './lib/firestore.mts';
import { emailEnabled } from './lib/email.mts';
import { buildDayCompletion, dayCompletionSubject, dayCompletionText } from './lib/day-completion.mts';
import { listDayCompletions, readDayCompletion, HISTORY_DAYS } from './lib/day-completion-store.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b, null, 1), {
    status: s,
    // private, not public: the moment this body varies by principal (a viewer sees a board,
    // a stranger sees a 401) a SHARED cache in front of the site can hand one caller's day
    // to another. 60s of client-side reuse is all this ever wanted.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=60', Vary: 'Authorization' },
  });
  // Gate at viewer: the day's completion picture — every route, its stops and how far through
  // it the driver is. Inert until AUTH_REQUIRED=true (lib/require-user.mts).
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    if (url.searchParams.get('history') === '1') {
      const days = Math.max(1, Math.min(HISTORY_DAYS, Number(url.searchParams.get('days') || HISTORY_DAYS)));
      return J({ ok: true, days: await listDayCompletions(TENANT, days) });
    }

    const date = url.searchParams.get('date') || etDayString();
    const { stops } = await readStops(TENANT, date);
    if (!stops?.length) return J({ ok: true, date, note: 'no board for this date' });

    const live = buildDayCompletion(stops, { date, asOf: null });
    const stored = await readDayCompletion(TENANT, date);
    const full = url.searchParams.get('full') === '1';

    return J({
      ok: true, dryRun: true, date,
      // WHAT IT LOOKS LIKE RIGHT NOW — recomputed, not the stored one. Asked at 2pm this
      // says what 2pm looks like, which is the question somebody mid-afternoon is asking.
      live: full ? live : { ...live, openStops: undefined, unableStops: undefined },
      liveOpenCount: live.open,
      // WHAT WAS RECORDED AT 6:30, and how it graded out. Present only once the evening job
      // has run for this date — absent is "not yet", never "nothing happened".
      recorded: stored?.snapshot
        ? (full ? stored.snapshot : { ...stored.snapshot, openStops: undefined, unableStops: undefined })
        : null,
      reconciliation: stored?.reconciliation ?? null,
      // CAN THIS THING ACTUALLY MAIL ANYONE? Two booleans, never the addresses.
      //
      // Setting the recipient is a Netlify console action, so the code has no way to know it
      // happened — and the evening job's own status is written where nobody looks. That gap
      // is not hypothetical: the variable was set through an API that returned a gateway
      // error, and "is the report reaching Chad" then had no answer short of waiting until
      // 6:30 and asking him. A switch whose position cannot be read is not a switch.
      //
      // Booleans only. The value is a person's address on the company domain and must never
      // appear in a response body, a log, or a transcript — and knowing it is SET is the
      // whole question anyway.
      delivery: {
        emailConfigured: emailEnabled(),
        recipientConfigured: !!String(process.env.DAY_REPORT_TO || '').trim(),
        disabled: process.env.DAY_REPORT_ENABLED === '0',
      },
      ...(url.searchParams.get('email') === '1'
        ? { emailPreview: { subject: dayCompletionSubject(live), text: dayCompletionText(live) } }
        : {}),
    });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
