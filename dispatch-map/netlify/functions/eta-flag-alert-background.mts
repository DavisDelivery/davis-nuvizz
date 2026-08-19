// eta-flag-alert-background.mts
//
// WATCHES TODAY'S BOARD AND EMAILS CUSTOMER SERVICE THE FIRST TIME A STOP GOES CRITICAL.
//
// Chad asked for this in the same breath as the tier rework: "if something gets a red flag,
// that we should send a email to customer service at Davis delivery dot com... needs to only
// send the email the first time the flag appears as a red flag which could come later in day
// if a driver gets behind... if we are already past the time shouldn't send."
//
// It runs the SAME flag engine the board runs — src/lib/board-flags.js, imported, not
// reimplemented. That is deliberate and it is the second time this session the point has
// come up: the ETA back-test re-implemented the model's accessors and silently diverged in
// three places, changing which routes were scored. An alert that fires off a COPY of the
// rules would eventually page customer service about a stop the dispatcher's screen never
// flagged, and nobody would be able to say which one was lying.
//
// Data diet: the Firestore stop index the scanner already writes, plus customer_notes for
// receiving hours. ZERO NuVizz calls — this never triggers a scan, it reads what the last
// scan left behind.
//
// ── Schedule: every 20 minutes through the working day, ET ───────────────────
// The scan itself refreshes every 15 minutes, so anything tighter re-reads the same board.
// Cron is UTC: 11:00-23:59 UTC covers roughly 07:00-19:59 ET, which brackets the delivery
// day either side of a DST flip without needing to be re-timed twice a year.
import { isFirestoreEnabled, readStops, getDoc, setDoc, createDocIfAbsent, etDayString } from './lib/firestore.mts';
import { computeBoardFlags } from '../../src/lib/board-flags.js';
import { withCustomerKeys, stopCustomerKey } from './lib/customer-key.mts';
import { selectAlertable, sendAlerts, ALERT_TO } from './lib/flag-alert.mts';
import { mergeSweep, flagHistoryPath, FLAG_HISTORY_VERSION } from './lib/flag-history.mts';
import { emailEnabled } from './lib/email.mts';

const TENANT = 'davis';
const DEPOT = { name: 'Buford Terminal', lat: 34.147791, lng: -83.960911 };

export const config = { schedule: '*/20 11-23 * * 1-5' };

/** ET wall-clock minutes past midnight — the same clock the board's own nowMin uses. */
function etNowMin(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}
function weekdayKey(date: string): string | null {
  const [y, mo, d] = String(date || '').split('-').map(Number);
  if (!y || !mo || !d) return null;
  const dt = new Date(y, mo - 1, d, 12, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dt.getDay()];
}

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    // DRY RUN is the default-safe way to look at this: it computes and reports exactly what
    // WOULD be emailed, claims nothing and sends nothing.
    const dry = url.searchParams.get('dry') === '1';
    const date = url.searchParams.get('date') || etDayString();
    const nowMin = url.searchParams.get('now')
      ? Number(url.searchParams.get('now'))
      : (date === etDayString() ? etNowMin() : null);

    const { stops: rawStops } = await readStops(TENANT, date);
    // THE LIVE STOP INDEX DOES NOT CARRY matchKey. computeBoardFlags looks its receiving
    // hours up by stop.matchKey, so without this every stop reads as having no deadline and
    // the whole board comes back clean — measured: 778 stops, 63 routes judged, 0 flags.
    const stops = withCustomerKeys(rawStops);
    if (!stops?.length) return J({ ok: true, date, note: 'no board', alertable: 0 });

    // Receiving hours live in customer_notes, one doc per customer key. Read each distinct
    // key once — a 700-stop board is only a few hundred customers.
    const keys = [...new Set(stops.map((s: any) => stopCustomerKey(s)).filter(Boolean) as string[])];
    const notes = new Map<string, any>();
    const CHUNK = 25;
    for (let i = 0; i < keys.length; i += CHUNK) {
      await Promise.all(keys.slice(i, i + CHUNK).map(async (k) => {
        try { const d = await getDoc(`customer_notes/${k}`); if (d) notes.set(k, d); } catch { /* a missing note is the ordinary case */ }
      }));
    }

    const flags = computeBoardFlags({
      stops, notes, servedDate: date, dayKey: weekdayKey(date),
      opts: { depot: DEPOT, ...(nowMin != null ? { nowMin } : {}) },
    });

    const candidates = selectAlertable(flags.rows, nowMin);

    // ── KEEP THE FLAG, NOT JUST THE EMAIL ─────────────────────────────────────
    //
    // Chad: "I want to build a history of flags... somewhere that tracks all the flags that
    // have presented itself." Until now a flag was a live computation — painted on the
    // board and discarded. The only durable trace was the alert claim, which exists only
    // for stops that earned an EMAIL, so ambers and post-close reds left no record that
    // they ever happened.
    //
    // This sweep already computes the whole board. Folding the result into the day's row
    // set costs one read and one write and no NuVizz calls, and it is what makes "did the
    // flag do any good" answerable at all. See lib/flag-history.mts.
    //
    // Never lets a bookkeeping failure stop an alert: the email is the job, this is the
    // record of it.
    let recorded: any = { added: 0, updated: 0 };
    if (!dry && nowMin != null) {
      try {
        const path = flagHistoryPath(TENANT, date);
        const prev = await getDoc(path);
        const merged = mergeSweep(prev?.rows, flags.rows, {
          nowMin,
          atISO: new Date().toISOString(),
          // Stops already claimed today have had their email attempted. Reading the claim
          // rather than this run's result means a stop that alerted at 9:40 still reads as
          // emailed on the 14:00 sweep.
          emailedStops: new Set(candidates.map((c) => String(c.stopNbr))),
        });
        await setDoc(path, {
          tenant: TENANT, date, version: FLAG_HISTORY_VERSION,
          updated_at: new Date().toISOString(),
          rows: merged.rows,
        });
        recorded = { added: merged.added, updated: merged.updated, tracked: Object.keys(merged.rows).length };
      } catch (e: any) {
        console.error('flag history write failed (non-fatal):', e?.message);
        recorded = { error: String(e?.message || e) };
      }
    }

    const base = {
      recorded,
      ok: true, date, nowMin,
      critical: flags.criticalCount ?? 0, red: flags.redCount ?? 0, amber: flags.amberCount ?? 0,
      alertable: candidates.length,
      candidates: candidates.map((c) => ({ stopNbr: c.stopNbr, customer: c.customer, lateBy: c.lateBy })),
    };
    if (dry) return J({ ...base, dryRun: true });
    if (!emailEnabled()) return J({ ...base, sent: 0, note: 'email not configured (RESEND_API_KEY unset)' });

    const result = await sendAlerts(candidates, date, TENANT, { createDocIfAbsent }, ALERT_TO);
    return J({ ...base, ...result, to: ALERT_TO });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
