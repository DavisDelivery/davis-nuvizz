// netlify/functions/order-arrivals.mts
//
// ── WHAT TIME THE ORDERS HIT OUR SYSTEM, AND IS TONIGHT HEAVY ────────────────
//
// Chad, Sep 2026: "I want a durable way of knowing what time the orders hit our system and
// tracking that information in the manifest to try to see if we can predict days when the
// volume is heavier than normal, sooner than at the end of the day."
//
//   GET  ?date=YYYY-MM-DD          the day's curve so far, the same-weekday normal, the verdict
//   GET  ?date=…&uline=1           the 9-digit-PRO subset instead of every order on the board
//   GET  ?explain=1&date=…         WHERE THE NUMBER CAME FROM: coverage, first/last stamp,
//                                  the raw buckets, and which sealed nights the normal used
//   GET  ?days=N                   the sealed nights on file, newest first (coverage strip)
//   POST {action:'seal', date}     seal one night                                — dispatcher
//   POST {action:'backfill', from, to[, dry]}  seal a range, ≤60 days            — admin
//
// ZERO NuVizz. Every module this file imports is Firestore or pure. The curve is read off
// `enriched_at`, a stamp the scan already wrote the first time it ever saw each order, so the
// history can be backfilled over days that were indexed long before this endpoint existed.
//
// ?explain=1 IS NOT A NICETY, AND IT ALREADY EARNED ITS KEEP. v1.26.0 built this on
// `enriched_at`, a premise read out of the code rather than measured. The first explain read
// against the live index answered: 643 stops on the next delivery day, TWO of them stamped.
// The guard did its job — it printed the coverage and refused to project instead of dividing
// by a third of a board and calling the result a forecast. v1.27.0 replaces the stamp; this
// endpoint keeps reporting coverage on every read so the next wrong premise is as cheap.

import { isFirestoreEnabled } from './lib/firestore.mts';
import { requireUser, readJsonBody } from './lib/require-user.mts';
import { operatingDayET } from '../../src/lib/uline-forecast-score.js';
import { assess, checkpoints, MIN_COVERAGE, MIN_BASELINE_DAYS, MIN_PROJECT_FRACTION, HEAVY_RATIO, LIGHT_RATIO } from '../../src/lib/order-arrivals.js';
import { nextDeliveryDay } from '../../src/lib/manifest-window.js';
import {
  curvesForDate, baselineFor, readSealed, sealDate, listSealed, arrivalsEnabled, TENANT,
} from './lib/order-arrivals-store.mts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const J = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BACKFILL_DAYS = 60;
const DEFAULT_WEEKS = 6;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The thresholds ride along on every answer so the screen can explain itself without a second
 *  copy of the numbers drifting out of step with the module that enforces them. */
const RULES = { minCoverage: MIN_COVERAGE, minBaselineDays: MIN_BASELINE_DAYS, minProjectFraction: MIN_PROJECT_FRACTION, heavyRatio: HEAVY_RATIO, lightRatio: LIGHT_RATIO };

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore off', note: 'Firestore off', sealed: [] });

  const url = new URL(req.url);
  const today = operatingDayET(Date.now()) as string;
  const nowMs = Date.now();

  if (req.method === 'GET') {
    const gate = await requireUser(req, { role: 'viewer' });
    if (!gate.ok) return gate.response;
    try {
      if (url.searchParams.get('days')) {
        const n = Math.min(180, Math.max(1, Number(url.searchParams.get('days')) || 60));
        return J({ ok: true, today, sealed: await listSealed(TENANT, n), rules: RULES, enabled: arrivalsEnabled() });
      }

      const which = url.searchParams.get('uline') === '1' ? 'uline' : 'all';
      // The day the evening is actually building: the next delivery day, not today.
      const date = url.searchParams.get('date') || nextDeliveryDay(today) || today;
      if (!DATE_RE.test(date)) return J({ ok: false, error: 'date=YYYY-MM-DD' }, 400);
      const weeks = Math.min(12, Math.max(1, Number(url.searchParams.get('weeks')) || DEFAULT_WEEKS));

      const [curves, baseline] = await Promise.all([curvesForDate(TENANT, date), baselineFor(TENANT, date, weeks, which)]);
      if (!curves) return J({ ok: false, error: 'no index for this date', date }, 404);
      const curve = curves[which];
      const verdict = assess({ curve, nowMs, baseline, deliveryDate: date });
      const marks = checkpoints({ curve, baseline, nowMs, deliveryDate: date });

      if (url.searchParams.get('explain') === '1') {
        const dates = baseline?.dates ?? [];
        const sealedHere = await readSealed(TENANT, date);
        return J({
          ok: true, today, date, which, rules: RULES, enabled: arrivalsEnabled(),
          // The premise, measured rather than assumed.
          coverage: {
            total: curve.total, stamped: curve.stamped, unstamped: curve.unstamped,
            pct: curve.coverage == null ? null : Math.round(curve.coverage * 100),
            firstAt: curve.firstAt, lastAt: curve.lastAt, afterRoll: curve.afterRoll,
            // Which field each stamp came from — a curve on the legacy fallback must not
            // look like one on the vendor stamp.
            sources: curve.sources ?? {},
            note: curve.total === 0 ? 'no stops indexed for this date'
              : curve.stamped === 0 ? 'NOT ONE stop on this date carries an arrival stamp — every stop here predates the first-sight stamp, so this day can never be sealed'
              : (curve.coverage as number) < MIN_COVERAGE ? 'coverage below the floor — counts are real, the projection is refused'
              : 'coverage is sufficient to project',
          },
          buckets: curve.buckets,
          baseline: { n: baseline.n, ready: baseline.ready, dates, typicalFinal: baseline.typicalFinal, fraction: baseline.fraction },
          sealed: sealedHere ? { sealedAt: sealedHere.sealedAt, total: sealedHere?.all?.total ?? null } : null,
          verdict, checkpoints: marks,
          alsoUline: which === 'all' ? { total: curves.uline.total, stamped: curves.uline.stamped } : null,
        });
      }

      return J({
        ok: true, today, date, which, rules: RULES, enabled: arrivalsEnabled(),
        curve: { total: curve.total, stamped: curve.stamped, unstamped: curve.unstamped, coverage: curve.coverage, firstAt: curve.firstAt, lastAt: curve.lastAt, buckets: curve.buckets },
        baseline: { n: baseline.n, ready: baseline.ready, dates: baseline.dates, typicalFinal: baseline.typicalFinal },
        verdict, checkpoints: marks,
        ulineTotal: curves.uline.total,
      });
    } catch (err: any) {
      return J({ ok: false, error: String(err?.message || err).slice(0, 200), note: 'read failed', sealed: [] }, 500);
    }
  }

  if (req.method !== 'POST') return J({ ok: false, error: 'GET or POST' }, 405);
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const action = String(body.body?.action || '');
  const atISO = new Date().toISOString();

  if (action === 'seal') {
    const gate = await requireUser(req, { role: 'dispatcher' });
    if (!gate.ok) return gate.response;
    const date = String(body.body?.date || '');
    if (!DATE_RE.test(date)) return J({ ok: false, error: 'date=YYYY-MM-DD' }, 400);
    const out = await sealDate(TENANT, date, atISO);
    console.log('[order-arrivals]', JSON.stringify({ mode: 'seal', by: gate.user.username, ...out }));
    return J({ ok: out.ok !== false, result: out, by: gate.user.username });
  }

  if (action === 'backfill') {
    const gate = await requireUser(req, { role: 'admin' });
    if (!gate.ok) return gate.response;
    const from = String(body.body?.from || '');
    const to = String(body.body?.to || '');
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return J({ ok: false, error: 'from/to=YYYY-MM-DD, from <= to' }, 400);
    const dates: string[] = [];
    for (let d = from; d <= to && dates.length <= MAX_BACKFILL_DAYS; d = addDays(d, 1)) dates.push(d);
    if (dates.length > MAX_BACKFILL_DAYS) return J({ ok: false, error: `range too wide — ${MAX_BACKFILL_DAYS} days per call` }, 400);
    // A dry run LISTS what it would seal and writes nothing. A backfill that overwrites sixty
    // sealed nights is not an operation to discover the shape of by running it.
    if (body.body?.dry) {
      const peek = await Promise.all(dates.map(async (d) => {
        const c = await curvesForDate(TENANT, d);
        return { date: d, total: c?.all.total ?? 0, stamped: c?.all.stamped ?? 0, sealed: !!(await readSealed(TENANT, d)) };
      }));
      return J({ ok: true, dry: true, dates: peek, by: gate.user.username });
    }
    const results = [];
    for (const d of dates) results.push(await sealDate(TENANT, d, atISO));
    const sealed = results.filter((r) => r.ok).length;
    console.log('[order-arrivals]', JSON.stringify({ mode: 'backfill', by: gate.user.username, from, to, sealed, skipped: results.length - sealed }));
    return J({ ok: true, sealed, skipped: results.length - sealed, results, by: gate.user.username });
  }

  return J({ ok: false, error: "action must be 'seal' or 'backfill'" }, 400);
};
