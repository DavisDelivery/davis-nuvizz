# Davis Logistics Platform — Orchestration Charter

**Repo:** `DavisDelivery/davis-nuvizz`
**Status:** Living document. This is the master plan for evolving the NuVizz-fed
dispatch map into Davis Delivery's own logistics software.
**Owner / final authority:** Chad Davis.
**Created:** Jun 2025 · **Last revised:** Jun 2025 (see Revision Log).

---

## 0. How to use this document

This is the single source of truth for *where we are going and why*. Every
orchestrator and agent reads this first and updates it after meaningful work.

- **Orchestrator writes the plan and the build briefs.** Chad authorizes merges.
  Agents execute briefs.
- When a phase advances, update its **Status** line and add a **Revision Log**
  entry at the bottom (date · who · what changed). Never silently rewrite history
  — append.
- Keep secrets OUT of this file. Reference environment variable *names* only.
- If a decision changes direction, record it under **Open Decisions** with the
  date and rationale so future readers understand the why, not just the what.

---

## 1. North Star

Turn the dispatch map (today a read-only window onto NuVizz) into Davis's own
logistics layer:

1. **Build our own routes** from our own data — independent of NuVizz's planner.
2. **Own a true historical record** of everything that moves: every stop, every
   route, every driver, every day — queryable and immutable.
3. **Write back to NuVizz** (much later, carefully) so routes we build can be
   dispatched — one gated route first, then more.
4. **Eventually, our own system of record** — order intake, billing, customer
   service notes, and analytics — with NuVizz as an integration, not the brain.

Guiding posture: **do not wreck anything.** NuVizz stays read-only until a
deliberate, gated write-back phase. History capture starts immediately because
the data is perishable.

---

## 2. Operating model & conventions (binding for all agents)

- **APP_VERSION** is bumped and **visibly rendered in the UI** on every code change.
- **All data-table columns are sortable** by clicking the header
  (`useSortableTable` hook + `SortableTh` component, the MarginIQ v2.40.33 pattern).
- **Date display:** when the day isn't needed, abbreviated month + 4-digit year
  ("Jul 2025"); when the day is needed, "Mon D, YYYY" ("Jul 14, 2025"). Never ISO
  (2025-07-14) or bare numeric (7/14) in user-facing text. Tight chart axes may
  shorten ("Jul '25").
- **Four-layer data preservation** on every ingest pipeline — raw is always kept.
- **Firestore writes are verified by direct aggregation reads, never by counters.**
- **Verify-by-readback** on any external write (e.g. NuVizz): write, then re-GET to
  confirm the round trip landed.
- **`App.jsx` stays single-file** in dispatch-map — add inline conditional
  components, do not split it.
- **Routing/dispatch UI target = DESKTOP-PRIMARY, mobile in tandem.** Design and
  perfect the desktop layout first (the dispatch console: setup controls + a large
  map canvas + persistent selected-stops / detail / results panels that use the
  full screen). Build the mobile layout alongside it and keep it fully working — no
  regressions and no dead controls on EITHER. For this platform, mobile is the
  responsive adaptation, not the lead target. (Flips the earlier mobile-first stance.)
- **Claude Code briefs:** delivered as a single triple-backtick fenced block, no
  prose outside the fence, no nested backticks, plain-text headers
  (=== HEADER ===). Every brief opens with an unmerged-work resolution pass.
- **NuVizz is READ-ONLY** until Phase 4. No load/route/stop writes before then.
- Netlify PAT is provided fresh each session and never stored. GitHub PAT is
  verified before use (may rotate).

---

## 3. System landscape

**Apps in this repo**
- `src/` — "Davis NuVizz Mobile" v0.2, the parent mobile dashboard (Leaflet,
  7-screen). Today: today-only, no historical browse, no customer-notes editor.
- `dispatch-map/` — the Davis dispatch map (Vite + React, single-file `App.jsx`,
  Google Maps). The home of the routing build. Prod: dd-dispatch-map.netlify.app.

**Hosting / infra**
- Netlify team `69c43f638748ee6e940f5f62`. Sites: `davis-nuvizz`
  (21c405a7-...), `dd-dispatch-map` (6c862233-...). All under chad@davisdelivery.com.
- Firebase project **davismarginiq** (Firestore) backs MarginIQ, SENTINEL,
  Dispatch Map, and this work.

**Integrations**
- NuVizz TMS v7 — base `https://portal.nuvizz.com/deliverit/openapi/v7`,
  companyCode `DAVIS` (/`ULINE`), HTTP Basic auth. Env: NUVIZZ_DAVIS_USER /
  NUVIZZ_DAVIS_PASS. Pinned spec: `dispatch-map/reference/nuvizz-openapi-v7.json`.
- Motive ELD/GPS — `api.gomotive.com`. Env: MOTIVE_API_KEY.
- Depot / origin: Buford terminal, 943 Gainesville Hwy — lat 34.14838, lng -83.95948.

**Key Firestore collections**
- `nuvizz_stop_index/{tenant}__{date}` (+ `stops/{stopNbr}`) — LIVE map cache.
  Mutable, stops-only, intra-day pruned, today+7 only. NOT history.
- `customer_notes/{matchKey}` — forward-flowing customer corrections (equipment
  restrictions, receiving hours, etc.). Auto-applies to future stops by matchKey.
- (Phase 1, new) `history_*` — the immutable warehouse (see Section 6 / Appendix A).
- (Phase 2, new) `routing_routes` — routes we build on our own data.

---

## 4. Current state (as of this revision)

- OpenAPI v7 spec pinned to the repo (commit adding
  `dispatch-map/reference/nuvizz-openapi-v7.json`).
- NuVizz write path **confirmed feasible** and mapped: a Load = a route. Key write
  endpoints exist — `/load/update`, `/load/assignanddispatch`, `/routePlan/update`,
  `/stop/partialUpdate`. Not yet built (Phase 4).
- Live stop data is rich: 100% lat/lng, ~99.6% pallets, 100% weight, line items
  present; per-line dimensions + criticalDimension exist in schema. NuVizz dwell is
  a fake flat 20 min (must be replaced via learning loop from Motive actuals).
- **History gap (confirmed by code audit):** the only persisted store is the live
  `nuvizz_stop_index` cache — stops-only, mutable, intra-day pruned, no routes/drivers
  as first-class records, no immutable snapshots. We are not capturing true history
  yet. This is Phase 1.

---

## 5. Phase map (at a glance)

| Phase | Name | Status |
| --- | --- | --- |
| 0 | Foundations (spec pin, this charter, retention check) | DONE |
| 1 | Historical Data Warehouse (immutable daily capture) | IN REVIEW |
| 2 | Routing Engine (build on our own data, NuVizz read-only) | IN REVIEW |
| 3 | Parent-App Historical Access + Shared Customer Notes | PLANNED |
| 4 | NuVizz Write-Back (gated: one route, then more) | FUTURE |
| 5 | Toward Own Logistics Software (orders, billing, CS, analytics) | FUTURE |

---

## 6. Phases (detail)

### Phase 0 — Foundations — DONE
**Goal:** lay the groundwork so the rest is built on pinned, shared truth.
- Pin the NuVizz v7 OpenAPI spec to the repo. ✓
- Establish this orchestration charter. ✓
- Confirm scan/index retention behavior (done — it is a cache, not history). ✓

### Phase 1 — Historical Data Warehouse — IN REVIEW
**Goal:** capture a true, immutable, queryable record of every stop, route, and
driver, every day. Start NOW — the data is perishable.
**Scope**
- A scheduled end-of-day capture (plus optional midday snapshot) that runs
  `scanDate()` for the target day and writes immutable history docs. Derive routes
  and drivers by grouping the scan output — no new NuVizz calls required.
- Separate from `nuvizz_stop_index` (which remains the live map cache).
- Query dimensions required: **loads by day, loads by driver, stops, individual
  stops** — and by customer (matchKey). Built to be parsed thoroughly.
- Four-layer preservation (raw kept). Immutable: a past day's snapshot is never
  overwritten; re-captures are versioned, not destructive.
- Capture Motive day summary per driver where available (actual miles / on-site /
  HOS) — this becomes the training data to replace NuVizz's fake 20-min dwell.
**Data model:** see Appendix A.
**Acceptance**
- For any past date, we can list every stop, every route (ordered stops + driver +
  miles/time), and every driver's day.
- Snapshots are immutable and verified by aggregation readback (count matches).
- Capturing is automatic and idempotent; a manual re-run for a date is safe.
**Dependencies:** none (uses existing scan + Firestore). First Claude Code brief.

### Phase 2 — Routing Engine (build on our own data) — IN REVIEW
**Goal:** build delivery routes ourselves, saved to our own store; NuVizz untouched.
**Scope**
- New "Routing" tab in `dispatch-map` (inline in `App.jsx`).
- Stop selection: click, box, and polygon (lasso).
- Truck/driver capacity profiles: skids, weight, truck length / linear feet, and
  special items (e.g. 10–12ft racking that consumes floor length). 48x40 pallets;
  26ft straight ≈ 12–15 skids, 53ft ≈ 24–30.
- Hybrid **AI-led, solver-backed** engine: Google Route Matrix for real drive times
  + a feasibility/bin-packing layer (skids + linear feet + weight + geometry) +
  optionally Google Route Optimization (optimizeTours) as a candidate generator;
  **Claude Opus 4.8 as the brain** — parse messy freight text into physical
  attributes, translate dispatcher intent into constraints/objective weights, pick
  strategy (closest→furthest, furthest→closest, min-distance, min-time), make
  trade-offs, choose among candidates, and write the rationale. A feasibility/repair
  loop guarantees dispatchers only see provably valid routes.
- Assign N trucks to M selected stops; fill efficiently with spill to a partial truck.
- Extend `normalizeStop()` (additive, raw preserved) to surface: `stopDetails[]`
  line items + per-line weight + productCategory, real dimensions + criticalDimension,
  `timeConstraint`, planned distance/duration to next stop, `to.contact`, origin.
- Routes saved to `routing_routes`. **No NuVizz writes.**
- New env (server-side): ANTHROPIC_API_KEY, GOOGLE_ROUTES_API_KEY (enable Routes API
  + Route Optimization API). Do not reuse the referrer-restricted client Maps key.
**Acceptance**
- A dispatcher can select stops, set truck profiles, and get valid, explained routes
  on a map — entirely from our data.

### Phase 3 — Parent-App Historical Access + Shared Customer Notes — PLANNED
**Goal:** let the team go back to a past day and fix a customer so the fix flows forward.
**Principle: edit the customer, not the stop.** The historical stop stays an
immutable record of what happened; the correction (no-tractor-trailer, receiving
hours, liftgate) is written to `customer_notes` keyed by matchKey, so the NEXT stop
at that customer inherits it automatically. We typically don't learn a constraint
until the day after — this is the mechanism that fixes that.
**Scope**
- Parent app (`src/`) gains historical day browsing (reads the Phase 1 warehouse).
- The same shared `customer_notes` editor is available in the parent app and the
  dispatch map, both pointed at the shared `davismarginiq` Firestore, so a correction
  made anywhere flows everywhere.
- "Open yesterday's stop" is the discovery doorway; the write lands on the customer.
**Acceptance**
- From a past stop, a user edits the customer's persistent notes; a future stop at
  that customer shows the restriction automatically.

### Phase 4 — NuVizz Write-Back (gated) — FUTURE
**Goal:** dispatch a route we built — safely, one at a time.
**Scope (built against the pinned spec)**
- Flow: Build -> Preview exact JSON -> create Load (no dispatch) -> Chad authorizes ->
  dispatch. Hard human gate on dispatch.
- Endpoints: `/load/update` (assemble Load from existing stops in our sequence),
  `/load/assignanddispatch` (dispatch), `/load/assign/driver`, `/load/cancel`;
  `/routePlan/update` as an alternative; `/stop/partialUpdate` for re-sequence/enrich.
- Mint our own loadNbr with a recognizable prefix (e.g. `DDAI-<date>-<n>`) so AI-built
  loads are identifiable and reversible.
- Empirical smoke test on the live tenant first: minimal required fields + exact
  `action` enum, confirm whether `stopSeqOrder` vs `altStopSeq` is honored — without
  dispatching. Verify-by-readback via `/load/info`.
- Background/queued function with 429 backoff (avoid the 26s cap).
**Sequence:** smoke test -> push ONE route -> then build the rest in NuVizz.
**Bonus:** `/stop/billing/get-estimate` prices a stop without creating it -> feeds MarginIQ.

### Phase 5 — Toward Own Logistics Software — FUTURE
**Goal:** become the system of record where it makes sense.
**Candidate scope (high level, to be detailed when we get here)**
- Order intake; billing estimate integration (MarginIQ tie-in).
- **Customer service notes platform** — let the CS team add notes to orders by
  customer (architecture deferred; the `customer_notes` layer is the seed).
- Analytics / parsing layer over the warehouse (route quality, driver performance,
  dwell learning, lane profitability).
- Recurring / static routes (NuVizz Static Route API) for fixed lanes.

---

## Appendix A — Historical warehouse data model (Phase 1 draft)

Immutable, append-only. Separate from the live `nuvizz_stop_index` cache.

- `history_days/{tenant}__{YYYY-MM-DD}` — manifest: captured_at, scan completeness,
  stop/route/driver counts, snapshot version.
- `history_stops/{tenant}__{YYYY-MM-DD}__{stopNbr}` — full normalized stop + raw
  (four-layer preserved). Enables "every time customer X was served."
- `history_routes/{tenant}__{YYYY-MM-DD}__{loadNbr}` — the load/route as observed:
  ordered stops (sequence), driver, routeName, NuVizz miles/time (and later our
  computed miles/time).
- `history_drivers/{tenant}__{YYYY-MM-DD}__{driverId}` — driver's day: assigned
  route(s), stops completed, on-time, Motive actual miles / HOS.

Forward-flowing corrections stay in `customer_notes/{matchKey}` (mutable; ideally
versioned with a small history subcollection). Immutable record vs. forward-flowing
knowledge are deliberately separated.

---

## Open decisions / parking lot

- **Repo visibility:** the repo was made public to enable connector access during
  setup. Decide whether to return it to private; regardless, secrets live only in
  Netlify env vars, never in the repo.
- History capture cadence: end-of-day only, or also a midday snapshot? (Lean
  end-of-day first; add midday if intra-day churn proves valuable.)
- Whether Phase 2 uses Google Route Optimization (optimizeTours) as the candidate
  generator from day one, or starts with Matrix + our own bin-packing only.
- CS notes platform (Phase 5) architecture — deferred.

---

## Appendix B — Cost controls (routing / external APIs) — DECIDED Jun 2026

The Google Route Matrix is the dominant external cost and is billed PER ELEMENT
(origins x destinations), so cost is quadratic in matrix size. These are binding
defaults for the routing engine. Reference envelope: total routing API spend should
sit comfortably inside the existing logistics-software budget (~$1k/mo all-in) and,
with caching, well below it.

1. METERED ROLLOUT. Start on a small subset of stops; measure real element usage and
   cost before any full-fleet rollout. Do not enable day-wide / full-fleet routing
   until real numbers are in hand.
2. HAVERSINE-FIRST, GOOGLE-SPARING. The free haversine matrix is the DEFAULT for
   assignment and rough sequencing. Google Route Matrix (paid) is opt-in per build —
   used for the committed/final plan or where real drive-time materially changes the
   route, not on every exploratory build.
3. MATRIX CACHING. Cache drive-time/distance by stop-pair (rounded coordinates) in
   Firestore and reuse across days. Final-mile lanes/customers repeat heavily, so the
   hit-rate climbs fast and paid calls collapse to genuinely-new pairs. Near-term P2
   priority, right after the PR 2 UI and before full rollout.
4. SMALL MATRICES ONLY. Never compute an all-pairs matrix over a whole day. Cluster
   geographically (free) first; call Google only within truck/cluster-sized groups.
5. BASIC TIER BY DEFAULT. Use the non-traffic (Basic, ~$5/1k elements) tier for
   planning; reserve traffic-aware (Advanced, ~$10/1k) for where it matters
   (it roughly doubles cost).
6. HARD CEILING. A daily quota cap on the Routes API in GCP (so spend cannot run away)
   plus a billing budget alert. Set generously enough not to break legitimate use;
   tune to measured data. The dedicated server key is restricted to Routes API only.
7. USAGE READOUT. Surface per-build element count + estimated cost in the UI/logs so we
   budget on measured numbers, not estimates.

PRIORITY NOTE: cheap-by-default (haversine-first + caching) is now slotted as a
near-term P2 follow-on, after the PR 2 routing tab and before any full-fleet rollout.

## Appendix B — addendum: Google SKU model corrected + Fleet Routing decision (Jun 2026)

Clarified against Google's current Routes pricing. Three distinct things, three billing models:
- COMPUTE ROUTES (Directions) — billed PER REQUEST. One call per finished route returns the real
  road distance/time/polyline/navigation for that route's stops. At Davis volume (~75 routes/day) this
  is inside the ~10k/month free request cap = effectively $0, with headroom to re-run a few times daily.
- COMPUTE ROUTE MATRIX — billed PER ELEMENT (origins x destinations), quadratic. This is what the
  engine calls TODAY. It is the pricey pattern if used day-wide / all-pairs. Use only for small
  clusters, if at all.
- ROUTE OPTIMIZATION (Fleet Routing) — billed PER SHIPMENT/stop (~$0.03, Enterprise SKU, 1k free/mo),
  ~$518/mo at 600 stops/day. DECISION: we do NOT use this. Our engine owns constraint-aware bundling
  (oversize, straight-truck-only / no-tractor-trailer / 26ft-max / liftgate, receiving-hour/time
  windows) that a generic optimizer can't see, so feeding it 800 unordered stops is both wrong and
  unnecessary.

CORRECTED COST PICTURE: the realistic Google cost for our blend at current volume is ~$0 — NOT the
earlier four-figure estimate, which assumed all-pairs Compute Route Matrix. That estimate is superseded.

BUILD DIRECTION (a future routing PR, not the immediate persistence/drill-down work): migrate the paid
"live drive-times" leg from a day-wide Compute Route Matrix to ONE per-route Compute Routes (Directions)
call per finished route. Keep the solve on free haversine; use Google only for the committed route's
real road numbers + navigation. Basic (no-traffic) tier for planning; traffic-aware bumps to Advanced.

ROADMAP CAPABILITY: time-window-aware sequencing — enforce "arrive before the receiving window /
closing time" in assignment + sequencing, using ETAs plus the receiving_hours / scheduled windows we
already store. Together with the existing oversize/equipment handling, this is why our engine beats a
generic optimizer, and it is the next real engine frontier after persistence + the flag drill-down.

## Appendix C — Future options / evaluated alternatives (revisit later) — Jun 2026

Researched how others build this kind of system. NEITHER lever is needed now — our blend
(our engine owns constraint-aware bundling; Google does cheap per-route navigation) plus
cheap-by-default stands, and Google cost is ~$0 at our volume. Logged to revisit when the
trigger hits. Both fit behind interfaces we already have, so adopting later is contained,
not a rewrite.

LEVER 1 — Constraint-native solver upgrade (OR-Tools or VROOM).
- Our nearest-neighbor + 2-opt is a fine sequencer; the field standard for QUALITY
  assignment+sequencing under real constraints is a metaheuristic VRP solver. Google OR-Tools
  and VROOM are both free and self-hostable, and natively model exactly our constraints:
  capacity (skids/weight), time windows ("closes before we arrive"), vehicle "skills"
  (= our equipment restrictions — only send a capable truck), max route duration / driver
  breaks, service/dwell time, multi-depot, and minimize-trucks-used.
- Slots behind our swappable solveRouting interface. Precedent at our scale: a published
  70-truck / 341-stop OR-Tools setup with DOT breaks; a 1000+-stop OSRM+VROOM deployment
  using the skills feature exactly like our equipment flags.
- TRIGGER TO REVISIT: when route QUALITY (tighter routes, fewer trucks/miles) becomes the
  priority over the current good-enough heuristic. Vocabulary note: "skills" is the standard
  industry term for our equipment matching.

LEVER 2 — Free road-distance matrices at scale (self-hosted OSRM).
- Self-hosted OSRM (Table service) computes the full road distance/time matrix between all
  stops for free, on a regional OpenStreetMap extract (Georgia/Southeast is small — the
  planet-scale "128 GB server" warning does not apply to a regional box). Eliminates Google
  matrix cost AND the per-call dependency. Trade-off: a server + DevOps + no real-time traffic.
- Middle grounds if self-hosting is too much: cheaper-than-Google hosted matrix/VRP APIs
  (OpenRouteService, Geoapify, Radar, NextBillion). A tiny hosted OSRM+VROOM exists but is a
  one-person side project (reliability risk) — not for anything load-bearing.
- TRIGGER TO REVISIT: if we ever want Google fully out, or want free optimization + matrices
  together (pairs naturally with Lever 1 — VROOM has out-of-the-box OSRM integration).

## Revision log

- Jun 2025 — Orchestrator — Initial charter. Spec pinned (Phase 0). Retention
  check complete: confirmed the stop index is a live cache, not history; Phase 1
  (immutable warehouse) is next. Phases 0–5 defined.
- Jun 2026 — Claude (Phase 1 agent) — Built the immutable daily history warehouse
  (v0.12.0). New backend only, additive: scheduled background capture
  `nuvizz-history-snapshot-background.mts` (cron `0 6 * * *`, captures the
  just-closed America/New_York day) delegating to new shared core
  `lib/history-core.mts`, with pure derivation `lib/history-derive.mts` and a thin
  Firestore reuse layer `lib/history-store.mts` (writes to new `history_days` /
  `history_driver_days` collections only). One `scanDate()` read per capture;
  routes + drivers derived by grouping. Invariants enforced: immutable (never
  prunes the past), append-only `captures/v{n}` lineage, four-layer raw
  preservation, verify-by-readback with manifest written last. Only behavior-
  preserving change to shared code is EXPORT-ing `getDoc/setDoc/listDocs` from
  `lib/firestore.mts`. Live `nuvizz_stop_index` cache and refresh functions
  untouched; NuVizz remains read-only. Unmerged-work pass: M5.1 scan fields
  (`normalizedStatus`/`arrivalDTTM`/`deliveredDTTM`/`classifyStopStatus`) confirmed
  already on `main` (landed via #27→#35); history reads only those + raw, and does
  not touch PR 27's files. Phase 1 → IN REVIEW pending Chad's merge authorization.
- Jun 2026 — Claude (Phase 2 agent, PR 1 of 2) — Routing-engine FOUNDATION
  (v0.13.0): the deterministic, AI-led / solver-backed build engine, server-side and
  fully unit-tested, behind a future feature flag (no UI in this PR — the Routing tab
  is PR 2 of 2). New pure libs: `freight-geometry`, `routing-solver` (best-fit
  bin-packing + strategy sequencing with nearest-neighbor + 2-opt), `routing-repair`
  (guarantees every shown route is valid; spills with reasons), `routing-constraints`,
  `routing-intent` (defensive model-JSON parsing + fallback), `routing-pipeline`
  (5-stage parseIntent→matrix→solve→repair→explain with injected deps), `routing-types`,
  `truck-profiles`, `routing-store`. New server functions: `google-route-matrix`
  (computeRouteMatrix proxy, server-only GOOGLE_ROUTES_API_KEY, chunking + haversine
  fallback), `anthropic-routing` (Opus proxy, server-only ANTHROPIC_API_KEY,
  graceful), `routing-build-background` (async job orchestration → routing_jobs). New
  collections: truck_profiles, routing_jobs, routing_routes (separate from the cache +
  Phase 1). `normalizeStop` extended ADDITIVELY (stopDetails, timeConstraint,
  estimatedDuration, plannedDistance/Duration, contact, origin, markfor; raw + all
  existing fields intact — verified). Guardrails: NuVizz read-only (no write path),
  cache + Phase 1 untouched, secrets server-side only, degrades to deterministic-only
  without keys. 44 unit tests green. Unmerged-work pass: PR 27 confirmed superseded
  (its scan fields are on main via #35) — recommend closing it; this PR does not touch
  App.jsx scan logic. Phase 2 → IN REVIEW (engine); UI is the follow-up PR.

- Jun 2026 — Orchestrator — Added Appendix B (cost controls). Locked in haversine-first + matrix caching + small-matrix clustering + Basic tier + a GCP daily quota cap/budget + a per-build usage readout as binding defaults, after the Google element-cost estimate looked high relative to the existing ~$1k/mo logistics-software spend. Rollout is metered: start small, measure real cost, then scale.
- Jun 2026 — Claude (Phase 2 agent, PR 2 of 2) — Routing (beta) TAB (v0.14.0):
  the dispatcher-facing UI, inline in `App.jsx` (single-file), gated by a feature
  flag (`VITE_ROUTING_BETA=true` or `?routing=1`, OFF in prod). Select stops by
  click/box/lasso with a live tally (count, skids, weight, oversize/restriction
  flag); choose + edit truck profiles (persisted to `truck_profiles`); set intent
  + strategy; Build via the `routing_jobs` job-doc lifecycle (write doc → POST
  `routing-build-background` → poll the doc) and render exactly what the engine
  returns (colored polylines, sortable per-truck stop list with ETAs,
  load-vs-capacity bars, spill list with reasons, rationale + risk flags); Save to
  `routing_routes` with an explicit "plan only — NOT dispatched to NuVizz" banner.
  Cheap by default (Appendix B): the one authorized engine change makes
  `matrixMode` a per-build choice defaulting to free haversine even when the Google
  key is present — Google is an explicit opt-in with the element count + estimated
  $ shown; `result.meta` now carries `matrixSource`/`googleElementCount`/
  `estimatedCostUsd`. 51 unit tests green (7 new cost tests; existing engine tests
  unchanged). Guardrails: NuVizz read-only (no write path), live cache + Phase 1
  untouched, secrets server-side only, graceful degradation, App.jsx single-file.
  Unmerged-work pass: PR 27 STILL OPEN and superseded — it edits App.jsx (this PR's
  file) so it is a genuine conflict risk; branched from main, recommend Chad close
  PR 27 before merging this. Phase 2 (engine + UI) complete, pending validation/merge.
- Jun 2026 — Claude (Phase 2 follow-up) — Routing (beta) mobile layout (v0.14.1):
  made the Routing tab usable on phones. Added a Routing entry to the mobile chip
  menu (flag-gated) and a responsive RoutingScreen — desktop keeps the three side
  rails; mobile renders a full map + a collapsible bottom sheet that toggles
  between Setup (select/trucks/plan) and Result, with a floating selection tally.
  The map re-inits cleanly across the breakpoint (mapReady signal). UI-only,
  additive, still feature-flagged; engine untouched (51 tests green).
- Jun 2026 — Claude (Phase 2 follow-up) — Routing (beta) ENABLED by default
  (v0.14.2). Per Chad's call, the Routing tab is now visible to all dispatchers
  (no ?routing=1 / no env needed). Kill switch retained: VITE_ROUTING_BETA='false'
  or ?routing=0 hides it again without a revert. Cheap-by-default unchanged (free
  haversine unless the Google toggle is used). UI-flag only; engine untouched.

- Jun 2026 — Orchestrator — Set the routing/dispatch UI target to DESKTOP-PRIMARY, with mobile built in tandem and required to keep working. Flips the earlier mobile-first stance for this platform: desktop is the lead, get-it-correct-first surface (full dispatch-console layout); mobile is the responsive adaptation. Per Chad's direction.
- Jun 2026 — Claude (Phase 2 PR3) — Routing Setup usability + correctness pass
  (v0.15.0). Fixed the dead-on-touch selection tools: removed the Google
  DrawingManager (drag-to-draw never worked on a phone and its async load could
  silently no-op) and replaced it with touch-native primitives — Add-stops-in-view
  (map bounds), Box (tap two corners), Lasso (tap vertices → Done) — all driven by
  plain map click listeners that work identically on touch and mouse, so no control
  is shown that can silently do nothing. Each selected stop now surfaces its
  customer_notes restrictions + receiving hours + appointment + oversize via the
  EXISTING helpers (getRestrictionBadgeKeys / RESTRICTION_ICONS / hasReceivingHours),
  and the vague aggregate tally line is replaced by a specific per-restriction
  summary. Added a real selected-stops list (collapsible on mobile, persistent on
  desktop) with tap-in detail showing address, contact, skids/weight, badges with
  labels, formatted receiving hours, and the per-line products from stopDetails[],
  plus a per-row remove with two-way map/tally sync. Pure selection geometry +
  display helpers extracted to src/lib/routing-select.js and unit-tested
  (test/routing-select.test.mjs). Additive, still feature-flagged; NuVizz read-only;
  engine/matrix/cost/cache untouched (61 tests green).

- Jun 2026 — Claude (Phase 2 PR4) — Desktop dispatch console (v0.16.0). Elevated
  the desktop Routing surface into a true three-zone console: Setup (left), a large
  map canvas (center), and a Stops/Result right rail with tabs. Added mouse-native
  click-drag rubber-band box selection (a capture overlay → two corners → the proven
  boxFromCorners + latLngInBounds; no new geometry), kept Add-in-view / Lasso /
  click-toggle, and Esc-to-cancel. Live map<->list hover linkage both directions
  (hovering a row emphasizes its marker and scrolls it into view; hovering a marker
  highlights its row), selection remaining the single source of truth. Right rail
  shows a full sortable selected-stops table with a docked detail panel (address,
  contact, restrictions, hours, products) and, after a build, the Result (route
  cards, spill, cost readout) — auto-surfaced on completion, Stops one click away.
  Also fixed the flagged gap: LOOSE PIECES (NuVizz totalCartons) are now counted and
  displayed at the group tally, per-stop (list rows + detail), and per route card +
  route total. Mobile keeps the #41 bottom-sheet flow unchanged (no regressions).
  Drag-box geometry unit-tested. NuVizz read-only; engine/matrix/cost/cache/Phase 1
  untouched; still feature-flagged (62 tests green).

- Jun 2026 — Orchestrator — Corrected the Google cost model (per Chad's review of Google's pricing). Three SKUs: Compute Routes = per request (~$0 at our volume), Compute Route Matrix = per element (pricey all-pairs, what we call today), Route Optimization/Fleet Routing = per stop (~$518/mo). DECISION: do NOT use Fleet Routing — our engine owns constraint-aware bundling. Earlier four-figure estimate superseded (~$0 realistic). Build direction: paid drive-times leg should use a per-route Compute Routes call, not a day-wide matrix. Added time-window-aware sequencing to the roadmap.

- Jun 2026 — Orchestrator — Logged two future options in Appendix C after researching how others build this: (1) constraint-native solver upgrade (OR-Tools / VROOM — free, models capacity / time-windows / 'skills'=equipment / driver-hours, slots behind our swappable solver) for when route quality becomes the priority; (2) self-hosted OSRM for free road-distance matrices at scale (regional OSM extract) if we ever want Google fully out. Neither needed now; current blend + cheap-by-default stands.
