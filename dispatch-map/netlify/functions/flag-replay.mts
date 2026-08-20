// flag-replay.mts — replay today's flag engine over ONE sealed day, and grade it.
//
// Chad: "we need to go back and study all the data that we have to see how our flagging
// system would work and whether or not things that ended up delivering after the receiving
// hours in the data we have would have been flagged."
//
//   GET /.netlify/functions/flag-replay?date=YYYY-MM-DD
//      &sweepMin=20     simulated sweep cadence (default 20, the live cron's)
//      &fromMin=420     first simulated sweep, minutes past midnight ET (default 7:00a — live window)
//      &toMin=1180      last simulated sweep (default 7:40p — live window)
//      &rows=1          include the per-stop verdict rows, not just the summary
//
// One day per request, by design: a multi-week replay blows the 26-second function budget
// (netlify.toml caps this function there), and a runner looping dates composes trivially.
// Read-only over history_days + customer_notes + the travel cache. ZERO NuVizz calls, zero
// Google fetches (the leg cache is read with an empty want-list, which never bills), zero
// writes anywhere. Always dry: this endpoint exists to measure the alert, never to send it.
//
// The result is a RECONSTRUCTION and says so in the payload: receiving hours are read from
// customer_notes as they exist today (notes are not versioned), so this grades how TODAY'S
// system would have done on that board — Chad's question — not what was knowable that morning.
import { isFirestoreEnabled, getDoc } from './lib/firestore.mts';
import { listStops } from './lib/history-store.mts';
import { withCustomerKeys, stopCustomerKey } from './lib/customer-key.mts';
import { readTravelCalibration, ensureLegs } from './lib/travel-store.mts';
import { sweepGrid, replayDay, judgeDay, summarizeReplay, REPLAY_VERSION } from './lib/flag-replay-core.mts';

const TENANT = 'davis';
const DEPOT = { name: 'Buford Terminal', lat: 34.147791, lng: -83.960911 };

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return J({ ok: false, error: 'pass ?date=YYYY-MM-DD (one sealed day per request)' }, 400);
    }
    const sweepMin = Math.max(5, Math.min(120, Number(url.searchParams.get('sweepMin') || 20)));
    const fromMin = Math.max(0, Math.min(1439, Number(url.searchParams.get('fromMin') || 420)));
    const toMin = Math.max(fromMin, Math.min(1439, Number(url.searchParams.get('toMin') || 1180)));
    const wantRows = url.searchParams.get('rows') === '1';

    const sealed = await listStops(TENANT, date);
    if (!sealed?.length) return J({ ok: true, date, note: 'day not captured in history_days', gradable: 0 });
    const stops = withCustomerKeys(sealed);

    // Same notes read as the live sweep: one doc per distinct customer key.
    const keys = [...new Set(stops.map((s: any) => stopCustomerKey(s)).filter(Boolean) as string[])];
    const notes = new Map<string, any>();
    const CHUNK = 25;
    for (let i = 0; i < keys.length; i += CHUNK) {
      await Promise.all(keys.slice(i, i + CHUNK).map(async (k) => {
        try { const d = await getDoc(`customer_notes/${k}`); if (d) notes.set(k, d); } catch { /* missing note = ordinary */ }
      }));
    }

    // Same travel inputs as the live sweep — cached real legs plus the nightly curve — so
    // the replay prices legs exactly like today's board. Empty want-list: pure cache read.
    const cal = await readTravelCalibration(TENANT).catch(() => null);
    const legInfo = await ensureLegs(TENANT, []).catch(() => ({ legs: {} as Record<string, number> }));
    const travel = { legs: legInfo.legs || {}, ...(cal ? { curve: cal.curve, serviceMin: cal.serviceMin } : {}) };

    const grid = sweepGrid(fromMin, toMin, sweepMin);
    const { trajectories, sweepsRun, lastSkipped } = replayDay({ stops, notes, date, grid, depot: DEPOT, travel });
    const { rows, ungradable } = judgeDay({ stops, notes, date, trajectories });
    const summary = summarizeReplay(rows);

    return J({
      ok: true, date, reconstructed: true, version: REPLAY_VERSION,
      caveat: 'receiving hours read from customer_notes as of today — grades how the CURRENT system would have done on this sealed board',
      grid: { fromMin, toMin, sweepMin, sweepsRun },
      board: { stops: stops.length, customersWithNotes: notes.size, engineChecked: lastSkipped },
      travel: { cachedLegs: Object.keys(travel.legs).length, calibrated: !!cal },
      summary, ungradable,
      ...(wantRows ? { rows } : {}),
    });
  } catch (err: any) {
    return J({ ok: false, error: String(err?.message || err) }, 500);
  }
};
