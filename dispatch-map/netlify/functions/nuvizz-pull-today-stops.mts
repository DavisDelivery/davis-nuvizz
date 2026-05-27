// nuvizz-pull-today-stops.mts  (M5.2)
//
// Map data feed. Reads the pre-scanned Firestore stop index
// (nuvizz_stop_index/{tenant}__{date}) and returns instantly (<2s) — the heavy
// NuVizz number-space scan runs in nuvizz-refresh-stops-background.mts, NOT here.
//
// Why: NuVizz v7 has no bulk "stops for a date" endpoint (verified live), so the
// only way to get a day's stops (esp. UNPLANNED status-10 orders) is to scan the
// number space. Inline that scan is >22s and 502s past the 26s request cap. So
// we serve cached, pre-scanned data and surface its freshness to the UI.
//
// Query params:
//   date=YYYY-MM-DD   optional, defaults to today UTC
//   mock=1            return the bundled fixture (no Firestore/NuVizz)
//   live=1            DEBUG: bypass the index and scan NuVizz live (may exceed
//                     the 26s cap for the unplanned scan — not for normal use)

import fixture from '../../test/fixtures/nuvizz-today-stops.json' with { type: 'json' };
import { scanDate, todayUTC, normalizeStop } from './lib/nuvizz-scan.mts';
import { isFirestoreEnabled, readStops } from './lib/firestore.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayUTC();
  const useMock = url.searchParams.get('mock') === '1';
  const live = url.searchParams.get('live') === '1';
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  try {
    let stops: any[];
    let source: 'firestore' | 'fixture' | 'live-scan' | 'index-empty' = 'firestore';
    let lastScannedAt: string | null = null;

    if (useMock) {
      stops = ((fixture as any).stops || []).map(normalizeStop);
      source = 'fixture';
    } else if (live) {
      // DEBUG path — scan NuVizz directly. May time out on the unplanned scan.
      const scan = await scanDate(date);
      stops = scan.stops;
      lastScannedAt = scan.scannedAt;
      source = 'live-scan';
    } else if (isFirestoreEnabled()) {
      const { meta, stops: indexed } = await readStops(TENANT, date);
      stops = indexed;
      lastScannedAt = meta?.last_scanned_at ?? null;
      // Empty index (background scan hasn't populated this date yet) is a normal
      // state, not an error — the UI shows an honest "no scan yet" empty state.
      source = indexed.length ? 'firestore' : 'index-empty';
    } else {
      // No Firestore configured (e.g. preview without FIREBASE_SA) → fixture so
      // the UI still renders something in dev/preview.
      stops = ((fixture as any).stops || []).map(normalizeStop);
      source = 'fixture';
    }

    const unplannedCount = stops.filter((s) => s.isUnplanned).length;
    return new Response(JSON.stringify({
      ok: true,
      date,
      source,
      generated: new Date().toISOString(),
      lastScannedAt,
      count: stops.length,
      unplannedCount,
      stops,
    }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({
      ok: false,
      error: e.message,
      status: e.status || 500,
      body: e.body,
    }), { status: e.status || 500, headers: cors });
  }
};
