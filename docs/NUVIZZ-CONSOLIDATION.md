# NuVizz consolidation — single source of truth (Phase 4)

**Status:** staged for review. Nothing here is deployed or enabled in production.
The consolidation is gated behind `NUVIZZ_CONSOLIDATED` (default `false`), and the
new shared request wrapper is active-but-transparent (it counts/guards calls but
does not change scan results).

## Problem

NuVizz v7 has **no "list loads/stops for a date" endpoint**, so every app
discovers a day's work by brute-force-probing a range of load/stop numbers against
`/load/info` and `/stop/info`. Two apps did this **independently**:

- **SITE A** (`davis-nuvizz`, mobile dashboard) — `scanFleet()` → writes
  `nuvizzFleet/{tenant}__{date}` (loads + `meta/summary` + `meta/driverIndex`).
- **SITE B** (`dd-dispatch-map`, dispatch map) — `scanDate()` → writes
  `nuvizz_stop_index/{tenant}__{date}/stops/{stopNbr}`.

Both authenticate with the **same `FIREBASE_SA`** and point at the **same Firebase
project, `davismarginiq`** — so they already share a database, but each runs its
own NuVizz scan, double-paying for overlapping loads. At `*/5`, 24/7, 8-day, ±600
windows this produced ~1M+/day on `/load/info` and triggered NuVizz's blacklist
threat. (Phase 1–3 already cut crons to `*/15`, today-only, ±250, and dropped the
redundant uline scan.)

## Design — one scanner, everyone else reads Firestore

```
                 ┌─────────────────────────────┐
   NuVizz v7  ◄──┤  SITE B = THE SOLE SCANNER   │   (dispatch-map background fn)
   /load/info    │  scanDate() every */15      │
   /stop/info    │  • writes nuvizz_stop_index  │
                 │  • writes nuvizzFleet (NEW)  │
                 └──────────────┬──────────────┘
                                │ shared davismarginiq Firestore
            ┌───────────────────┼───────────────────────────┐
            ▼                   ▼                            ▼
   nuvizz_stop_index     nuvizzFleet/{tenant}__{date}   nuvizz_ops/
   (map reads)           loads/ + meta/summary +        calls__{date}  (counter)
                         meta/driverIndex               circuit         (breaker)
            ▲                   ▲
            │                   │  reads only — NEVER scans NuVizz
   SITE B map UI       SITE A mobile dashboard (NUVIZZ_CONSOLIDATED=true)
```

- **SITE B becomes the canonical scanner.** It already produces normalized stops
  carrying `loadNbr / driverName / routeName / normalizedStatus`. A new pure
  function `deriveFleetSummary(stops)` reconstructs the load-level view and writes
  it to **`nuvizzFleet/{tenant}__{date}`** — the *exact shape SITE A already
  reads* via `firestore.cjs` `readSummary()/listLoads()/readDriverIndex()`.
- **SITE A stops scanning.** With `NUVIZZ_CONSOLIDATED=true`:
  - `__fleet` / `__fleetstops` / `__driver` serve the Firestore index regardless of
    age and never fall back to a live scan;
  - the `fleet-refresh-background` cron returns immediately (no scan);
  - `scanFleet()` is already gated by `NUVIZZ_SCANS_ENABLED`.
- **Any future app** reads `nuvizzFleet` / `nuvizz_stop_index`, never NuVizz.

### Canonical schema (shared `davismarginiq` Firestore)

| Collection | Doc | Written by | Read by |
|---|---|---|---|
| `nuvizz_stop_index/{tenant}__{date}` | meta: `last_scanned_at,count,plannedCount,unplannedCount` | SITE B | SITE B map, SITE A `__fleetstops` |
| `…/stops/{stopNbr}` | full normalized stop | SITE B | ″ |
| `nuvizzFleet/{tenant}__{date}/loads/{loadNbr}` | `loadNbr,route,driver,driverUserName,totalStops,delivered,inProgress,exceptions,pctComplete` | SITE B (`deriveFleetSummary`) | SITE A `__fleet` |
| `…/meta/summary` | fleet aggregate | SITE B | SITE A |
| `…/meta/driverIndex` | `{ map: { userName → [loadNbr] } }` | SITE B | SITE A `__driver` |
| `nuvizz_ops/calls__{date}` | `count` (atomic increment) | wrapper (both apps) | ops/monitoring |
| `nuvizz_ops/circuit` | `open,reason,at` | wrapper (auto-trip) | both scanners |

**Fidelity:** the scanner now retains the full load **header** — `scanDate()`
returns a `loadHeaders` map (`loadId`, `vehicleType`, `origin`, pallet/carton/weight,
`startDate`, `driverEmail`) and `deriveFleetSummary(stops, loadHeaders)` merges it
into each load. So the `nuvizzFleet` load cards SITE A renders are complete — not
just load list / drivers / completion %, but vehicle type, origin and freight totals
too. (Header-less call sites still work; those fields come back `null`.)

## Shared request wrapper (`nuvizz-request.mts` / `.cjs`)

Every NuVizz call routes through `getNuvizzRequester().request(url, opts, {route, tenant})`:

1. **Counts + logs every round-trip** against the shared `nuvizz_ops/calls__{date}`
   counter (atomic Firestore increment) — one fleet-wide number.
2. **Hard daily ceiling / circuit breaker.** When the day's count crosses
   `NUVIZZ_DAILY_CEILING` (default **100,000**) the wrapper trips
   `nuvizz_ops/circuit`. Both scanners check it (`breakerTripped()`) and skip,
   and the wrapper refuses further calls (`NuvizzCircuitOpenError`). The next
   regression is throttled in **minutes**, not by a vendor email. Reset by clearing
   the doc (e.g. a day-rollover job).
3. **In-flight dedupe** — concurrent identical GETs share one network call.
4. **Min-interval floor** (`scanIntervalElapsed`, default 10 min) — a date scanned
   within the window is skipped by the scheduled writer (manual `?date`/`?days`
   override forces it).
5. **Exponential backoff with a hard cap** on 429/5xx (`computeBackoffMs`, base
   500 ms × 2ⁿ, capped 8 s/attempt, 20 s total) — then returns the last response.

Pure logic is dependency-injected and unit-tested (`test/nuvizz-request.test.mjs`,
`test/derive-fleet.test.mjs` — 13 tests).

## Projected steady-state volume (consolidated, scans on)

```
SITE B /load/info  : */15 × today-only × ±250 (~501 probes)  ≈ 48,000/day
SITE B /stop/info  : capped 2,500/run, early-stop usually far less  ≈ 10k–50k/day
SITE A             : 0  (reads Firestore)
on-demand (driver lookup, tracking/WMS/scorecard user actions): hundreds–low thousands/day
─────────────────────────────────────────────────────────────────────
TOTAL ≈ 50k–100k NuVizz calls/day   (vs ~1M+/day incident; hard-capped at the ceiling)
```

Tunable: `*/30` halves `/load/info` to ~24k/day (30-min freshness vs 15).

## Rollout (when approved — not in this PR)

1. Merge; deploy SITE B (sole scanner now also writes `nuvizzFleet`). Leave
   `NUVIZZ_CONSOLIDATED` unset on SITE A so behaviour is unchanged.
2. Re-enable SITE B scans (`NUVIZZ_SCANS_ENABLED=true` on `dd-dispatch-map`).
   Confirm `nuvizzFleet/{davis}__{today}` is populated and matches the old shape.
3. Flip `NUVIZZ_CONSOLIDATED=true` on SITE A and keep `NUVIZZ_SCANS_ENABLED=false`
   there — SITE A now reads the shared index and never scans.
4. Watch `nuvizz_ops/calls__{date}`; confirm the daily total tracks ~50–100k and
   the breaker never trips in normal operation.
5. Follow-up: optionally route the on-demand apps (DDS-Tracking, Davis-wms,
   Driver-scorecards) through the same wrapper so their human-triggered calls
   count against the shared ceiling too.
