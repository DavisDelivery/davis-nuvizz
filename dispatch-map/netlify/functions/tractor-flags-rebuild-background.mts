// tractor-flags-rebuild-background.mts
//
// One-time (re-runnable) backfill of tractor_locations FROM the immutable
// history warehouse (history_days) + the MarginIQ employee roster. Reads only
// our own Firestore — NEVER calls NuVizz. Mirrors
// nuvizz-rebuild-customer-history-background.
//
// Idempotent by construction: every location's values are computed fresh from
// scratch across ALL scanned partitions in this run and then written as a full
// overwrite — no blind accumulation on top of prior docs. This is also the
// RE-TAG path: when a driver gains (or loses) the Tractor tag in MarginIQ,
// re-running this re-derives everything from the roster as it stands now.
//
// Background fn (15-min budget). No schedule — run on demand:
//   POST /.netlify/functions/tractor-flags-rebuild-background        → ALL captured days
//     ?date=YYYY-MM-DD                → single day
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD  → inclusive range
import { isFirestoreEnabled, listDocs } from './lib/firestore.mts';
import { requireUserForBackground } from './lib/background-gate.mts';
import { HISTORY_COLLECTION, listStops } from './lib/history-store.mts';
import {
  loadTractorRoster, aggregateTractorStops, writeTractorLocationsFresh,
  normalizeDriverAlias, type TractorLocAgg,
} from './lib/tractor-flags.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Every captured date = the day partitions present in history_days (manifest doc
// ids are `{tenant}__{date}`). Firestore-only enumeration, no NuVizz.
async function listCapturedDates(): Promise<string[]> {
  const manifests = await listDocs(HISTORY_COLLECTION);
  return manifests
    .map((m) => String(m?._id || ''))
    .filter((id) => id.startsWith(`${TENANT}__`))
    .map((id) => id.slice(TENANT.length + 2))
    .filter((d) => DATE_RE.test(d))
    .sort();
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  if (!isFirestoreEnabled()) {
    return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SA not set' }), { status: 200, headers });
  }
  // GATED AT admin. A rebuild overwrites tractor_locations wholesale — the lime pins that tell
  // a dispatcher a 53' trailer has physically been to an address — and it is the re-tag path,
  // so a run against a mis-set roster silently un-paints locations. Netlify already answered
  // 202 and discarded our status (lib/background-gate.mts); run by hand, no doc a screen
  // polls, so the refusal lands in nuvizz_ops/background_refusals.
  const gate = await requireUserForBackground(req, 'tractor-flags-rebuild-background', { role: 'admin' });
  if (!gate.ok) return gate.response;
  const t0 = Date.now();
  const url = new URL(req.url);
  const one = url.searchParams.get('date');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  let dates = await listCapturedDates();
  if (one && DATE_RE.test(one)) dates = dates.filter((d) => d === one);
  else if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) {
    const lo = from < to ? from : to, hi = from < to ? to : from;
    dates = dates.filter((d) => d >= lo && d <= hi);
  }

  const roster = await loadTractorRoster(true);
  console.log(`[tractor-rebuild] roster: ${roster.aliasSet.size} alias(es) from ${roster.tractorCount} tractor employee(s); ` +
    `${roster.skippedNoAlias.length} skipped (no alias); ${dates.length} date partition(s) to scan`);

  // QA: per-alias hit counts, so an alias that matches ZERO history drivers
  // (likely a typo on the MarginIQ card) is reported by name.
  const aliasHits = new Map<string, number>([...roster.aliasSet].map((a) => [a, 0]));

  const agg = new Map<string, TractorLocAgg>();
  let stopsScanned = 0;
  let matchedStops = 0;
  for (const date of dates) {
    const stops = await listStops(TENANT, date);
    stopsScanned += stops.length;
    const before = [...agg.values()].reduce((s, a) => s + a.delivery_count, 0);
    aggregateTractorStops(stops, roster, agg);
    const after = [...agg.values()].reduce((s, a) => s + a.delivery_count, 0);
    matchedStops = after;
    for (const s of stops) {
      if (s?.normalizedStatus !== 'DELIVERED') continue;
      for (const key of [normalizeDriverAlias(s?.driverName), normalizeDriverAlias(s?.driverUserName)]) {
        if (key && aliasHits.has(key)) aliasHits.set(key, (aliasHits.get(key) || 0) + 1);
      }
    }
    console.log(`[tractor-rebuild] ${date}: ${stops.length} stops, +${after - before} tractor deliveries (running: ${after} across ${agg.size} locations)`);
  }

  const written = await writeTractorLocationsFresh(TENANT, agg);
  const zeroHitAliases = [...aliasHits.entries()]
    .filter(([, n]) => n === 0)
    .map(([a]) => ({ alias: a, employee: roster.aliasToName.get(a) || null }));

  const summary = {
    ok: true,
    tenant: TENANT,
    datePartitionsScanned: dates.length,
    stopsEvaluated: stopsScanned,
    tractorDriversLoaded: roster.aliasSet.size,
    tractorEmployeesTotal: roster.tractorCount,
    skippedNoAlias: roster.skippedNoAlias,
    matchedTractorDeliveries: matchedStops,
    locationsFlagged: agg.size,
    docsWritten: written,
    aliasesWithZeroHistoryMatches: zeroHitAliases,
    ms: Date.now() - t0,
  };
  console.log('[tractor-rebuild] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
