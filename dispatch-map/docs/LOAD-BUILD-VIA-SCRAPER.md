# Load-Build via Portal Automation — Exploration & Handoff

**Status:** Exploration / decision doc — NOT a build order. No code in this doc runs.
**Date:** 2026-06-23
**Owner:** Chad (DavisDelivery)
**Scope:** How to programmatically *create loads* in NuVizz for Davis Delivery,
given that the load-creation REST path does not reliably work today.

> This document "packs up" what the recent sessions established about the NuVizz
> write surface and lays out the options for building loads — including a UI
> scraper / RPA path — with a recommendation. It is deliberately honest that the
> API is **not yet fully exhausted**: a scraper is the *fallback*, not the first move.

---

## 1. The problem in one paragraph

Davis's dispatch-map app is **read-only** against NuVizz today (scheduled scans →
Firestore cache + immutable history warehouse → the app reads). The next capability
Davis wants is to **build loads** (group stops into a dispatchable route) from our
own planning output. The obvious path — the NuVizz write API — was spiked (PR #54)
and the **load-import endpoint fails silently**: it accepts the request, returns
`200 "Async import SUCCESS"`, and then the asynchronous backend drops the load with
no queryable error. So "we can't build loads through the API" — *at least not via
the one endpoint we tried.* This doc explores the alternatives, with the portal
scraper as the headline option the request asked for.

---

## 2. What we actually proved about the NuVizz write surface (PR #54)

PR #54 (`claude/phase2-nuvizz-write-spike`, **parked, do-not-merge**) ran a live
create → readback → cancel cycle on the **UAT/sandbox tenant** `Davisv5`
("Davis Delivery V5"), touching **no production/DAVIS data** and cleaning up after
itself. Findings, verbatim from the spike:

### ✅ The synchronous STOP path works end-to-end

```text
POST /stop/sync/update/Davisv5
  → 200  {"status":"Stop created successfully",
          "apiResult":{"created":1,"failed":0},
          "entityInfoList":[{"entityId":"…","entityNbr":"WT…"}]}

GET  /stop/info/WT…/Davisv5
  → 200  our data stored & normalized — company DAVISV5, addresses geocoded,
          schedule GMT→America/New_York, timeConstraint STRICT

POST /stop/cancel/Davisv5  {reasonCode:"CANCEL"}
  → 200  {"status":"SUCCESS"}        ← writes are reversible
```

- We **have write permission** (always `200`, never `401/403`).
- A write **persists and reads back correctly** (NuVizz even geocodes addresses).
- Writes are **reversible** via `/stop/cancel`.

### ⚠️ The LOAD path is asynchronous and silently rejects

```text
POST /load/update/default/…   (the documented load-import path)
  → 200  "Async import SUCCESS" + an AppMessageLog Id
  …but a minimal load did NOT appear on readback. The async backend rejected it
  silently — likely missing valid master data (a registered origin facility/depot).
  There is NO API to query that async AppMessageLog, so failures are invisible.
```

**This is the crux of "can't build through the API."** The one load endpoint we
exercised is fire-and-forget with no error channel.

### Safety model the spike established (reuse this everywhere)

The write function `netlify/functions/nuvizz-write-test.mts` is **quadruple-gated**
so it can never fire by accident or touch live DAVIS:

1. Refuses when Netlify `CONTEXT === 'production'` (deploy-preview only).
2. Refuses unless `NUVIZZ_WRITE_TEST_ENABLED === 'true'`.
3. Uses **dedicated** `NUVIZZ_WRITE_BASE_URL / _USER / _PASS / _COMPANY` — **never**
   the prod `NUVIZZ_DAVIS_*` read creds; refuses if any are unset. Point at UAT.
4. POST body must carry `{ "confirm": "WRITE-TEST-OK" }`.

It **never** calls `/load/assignanddispatch` (so it can't dispatch a driver), and
all test objects are clearly marked "WRITE TEST — SAFE TO DELETE" and are
cancellable. No credentials are committed — env vars only.

---

## 3. The API is NOT exhausted — three families we have not tried

Before committing to a brittle UI scraper, note that the NuVizz v7 OpenAPI
(`dispatch-map/reference/nuvizz-openapi-v7.json`) exposes **load and stop write
paths the spike never touched.** The async `/load/update` may simply be the *wrong*
endpoint for our use case.

| Untested path | Why it might solve "build a load" |
|---|---|
| `/load/static/update/{companyCode}` (+ `/load/static/info`, `/list`, `/assigncarrier`, `/assigndriver`, `/delete`) | A separate **"static load"** object family. Plausibly a *synchronous* create/update surface (unlike the async import), with its own readback (`/static/info`). Strongest candidate. |
| `/load/instance/update`, `/load/partialUpdate`, `/load/rec/update` | Alternate load-update verbs that may be synchronous or may accept an already-master-data-valid payload. |
| **Stop-first composition:** `/stop/sync/update` (✅ works) → `/stop/assign/carrier/{stopNbr}` / `/stop/assign/businessPartner` → `/load/assign/driver` → `/load/assignanddispatch` | Build the load by **creating stops (proven) and then assigning/grouping them**, rather than importing a load object wholesale. This sidesteps the async importer entirely. |

**Recommendation:** spike `/load/static/update` and the stop-first composition on
UAT (same quad-gated harness) **before** investing in a scraper. If both dead-end on
the same master-data requirement, *then* the scraper is justified.

---

## 4. The scraper / RPA option (the headline ask)

If the API truly cannot build a load (master-data gating we can't satisfy via API),
the fallback is **browser automation of the NuVizz portal** (`portal.nuvizz.com`) —
i.e., drive the same web UI a human dispatcher uses, programmatically.

### 4.1 What it is (and isn't)

- **Is:** Robotic Process Automation against **Davis's own NuVizz account** — our
  data, our credentials, our tenant. Equivalent to a macro that fills the
  "create load" form and clicks save.
- **Is not:** scraping a third party's data, or evading auth. This is internal
  business-process automation of a SaaS Davis pays for.
- **Still flag:** confirm this does not violate NuVizz's Terms of Service / API
  agreement (see Risks). Prefer the API; treat the scraper as a stopgap while
  pressing NuVizz support for a working load endpoint.

### 4.2 Architecture sketch

```text
  planning output (our solver / Firestore)
        │  normalized stops + intended load grouping
        ▼
  load-builder worker  (Playwright, headless Chromium)   ← NOT a Netlify function
        │  1. auth: log into portal.nuvizz.com (UAT first)
        │  2. navigate to Create Load
        │  3. fill header (origin/depot, date, service, ref)
        │  4. add/associate stops (created via /stop/sync/update API, or in-UI)
        │  5. save  → capture the new loadNbr from the UI/response
        ▼
  verification  (READ API — already works)
        GET /load/info/{loadNbr}/{companyCode}   → confirm it persisted
        │
        ▼
  reversibility:  /load/static/delete  or  /stop/cancel (cleanup on failure)
```

Key design point: **the scraper only does the one thing the API can't — the load
"save".** Everything else stays on the proven API rails: create stops via
`/stop/sync/update`, and **verify via the read API** (`/load/info`, `/stop/info`)
rather than scraping confirmation text. That keeps the brittle UI surface as small
as possible.

### 4.3 Where it runs

- **Not** in Netlify Functions — they have no browser runtime and a ~26s cap (the
  scans already fight that limit). A scraper needs a real browser + minutes of
  budget.
- Options: a small **containerized worker** (Playwright image) triggered on demand
  / on a schedule (Cloud Run, Fly, a GitHub Actions job, or a long-running box).
  Secrets via the same dedicated `NUVIZZ_WRITE_*` env pattern, never committed.

### 4.4 Tech choice

- **Playwright** (Chromium) over Puppeteer/Selenium: best auto-waiting, resilient
  selectors (`getByRole`/`getByLabel`), trace viewer for debugging brittle steps,
  storage-state for session reuse.
- **Session reuse:** log in once, persist `storageState` (cookies/localStorage),
  reuse across runs to avoid hammering login (and to survive if MFA is interactive).

### 4.5 Robustness strategy (UI automation is fragile by nature)

- Prefer **role/label/text selectors** over CSS/XPath; centralize every selector in
  one page-object module so a UI change is a one-file fix.
- **Idempotency:** tag every created load with a unique external ref
  (`DAVIS-<planId>`); before creating, check via read API whether that ref already
  exists → never double-build.
- **Verify, don't trust:** after save, confirm via `GET /load/info`. If absent,
  treat as failure and clean up.
- **Capture a trace/screenshot on every failure** for fast diagnosis.
- **Quad-gate it** exactly like #54: UAT-only by default, explicit enable flag,
  dedicated creds, confirm token. Never auto-dispatch.

### 4.6 Known hard parts (must de-risk before building)

- **Login flow:** SSO? MFA/OTP? CAPTCHA? If interactive MFA, scripted login may
  need a one-time human-seeded `storageState` + refresh strategy.
- **Form complexity & master data:** the very "origin facility/depot" the async API
  needed is probably a required UI dropdown — the scraper must select a *valid
  existing* facility, same as a human.
- **Load → stop association UX:** confirm whether stops are added inside the
  create-load form or associated afterward.
- **Throughput:** UI automation is seconds-per-load; fine for tens/day, not
  thousands.

---

## 5. Decision matrix

| Option | Effort | Reliability | Reversible | Risk | Verdict |
|---|---|---|---|---|---|
| A. `/load/static/*` API spike | **Low** | TBD (likely sync) | Yes (`/static/delete`) | Low | **Try first** |
| B. Stop-first composition (`/stop/sync/update` + assign) | Low–Med | High for stops; grouping TBD | Yes (`/stop/cancel`) | Low | **Try in parallel** |
| C. Portal scraper (Playwright) | **High** | Brittle (UI drift) | Yes (read-API verify + cancel/delete) | ToS + maintenance | **Fallback if A & B fail** |
| D. Ask NuVizz for a working load endpoint / master-data setup | Low (their effort) | Highest | — | Slow (vendor) | **Pursue alongside, always** |

**Recommendation:** run A + B as small quad-gated UAT spikes (days, not weeks) and
open a NuVizz support ticket (D) in parallel. Only green-light the scraper (C) if A
and B both dead-end on master-data gating the API won't let us satisfy.

---

## 6. Reusable assets already in the repo

The read/normalize/persist machinery is built and proven — a load-builder plugs
into it rather than starting fresh:

| Asset | File | Reuse for load-build |
|---|---|---|
| NuVizz REST base + scan/normalize | `netlify/functions/lib/nuvizz-scan.mts` | `NormalizedStop` / `StopLineItem` shapes; `portal.nuvizz.com/deliverit/openapi/v7` base |
| Firestore cache R/W + SA-JWT auth | `netlify/functions/lib/firestore.mts` | read planning input; `getDoc/setDoc/listDocs` |
| Immutable history warehouse | `netlify/functions/lib/history-store.mts` | audit every build attempt (append-only) |
| Freight geometry (skids/length/oversize) | `netlify/functions/lib/freight-geometry.mts` | derive the freight attributes a load needs |
| Quad-gated write harness | `nuvizz-write-test.mts` (PR #54) | copy the safety model verbatim |
| API contract | `reference/nuvizz-openapi-v7.json` | the load/stop endpoint catalog (Appendix) |

---

## 7. Session context this packs up

This exploration sits on top of recent, **shipped** routing work:

- **#58 (merged, v0.23.1):** fixed the solver's Phase 3 growth-guard early-exit
  (`assign()` iteration cap hoisted to a const) that phantom-spilled routable stops
  on dense clusters; added a regression test and the first `node --test` CI job.
- **#60 (open, draft):** read-only **length-signal inventory** script
  (`dispatch-map/scripts/scan-length-signals.mjs`) for the upcoming inches→feet
  geometry rework — inventories structured + free-text length signals (incl.
  `raw.comments`), redacted aggregates only. Relevant here because **freight
  geometry feeds what a built load must declare** (skids, length, oversize).
- **#54 (parked):** the write-back spike summarized in §2 — the evidentiary basis
  for this whole document.

---

## 8. Open questions for Chad

1. Is automating the NuVizz **portal UI** acceptable under Davis's NuVizz agreement,
   or should we keep this API-only and escalate to NuVizz for a real load endpoint?
2. Can NuVizz tell us the **master-data prerequisites** for `/load/update` (the
   registered origin facility/depot the async importer wants)? That alone might
   unblock the API and make the scraper moot.
3. What **volume** of loads/day do we need to build? (Sets the API-vs-scraper bar.)
4. Does portal login use **MFA/SSO/CAPTCHA**? (Decides whether scripted login is
   even feasible without a human-seeded session.)

## 9. Proposed next chunks (orchestrator-style)

- **Chunk 1 — API spike `/load/static/*` (UAT, quad-gated):** create → `/static/info`
  readback → `/static/delete`. Verdict: synchronous? master-data needs?
- **Chunk 2 — API spike stop-first composition (UAT, quad-gated):** `/stop/sync/update`
  ×N → assign/group → `/load/info` readback. Verdict: can we form a load from stops?
- **Chunk 3 — Vendor ticket (D):** ask NuVizz for working load creation + master-data
  list. (Non-engineering, parallel.)
- **Chunk 4 — Scraper de-risk spike (only if 1+2 fail):** Playwright login + read the
  create-load form on UAT; enumerate required fields + the origin-facility dropdown.
  No saves yet — just prove auth + form reachability.
- **Chunk 5 — Scraper MVP (gated on Chunk 4):** one load, save, read-API verify,
  delete. Quad-gated, UAT-only, never auto-dispatch.

---

## Appendix A — NuVizz load/stop write endpoints (from the v7 OpenAPI)

```text
LOAD
  /load/update/{serviceName}/{companyCode}      ← async import (silently failed in #54)
  /load/static/update/{companyCode}             ← UNTESTED — likely sync; try first
  /load/static/info|list|delete/{companyCode}
  /load/static/assigncarrier|assigndriver|unassign*/{companyCode}
  /load/instance/update/{companyCode}           ← UNTESTED
  /load/partialUpdate/{companyCode}             ← UNTESTED
  /load/rec/update/{companyCode}                ← UNTESTED
  /load/assign/driver/{companyCode}
  /load/assignanddispatch/{companyCode}         ← DISPATCHES a driver — never call in tests
  /load/cancel/{companyCode}
  /load/info/{loadNbr}/{companyCode}            ← read-back (works)

STOP
  /stop/sync/update/{companyCode}               ← ✅ synchronous create — PROVEN in #54
  /stop/assign/carrier/{stopNbr}/{companyCode}
  /stop/assign/businessPartner/{companyCode}
  /stop/stopdetail/update/{companyCode}
  /stop/partialUpdate/{companyCode}
  /stop/cancel/{companyCode}                    ← ✅ reversible
  /stop/info/{stopNbr}/{companyCode}            ← read-back (works)
```

## Appendix B — Environment variables

```text
READ (prod, in use today):   NUVIZZ_DAVIS_BASE_URL / _USER / _PASS / _COMPANY
                             FIREBASE_SA  (Firestore cache + history warehouse)
WRITE (dedicated, UAT only): NUVIZZ_WRITE_BASE_URL / _USER / _PASS / _COMPANY
                             NUVIZZ_WRITE_TEST_ENABLED = 'true'
                             POST body confirm token: { "confirm": "WRITE-TEST-OK" }
Tenants:                     UAT = Davisv5 ("Davis Delivery V5") · PROD = DAVIS
```

## Appendix C — Hard rules carried over

- **Never** write to PROD/DAVIS during any spike — UAT (`Davisv5`) only.
- **Never** call `/load/assignanddispatch` in automation tests (it dispatches a driver).
- **Quad-gate** every write path (CONTEXT, enable-flag, dedicated creds, confirm token).
- **Verify via the read API**, not by trusting a write's 200 or a scraped UI string.
- **No credentials in the repo** — env vars only. Redact PII in any logs/artifacts.
