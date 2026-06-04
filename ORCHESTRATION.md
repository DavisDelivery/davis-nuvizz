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
| 1 | Historical Data Warehouse (immutable daily capture) | NEXT / ACTIVE |
| 2 | Routing Engine (build on our own data, NuVizz read-only) | PLANNED |
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

### Phase 1 — Historical Data Warehouse — NEXT / ACTIVE
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

### Phase 2 — Routing Engine (build on our own data) — PLANNED
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

## Revision log

- Jun 2025 — Orchestrator — Initial charter. Spec pinned (Phase 0). Retention
  check complete: confirmed the stop index is a live cache, not history; Phase 1
  (immutable warehouse) is next. Phases 0–5 defined.
