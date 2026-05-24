# M5 Research — Route Polylines + Date Picker

Branch: `claude/dispatch-map-m5-route-polylines-and-date-picker`
Date of research: 2026-05-24

## CRITICAL FINDING — the route endpoint in the brief does not exist

The brief states:

> The route endpoint was discovered in M4.2 and is already in use for the driver day-snapshot sidebar:
> `GET /route/list/customer/DAVIS?date=YYYY-MM-DD`

This is **not accurate**. A repo-wide search finds **zero** references to
`/route/list/customer` anywhere — not in `dispatch-map/`, not in the parent
`davis-nuvizz` app, not in any function, component, or doc:

```
grep -rn "route/list/customer" .   # (excluding node_modules) → no matches
grep -rn "/route/"             .   # → no matches in any source file
```

### What M4.2 actually built

`dispatch-map/netlify/functions/nuvizz-driver-route.mts` powers the driver
day-snapshot. It does **not** call a route endpoint. It derives a single
driver's route by **scanning the load-info endpoint** — the same load-number
range probe that `nuvizz-pull-today-stops.mts` uses:

- Endpoint actually used (VERIFIED, cited): `GET /load/info/{loadNbr}/{company}`
  - `nuvizz-driver-route.mts:172` — `${NUVIZZ_BASE}/load/info/{loadNbr}/{company}`
  - `nuvizz-pull-today-stops.mts:196` — same endpoint
- Mechanism: probe load numbers `center ± 250` (anchor 192900 @ 2026-04-22,
  ~80 loads/day), filter by `loadHeader.earliestStartDttm` date, then match
  `loadAssignment.driverUserName` (preferred) or `loadAssignment.driverName`.
- `nuvizz-driver-route.mts:238-240` even has a standing comment:
  > "Use the first load's loadNbr as a stand-in 'route id' **until the real
  > route endpoint is wired**."

So the "route endpoint" was never wired. Routes are a load-scan artifact.

## The route data is ALREADY client-side (M4.4)

M4.4 (this session's earlier work) added per-stop route-join fields to the
normalized stop shape in `nuvizz-pull-today-stops.mts`:

- `stopNbr` — 9-digit PRO string (the join key, fixed in M4.2)
- `loadNbr` — e.g. `DAVIS000195190`
- `loadStopSeq` — 0-based position within the load's stop array
- `driverUserName` — stable driver code (e.g. `HEAD`, `VINCENT`)
- `lat` / `lng` — coordinates

Verified against live data for 2026-05-22 (a weekday with deliveries):

```
GET /.netlify/functions/nuvizz-pull-today-stops?date=2026-05-22
→ 624 stops, 624 with driverUserName, 624 with loadStopSeq, 47 distinct drivers
sample: {stopNbr:"007122719", loadNbr:"DAVIS000195190", loadStopSeq:0,
         driverUserName:"HEAD", lat:34.11543, lng:-84.20188}
```

**Implication:** route polylines can be drawn entirely client-side by grouping
the already-fetched stops list — no new endpoint, no new Netlify function, no
second NuVizz round-trip. This is faster (one fetch already paid for stops) and
avoids inventing an endpoint (which Standing Rule #7 forbids).

### Nuance — drivers can have multiple loads per day

Sample driver `HEAD` on 2026-05-22 had 8 stops with `loadStopSeq`
`[0,1,2,3,4,0,1,2]` — i.e. **two loads** (sequence restarts at 0 per load).
So per-driver polylines must group by `loadNbr` first (each load = one ordered
path segment), then optionally color all of a driver's segments with that
driver's color. Drawing a single line across both loads in raw seq order would
zig-zag incorrectly (two seq-0 stops).

## Date handling audit

- `nuvizz-pull-today-stops.mts`: accepts `?date=YYYY-MM-DD`, defaults to
  `todayUTC()` (`new Date().toISOString().slice(0,10)`) when absent.
- `nuvizz-driver-route.mts:306`: accepts `?date=`, defaults to `todayUTC()`.
- `motive-driver-positions.mts`: live GPS only — no date param (Motive returns
  current position only; meaningless for non-today).
- **"Today" is currently computed UTC, not ET.** Standing Rule #11 requires
  America/New_York. At 00:00–04:59 ET, UTC is already tomorrow, so the current
  default can show the wrong day overnight. M5 must centralize a `todayInET()`
  util and have the **client** send an explicit ET date on every fetch.

## Decision required from Chad (see status report)

The brief's Phase 3 mandates a server function `nuvizz-routes.{js,mts}` calling
`/route/list/customer/DAVIS?date=`. That endpoint does not exist. Two compliant
paths forward — neither invents an endpoint:

- **Option A (recommended): client-side route grouping.** Build polylines from
  the existing stops payload (`loadNbr` + `loadStopSeq` + `driverUserName` +
  lat/lng). No new function. Group by load for sequencing, color by driver.
  Fastest, zero extra NuVizz calls, satisfies Rule #8 (the stops data already
  came through a Netlify Function).
- **Option B: server function via load-scan.** Create `nuvizz-routes.mts` that
  runs the same verified load-info scan once, groups by driver/load, returns the
  brief's normalized shape. Matches the brief's structure but duplicates the
  ~500-probe scan the stops fetch already did (heavier, slower, redundant).

Recommendation: **Option A.** It delivers the brief's intent (per-driver,
sequence-ordered polylines) using only verified data, with the best performance.
Pending Chad's confirmation before implementing Phase 3.

The Date Picker (Phase 2) is unaffected by this and is fully specified.
