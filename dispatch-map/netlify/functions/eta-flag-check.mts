// eta-flag-check.mts
//
// "SHOW ME WHAT THE ALERT WOULD DO." A plain, click-driven endpoint — no cron attached.
//
// This exists because of a property of this project that is easy to forget and expensive to
// rediscover: A FUNCTION CARRYING A SCHEDULE IS NOT REACHABLE OVER PLAIN HTTP. The v0.54.21
// notes record it from the Scan-now button ("a scheduled function is not reliably reachable
// ... the cron fires it happily on its own timer while a manual POST to the same address
// gets refused"), and eta-miss-ledger-background answers a manual POST with a flat 403 today.
//
// So eta-flag-alert-background will email customer service on its own timer and nobody —
// including whoever built it — can ask it what it is about to do. That is the wrong shape for
// something that reaches a real inbox. This endpoint runs the SAME engine and the SAME
// selection rules, always dry: it never sends and never claims, so calling it cannot consume
// a stop's one alert for the day.
//
// It also reports what has ALREADY been claimed today, because "why did customer service not
// hear about this stop" is the question that actually gets asked, and the claim ledger is the
// only place the answer lives.
//
// Read-only. Firestore only. ZERO NuVizz calls.
import { isFirestoreEnabled, readStops, getDoc, listDocs, etDayString } from './lib/firestore.mts';
import { computeBoardFlags } from '../../src/lib/board-flags.js';
import { selectAlertable, buildAlert, ALERT_COLLECTION, ALERT_TO, DAILY_ALERT_CAP } from './lib/flag-alert.mts';
import { emailEnabled } from './lib/email.mts';

const TENANT = 'davis';
const DEPOT = { name: 'Buford Terminal', lat: 34.147791, lng: -83.960911 };

function etNowMin(): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  return Number(p.find((x) => x.type === 'hour')?.value ?? 0) * 60
       + Number(p.find((x) => x.type === 'minute')?.value ?? 0);
}
function weekdayKey(date: string): string | null {
  const [y, m, d] = String(date || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dt.getDay()];
}
const clock = (m: number) => {
  const h = Math.floor(m / 60), x = m % 60, ap = h >= 12 ? 'p' : 'a', h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(x).padStart(2, '0')}${ap}`;
};

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date') || etDayString();
    const nowParam = url.searchParams.get('now');
    // `?now=` lets a dispatcher ask "what will this look like at 2pm" without waiting for 2pm.
    const nowMin = nowParam ? Number(nowParam) : (date === etDayString() ? etNowMin() : null);

    const { stops } = await readStops(TENANT, date);
    if (!stops?.length) return J({ ok: true, date, note: 'no board for this date' });

    const keys = [...new Set(stops.map((s: any) => String(s?.matchKey || '')).filter(Boolean))];
    const notes = new Map<string, any>();
    for (let i = 0; i < keys.length; i += 25) {
      await Promise.all(keys.slice(i, i + 25).map(async (k) => {
        try { const d = await getDoc(`customer_notes/${k}`); if (d) notes.set(k, d); } catch { /* no note is ordinary */ }
      }));
    }

    const flags = computeBoardFlags({
      stops, notes, servedDate: date, dayKey: weekdayKey(date),
      opts: { depot: DEPOT, ...(nowMin != null ? { nowMin } : {}) },
    });

    const criticals = (flags.rows || []).filter((r: any) => r.rule === 'hours_risk' && r.tier === 'critical');
    const alertable = selectAlertable(flags.rows, nowMin);
    const alertableSet = new Set(alertable.map((c) => c.stopNbr));

    // What has already been claimed today. A claim means an email was attempted; it is
    // deliberately kept even when the send failed, so this list answers "why no second one".
    let claimed: any[] = [];
    try {
      const docs = await listDocs(ALERT_COLLECTION);
      claimed = (docs || [])
        .filter((d: any) => d?.tenant === TENANT && d?.date === date)
        .map((d: any) => ({ stopNbr: d.stopNbr, customer: d.customer, lateBy: d.lateBy, claimed_at: d.claimed_at }));
    } catch { /* the collection does not exist until the first claim */ }

    // PROVE IT LOOKED. A bare "0 critical" is indistinguishable from "the notes never
    // loaded and every stop looked deadline-free" — the silent-zero failure this endpoint
    // exists to catch. computeBoardFlags already counts what it examined; surface it.
    const diag = {
      stopsSeen: stops.length,
      distinctCustomerKeys: keys.length,
      notesLoaded: notes.size,
      stopsWithHoursToday: flags.checked?.stopsWithHours ?? null,
      routesJudged: flags.checked?.routesJudged ?? null,
      openStopsChecked: flags.checked?.stops ?? null,
      skipped: flags.skipped,
      sampleStopKeys: stops.slice(0, 3).map((s: any) => s?.matchKey ?? null),
    };

    return J({
      ok: true, dryRun: true, date, diag,
      now: nowMin != null ? clock(nowMin) : null,
      emailConfigured: emailEnabled(), to: ALERT_TO, dailyCap: DAILY_ALERT_CAP,
      counts: { critical: flags.criticalCount ?? 0, red: flags.redCount ?? 0, amber: flags.amberCount ?? 0 },
      // Every critical row, and for each one WHY it would or would not be emailed right now.
      critical: criticals.map((r: any) => ({
        stopNbr: r.stopNbr, customer: r.customer, route: r.routeName,
        close: clock(r.closeMin), eta: clock(r.etaMin), lateBy: r.lateBy,
        anchored: r.anchored, errorBand: r.errorMin,
        wouldEmailNow: alertableSet.has(String(r.stopNbr)),
        heldBecause: alertableSet.has(String(r.stopNbr)) ? null
          : (nowMin != null && nowMin >= r.closeMin ? 'the window has already closed' : 'not an individual stop row'),
      })),
      alreadyClaimedToday: claimed,
      wouldSendNow: alertable.filter((c) => !claimed.some((x) => x.stopNbr === c.stopNbr)).length,
      sample: alertable[0] ? buildAlert(alertable[0], date).subject : null,
    });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
