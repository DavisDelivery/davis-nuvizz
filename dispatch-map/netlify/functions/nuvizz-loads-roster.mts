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
//   GET ?explain=1[&days=5][&from=]  → what the CACHE holds for each date, ZERO vendor calls
import { loadRosterForDate, shouldServeCachedRoster } from './lib/nuvizz-loads.mts';
import { isFirestoreEnabled, readLoadRoster, writeLoadRoster, markLoadRosterEmpty, etDayString } from './lib/firestore.mts';
import { acceptRosterWrite, explainRosterRow } from './lib/roster-write.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (b: any, st = 200) => new Response(JSON.stringify(b), { status: st, headers: cors });
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  // Gate at viewer: ?live=1 skips the cache and pulls the roster STRAIGHT FROM NUVIZZ — a
  // metered call per hit on an open GET. Inert until AUTH_REQUIRED=true.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const date = url.searchParams.get('date') || '';
  const live = url.searchParams.get('live') === '1';

  // ── ?explain=1 — IS THE ROSTER POPULATING? Answered with data, at ZERO vendor cost ──────
  //
  // Chad, three rounds into this: "the problem is the roster scan not populating the loads
  // panel you are fixing the wrong thing." He was right each time, and the reason it took
  // three rounds is that nothing could ANSWER the question. "The scan wrote a roster" and
  // "the panel got nothing" are the same blank screen, and from outside the system the only
  // way to tell them apart was to spend a NuVizz call and hope.
  //
  // So: one read of the cache documents for a window of dates — what each holds, when it was
  // captured, how many of its loads are empty — and NOTHING else. No vendor call on any path
  // through this branch. CLAUDE.md asks every job that acts on its own to have a way to say
  // what it is about to do without doing it; the roster had none, and rounds of guessing at
  // Chad's expense is what that costs.
  //
  //   GET ?explain=1[&days=5][&from=YYYY-MM-DD]
  if (url.searchParams.get('explain') === '1') {
    if (!isFirestoreEnabled()) return J({ ok: false, error: 'Firestore not configured — nothing to explain' }, 503);
    const days = Math.max(1, Math.min(14, Number(url.searchParams.get('days')) || 5));
    const fromRaw = url.searchParams.get('from') || '';
    const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : etDayString();
    const base = Date.parse(from + 'T00:00:00Z');
    const dates = Array.from({ length: days }, (_, i) => new Date(base + i * 86400000).toISOString().slice(0, 10));
    const rows = [];
    for (const d of dates) rows.push(explainRosterRow(d, await readLoadRoster(TENANT, d).catch(() => null)));
    return J({ ok: true, tenant: TENANT, from, days, calls: 0, rows });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ ok: false, reason: 'missing or bad date (YYYY-MM-DD)' }), { status: 400, headers: cors });
  }
  try {
    // 1) Cached roster (scanner-persisted) — instant, no NuVizz call. Skipped on ?live=1.
    // WHEN a cache may answer is a rule with four cases and a clock, so it lives in
    // nuvizz-loads.mts as a pure function with its own tests rather than inline here. The
    // short version: an EMPTY answer is still an answer, and throwing it away used to cost a
    // metered call on every one of the client's five fetch sites, forever.
    let cached: Awaited<ReturnType<typeof readLoadRoster>> | null = null;
    if (!live && isFirestoreEnabled()) {
      cached = await readLoadRoster(TENANT, date).catch(() => null);
      if (shouldServeCachedRoster(cached, etDayString)) {
        return new Response(JSON.stringify({ ok: true, date, source: 'cache', at: cached!.at, count: cached!.loads.length, loads: cached!.loads }), { status: 200, headers: cors });
      }
      // ── MAY AN AUTOMATIC READ SPEND A CALL AT ALL? THAT IS CHAD'S CALL, SO IT IS A SWITCH ──
      //
      // shouldServeCachedRoster already stops the expensive case: a day whose answer is
      // genuinely "no loads" is served free once it has been captured. What is left is the
      // never-captured date, which still goes live once per date — bounded, and it converges.
      //
      // Chad's rule is stricter than that, and it is stated, not inferred: "Nothing should be
      // calling nuvizz on Saturday except for a manual scan." Under the default below, opening
      // the board on a Saturday at a date nobody has captured DOES reach the vendor, three
      // client fetch sites at a time. Under NUVIZZ_ROSTER_AUTO_LIVE=0 nothing automatic ever
      // does: the answer is source:'none', which the freshness line renders as "not pulled"
      // with the Refresh button right beside it, and ?live=1 stays the way to ask.
      //
      // WHICH ONE IS RIGHT IS A DISPATCH JUDGEMENT, NOT AN ENGINEERING ONE — free and silent
      // versus honest and one press away — so it ships default-ON (today's behaviour, nothing
      // changes without the flag) and he can flip it without a deploy.
      const autoLiveOn = !/^(0|false|off|no)$/i.test(String(process.env.NUVIZZ_ROSTER_AUTO_LIVE ?? '').trim());
      if (!autoLiveOn) {
        return new Response(JSON.stringify({
          ok: true, date, source: 'none', at: cached?.at ?? null, count: 0, loads: [],
          note: 'no cached roster for this date — automatic reads are set never to spend a NuVizz call (NUVIZZ_ROSTER_AUTO_LIVE=0); use ?live=1',
        }), { status: 200, headers: cors });
      }
    }
    // 2) Live fetch — one deliberate call — then cache it so the next read is free.
    const loads = await loadRosterForDate(date);
    const at = new Date().toISOString();
    if (isFirestoreEnabled()) {
      try {
        // THE SAME GUARD THE SCANNER USES: an empty answer may not erase a roster we hold.
        // writeLoadRoster is a REPLACE, and loadRosterForDate returns [] with no throw when the
        // response carries no column definitions — so a single odd 200 on a ?live=1 refresh
        // took every load off both Loads panels, and the screen had no way to say so. See
        // lib/roster-write.mts for the streak that still lets a genuinely emptied day land.
        const prior = cached ?? await readLoadRoster(TENANT, date).catch(() => null);
        const verdict = acceptRosterWrite(prior, loads);
        if (verdict.write) {
          await writeLoadRoster(TENANT, date, loads, at, { emptyStreak: verdict.emptyStreak, emptyAt: loads.length ? null : at });
        } else {
          // Field-masked, so the refusal cannot take the loads it exists to protect with it.
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
