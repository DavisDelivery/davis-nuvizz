// nuvizz-loads-roster.mts
//
// Load roster for a given board date — the FULL list of that day's loads (route name,
// status, trip/stop count), INCLUDING empty loads created but not yet filled with orders.
// The stop-grouped Loads view can't show an empty load (it has no stops to group), so the
// dispatcher couldn't see e.g. Monday's empty loads waiting for orders. This surfaces them.
//
// SOURCE PREFERENCE:
//   1. The cached roster the background scanner persists per date (incl. the next business
//      day, captured ONCE — next-day loads are static). Instant, zero NuVizz calls.
//   2. Fallback: one live PkgRoute filterdata call (the portal's "Loads" grid,
//      customListDefId 35833), which is then cached so the next read is free.
//   ?live=1 forces the live pull (and refreshes the cache) — for an explicit "refresh".
//
// Best-effort: an error returns ok:false and the UI just shows the stop-grouped loads it
// already has. Creds stay server-side.
//
//   GET ?date=YYYY-MM-DD [&live=1]  → { ok, date, source, at, count, loads:[{loadId,name,status,trips}] }
import { loadRosterForDate } from './lib/nuvizz-loads.mts';
import { isFirestoreEnabled, readLoadRoster, writeLoadRoster, markLoadRosterEmpty } from './lib/firestore.mts';
import { acceptRosterWrite, shouldSpendLiveRoster } from './lib/roster-write.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  // Gate at viewer: ?live=1 skips the cache and pulls the roster STRAIGHT FROM NUVIZZ — a
  // metered call per hit on an open GET. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const date = url.searchParams.get('date') || '';
  const live = url.searchParams.get('live') === '1';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ ok: false, reason: 'missing or bad date (YYYY-MM-DD)' }), { status: 400, headers: cors });
  }
  try {
    // 1) Cached roster (scanner-persisted) — instant, no NuVizz call. Skipped on ?live=1.
    let cached = null as Awaited<ReturnType<typeof readLoadRoster>> | null;
    if (!live && isFirestoreEnabled()) {
      cached = await readLoadRoster(TENANT, date).catch(() => null);
      if (cached && cached.loads.length) {
        return new Response(JSON.stringify({ ok: true, date, source: 'cache', at: cached.at, count: cached.loads.length, loads: cached.loads }), { status: 200, headers: cors });
      }
      // AN EMPTY CACHE USED TO MEAN "PAY AGAIN", EVERY TIME. The fall-through below is the
      // never-captured path and is right for that — but the client has THREE automatic fetch
      // sites (the Map routes panel, the bottom grid's Loads view, the Routing rail), so once a
      // date's roster was genuinely empty every page load and every date change spent three
      // NuVizz calls to be told the same nothing, and wrote the same nothing back. Chad,
      // counting: "each refresh is causing like 14 calls when it should only be 3 or 4."
      // A recorded empty is now served for free inside its cooldown, and retried after it, so a
      // day that fills up later still lands without anybody pressing anything.
      const spend = shouldSpendLiveRoster(cached, Date.now());
      if (!spend.spend) {
        return new Response(JSON.stringify({
          ok: true, date, source: 'cache-empty', at: cached?.at ?? null, count: 0, loads: [], note: spend.reason,
        }), { status: 200, headers: cors });
      }
    }
    // 2) Live fetch — one deliberate call — then cache it so the next read is free.
    const loads = await loadRosterForDate(date);
    const at = new Date().toISOString();
    if (isFirestoreEnabled()) {
      try {
        // Same guard the scanner uses: an empty answer may not erase a roster we still hold.
        const prior = cached ?? await readLoadRoster(TENANT, date).catch(() => null);
        const verdict = acceptRosterWrite(prior, loads);
        if (verdict.write) {
          await writeLoadRoster(TENANT, date, loads, at, { emptyStreak: verdict.emptyStreak, emptyAt: loads.length ? null : at });
        } else {
          await markLoadRosterEmpty(TENANT, date, verdict.emptyStreak, at);
          // Answer with what we HOLD, not with the nothing we were just handed — the whole
          // point of refusing the write is that the held list is the better answer.
          return new Response(JSON.stringify({
            ok: true, date, source: 'cache', at: prior?.at ?? null,
            count: prior?.loads.length ?? 0, loads: prior?.loads ?? [], note: verdict.reason,
          }), { status: 200, headers: cors });
        }
      } catch { /* cache best-effort */ }
    }
    return new Response(JSON.stringify({ ok: true, date, source: 'live', at, count: loads.length, loads }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, reason: e?.message || 'roster failed' }), { status: 502, headers: cors });
  }
};
