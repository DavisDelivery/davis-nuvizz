// tractor-flags-rebuild-background.mts
//
// One-time (re-runnable) backfill of tractor_locations FROM the immutable
// history warehouse (history_days) + the MarginIQ employee roster. Reads only
// our own Firestore — NEVER calls NuVizz. Mirrors
// nuvizz-rebuild-customer-history-background.
//
// The ALL-DAYS run (no ?date / ?from&to) is idempotent by construction: every
// location's values are computed fresh from scratch across every captured
// partition and then written as a full overwrite — no blind accumulation on top
// of prior docs. That run is also the RE-TAG path: when a driver gains (or loses)
// the Tractor tag in MarginIQ, re-running it re-derives everything from the roster
// as it stands now. A windowed run merges instead; see below.
//
// Background fn (15-min budget). No schedule — run on demand:
//   POST /.netlify/functions/tractor-flags-rebuild-background        → ALL captured days
//     ?date=YYYY-MM-DD                → single day
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD  → inclusive range
//
// ONLY THE ALL-DAYS RUN OVERWRITES. A window has seen a slice of each location's history, so
// writing it as a full overwrite replaced lifetime counts, first-served dates and drivers with
// the window's. A window is folded in day by day through the nightly pass's sticky merge
// (mergeTractorDay): dates only widen, drivers only add, a day already counted is not counted
// again. It can backfill; it cannot un-flag or re-tag — that is what the all-days run is for.
import { isFirestoreEnabled, listDocs } from './lib/firestore.mts';
import { requireUserForBackground } from './lib/background-gate.mts';
import { HISTORY_COLLECTION, listStops } from './lib/history-store.mts';
import {
  loadTractorRoster, aggregateTractorStops, writeTractorLocationsFresh, mergeTractorDay,
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
  let windowed = false;
  if (one && DATE_RE.test(one)) { dates = dates.filter((d) => d === one); windowed = true; }
  else if (from && to && DATE_RE.test(from) && DATE_RE.test(to)) {
    const lo = from < to ? from : to, hi = from < to ? to : from;
    dates = dates.filter((d) => d >= lo && d <= hi);
    windowed = true;
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
  let mergedWrites = 0;
  for (const date of dates) {
    const stops = await listStops(TENANT, date);
    stopsScanned += stops.length;
    const before = [...agg.values()].reduce((s, a) => s + a.delivery_count, 0);
    aggregateTractorStops(stops, roster, agg);
    // A window merges each day into the lifetime docs, oldest first; see the header.
    if (windowed) mergedWrites += await mergeTractorDay(TENANT, date, aggregateTractorStops(stops, roster));
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

  const written = windowed ? mergedWrites : await writeTractorLocationsFresh(TENANT, agg);
  const zeroHitAliases = [...aliasHits.entries()]
    .filter(([, n]) => n === 0)
    .map(([a]) => ({ alias: a, employee: roster.aliasToName.get(a) || null }));

  const summary = {
    ok: true,
    tenant: TENANT,
    // 'window-merge' folded the window into existing docs; 'full-overwrite' recomputed all of them.
    mode: windowed ? 'window-merge' : 'full-overwrite',
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
