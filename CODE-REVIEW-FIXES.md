# Code Review Fixes — Orchestrator

**Repo:** `DavisDelivery/davis-nuvizz` · **Source:** the full code review of commit `bb379fc` (every non-test line, 109,634 of them, read by two independent reviewers and checked by an adversarial verifier).
**Status:** Living checklist. Tick items as they merge. Never delete an item — strike it and say why.
**Owner / final authority:** Chad.

---

## How to use this document

Each **workstream** below is a theme, and each **batch** inside it is one pull request. Work top to bottom: the order is by operational damage, not by how interesting the code is.

For every batch:

1. Branch from `main`, fix every item in the batch, and write a test that fails on the old behaviour and passes on the new one. Name the test after the real-world event, not the function.
2. Bump `APP_VERSION` in `dispatch-map/src/App.jsx` and add the changelog row. CI fails the PR without it.
3. Run the repo's own checks before pushing: `npm test` in `dispatch-map` and `load-scan`, plus `npm run verify:mobile` and `verify:desktop` for anything that touches a screen.
4. Tick the boxes here in the same PR, so this file and the code move together.
5. Open the PR and let it merge. Green CI is the gate; no permission step.

Two standing rules from CLAUDE.md apply to this work specifically:

- **Never trigger a NuVizz scan to check a fix.** A cold full scan costs about 3,000 calls. Verify in code and in tests; if a real number is needed, ask Chad for it.
- **Mobile and desktop are two views.** A fix applied to one layout is half a fix.

Every item carries its finding id (for example `A4-S21-2`). The same id appears in the review PDF and in `Davis-NuVizz-Code-Review-Findings.csv`, which hold the full write-up, the evidence and the verifier's reasoning.

---

## Progress

| # | Workstream | Items | C / H / M / L | Batches | Done |
|---|---|---|---|---|---|
| W1 | Dock scanner: stop losing what the loader recorded | 14 | 3 / 7 / 4 / 0 | 2 | ☐ |
| W2 | Access gates: close the ungated endpoints and the stale-token window | 11 | 3 / 4 / 2 / 2 | 2 | ☐ |
| W3 | Two outright crashes | 2 | 0 / 2 / 0 / 0 | 1 | ☐ |
| W4 | Never write config from a failed read | 5 | 0 / 5 / 0 / 0 | 1 | ☐ |
| W6 | One calendar: Eastern day and 8pm shift day | 23 | 0 / 4 / 10 / 9 | 3 | ☐ |
| W7 | Receiving hours: stop the code corrupting what a dispatcher typed | 18 | 0 / 7 / 7 / 4 | 2 | ☐ |
| W8 | NuVizz writes: make the result match what NuVizz did | 50 | 0 / 17 / 21 / 12 | 5 | ☐ |
| W5 | Stop reporting success the system never observed | 29 | 0 / 7 / 13 / 9 | 3 | ☐ |
| W9 | Solver and scorecard inputs | 10 | 0 / 6 / 3 / 1 | 1 | ☐ |
| W10 | Board, flags and history correctness | 46 | 0 / 7 / 20 / 19 | 5 | ☐ |
| W11 | React state, effects and races in the dispatch board | 28 | 0 / 5 / 11 / 12 | 3 | ☐ |
| W12 | Dock scanner: the rest | 20 | 0 / 7 / 6 / 7 | 2 | ☐ |
| W13 | Dispatch board client: the rest | 46 | 0 / 5 / 19 / 22 | 5 | ☐ |
| W14 | Dispatch functions and libraries: the rest | 36 | 0 / 5 / 12 / 19 | 4 | ☐ |
| | **Total confirmed** | **338** | **6 / 88 / 128 / 116** | **39** | |

## The order, and why

**W1 to W4 first — this week.** They are the six critical findings plus the two outright crashes and the config wipes. Each one either loses data a person recorded, hands out something that should be behind a login, or takes a screen out entirely. Nothing else on this list competes with that.

**W6 to W8 next.** These are the ones a dispatcher or a customer feels: a board showing the wrong day, receiving hours the code overwrote, and a NuVizz write that says it landed when it did not. They are also the largest, so they will run several PRs each.

**W5, W9 to W11 after.** Silent failures, solver inputs and board-state races. Real, but they degrade quality rather than lose freight.

**W12 to W14 last.** Genuine small fixes with no common theme. Good filler work, and safe to batch by file.

**A standing question for Chad, not a task.** The root app (`netlify/functions/nuvizz.cjs`, `src/screens/`) carries 11 confirmed findings including two of the six criticals, and it writes to the production Firestore with no auth gate at all. Fixing it properly is most of a workstream. Retiring it may be cheaper than repairing it — that call is yours, and it changes how much of W2 and W8 is worth doing.

---

## W1. Dock scanner: stop losing what the loader recorded

**14 items** — 3 critical, 7 high, 4 medium, 0 low · 2 batches

**Why it matters.** A loader who marks a piece damaged at 5am and finds no record of it at 3pm stops trusting the tool. Three of the six criticals are here: two loaders on one truck overwrite each other, voids and damage never leave the phone, and a deactivated credential keeps writing for 90 days.

### W1.1 — critical and high (10 items)

- [ ] **`load-scan/netlify/functions/scan-session.mts:316`** — Concurrent pushes to one load lose scans; the phone marks them synced anyway  
      *Fix:* Send the PATCH with a `currentDocument.updateTime` precondition taken from the getDoc and retry the read-merge-write on a 412 (or use a Firestore commit/transaction); alternatively make the phone only mark rows synced that appear in the response's merged OG l…  
      <sub>CRITICAL · async-race · A6-S31-1 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/scan-session.mts:355`** — Deactivated/demoted load-scan credentials keep writing for 90 days (token role only)  
      *Fix:* Add an `authenticateLive(req)` helper in lib/auth.mts that verifies the token, reads driver_auth/{sub}, refuses `active === false`, and returns the LIVE role; use it in scan-session, work-session, load-assign, scan-activity, work-report and driver-alias-repor…  
      <sub>CRITICAL · security · X-authgates-2 · reproduced by running the code</sub>
- [ ] **`load-scan/src/App.jsx:1191`** — flushQueue strips voidedAt/damaged before upload — voids and damage never leave the phone  
      *Fix:* Send `voidedAt, voidReason, damaged, damageNote` in the scan projection (and have scan-session's mergeScans accept an update for an OG it already holds, at least for those four fields).  
      <sub>CRITICAL · data-contract · A6-S32-3 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/scan-session.mts:259`** — mergeScans drops a re-pushed void/damage as a duplicate; server never sees either  
      *Fix:* In mergeScans, when the OG already exists, merge the tombstone/flag fields (voidedAt/voidReason latest-wins, damaged sticky) while keeping the first scannedAt; compute scannedPieces from rows with no voidedAt; and have the client send those fields.  
      <sub>High · logic · A6-S31-4 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/scan-session.mts:296`** — Deactivated credential can still push scans and close loads for up to 90 days  
      *Fix:* In every authenticated handler (or inside authenticate), fetch `driver_auth/<sub>` and refuse when `active === false`; cheaper long-term: store a `tokenVersion` on the credential, embed it in the token, and bump it on deactivate/demote.  
      <sub>High · security · A6-S31-18 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/work-session.mts:64`** — Concurrent clock-ins on one shift day overwrite each other; starts lost for good  
      *Fix:* Store one document per session id (`loadscan_worklog/{tenant}__{shiftDay}/sessions/{worker__load}`) written with a field-masked PATCH, or add an updateTime precondition with retry on the shared doc.  
      <sub>High · async-race · A6-S31-2 · reproduced by running the code</sub>
- [ ] **`load-scan/src/App.jsx:978`** — Re-scanning a voided piece is swallowed as ALREADY SCANNED, never revived  
      *Fix:* Build `scannedOgs` (and the `already` count at line 1120) from `activeScans(scans)` so tombstoned rows do not count as on the truck; `enqueueScan` already revives a voided row when the OG comes back.  
      <sub>High · logic · A6-S32-1 · reproduced by running the code</sub>
- [ ] **`load-scan/src/App.jsx:3381`** — Manifest and scan-session date use the ET calendar day; shift day (assignments, report board) rolls at 8pm  
      *Fix:* Derive the manifest/session date from `shiftDayString()` (the client copy already exists in lib/shift.js) so board, assignments, queue scoping and session docs share one key; keep etToday only for the dispatcher's activity picker if that is wanted.  
      <sub>High · date-time · A6-S32-6 · reproduced by running the code</sub>
- [ ] **`load-scan/src/AssignScreen.jsx:80`** — Concurrent taps: later response or rollback wipes other in-flight assignments  
      *Fix:* Serialize writes (queue toggles or disable all rows while any save is in flight) and apply server responses with a functional update that only replaces the loadNbr(s) the request changed; on the server, use a transaction or field-masked update per loadNbr ins…  
      <sub>High · async-race · A6-S33-14 · reproduced by running the code</sub>
- [ ] **`load-scan/src/lib/offline.js:136`** — Voids and damage flags never reach the server; office keeps counting voided pieces  
      *Fix:* Send voidedAt/voidReason/damaged/damageNote/damagedAt in the flushQueue projection, and change mergeScans so an incoming row for a known OG updates those flag fields (keeping the earlier scannedAt) instead of being discarded as a duplicate.  
      <sub>High · data-contract · A6-S33-13 · reproduced by running the code</sub>

### W1.2 — medium (4 items)

- [ ] **`load-scan/netlify/functions/scan-session.mts:331`** — scannedPieces counts voided tombstones as pieces on the truck  
      *Fix:* const live = scans.filter((s) => !s.voidedAt); const scannedPieces = live.length; (keep the tombstones in `scans` for the record).  
      <sub>Med · logic · A6-S31-16 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/scan-session.mts:345`** — Derived timing uses push instants, not scan times; a dead-zone flush yields ~0 minutes  
      *Fix:* Derive firstAt/lastAt for the worker from min/max `scannedAt` of the rows they pushed (falling back to push time when absent).  
      <sub>Med · comment-mismatch · A6-S31-13 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/scan-session.mts:365`** — workedBy.pieces adds hand-confirm ROWS, not pieces — a 5-piece Averitt stop counts as 1  
      *Fix:* Credit the worker with the sum of pieces on the newly added hand-confirm rows (e.g. `added + acceptedHand.filter(added).reduce((n,h)=>n+h.pieces,0)`), not the row count.  
      <sub>Med · logic · A6-S31-7 · reproduced by running the code</sub>
- [ ] **`load-scan/src/App.jsx:938`** — piecesAboard counts voided tombstones, so an all-voided load keeps the resequence freeze  
      *Fix:* Compute `piecesAboard` (and the effect's check at line 969) from `activeScans(scans).length > 0 || handConfirms.length > 0`.  
      <sub>Med · logic · A6-S32-4 · reproduced by running the code</sub>


## W2. Access gates: close the ungated endpoints and the stale-token window

**11 items** — 3 critical, 4 high, 2 medium, 2 low · 2 batches

**Why it matters.** The other three criticals: an anonymous read of every driver’s licence number and phone, and a root NuVizz proxy with no gate on any endpoint, where about twenty anonymous requests can trip the fleet-wide breaker for the day.

### W2.1 — critical and high (10 items)

- [ ] **`dispatch-map/netlify/functions/nuvizz-driver-roster.mts:139`** — Driver roster read is ungated and returns every driver's CDL number, licence and phone  
      *Fix:* Gate the read branch at viewer (mirroring messaging-roster) and strip cdlNumber/licenseState/licenseExpirationDttm on the way out with the same publicRosterUser pattern the root proxy uses; add nuvizz-driver-roster to VIEWER_SET in test/function-gates.test.mj…  
      <sub>CRITICAL · security · X-authgates-3 · reproduced by running the code</sub>
- [ ] **`netlify/functions/nuvizz.cjs:872`** — No auth gate on any endpoint; ~20 anonymous GETs to __refreshFleet trip the fleet-wide NuVizz breaker for the…  
      *Fix:* Require a shared secret header (or the dispatch-map auth token) on every NuVizz-hitting path, at minimum on __refreshFleet, __refreshDrivers, nocache=1 and any path that can fall through to scanFleet; return 401 before touching NuVizz or Firestore.  
      <sub>CRITICAL · security · A6-S34-3 · reproduced by running the code</sub>
- [ ] **`netlify/functions/nuvizz.cjs:1720`** — Root NuVizz proxy: __refreshFleet/__refreshLoad/nocache scans are ungated  
      *Fix:* Require a shared secret header (e.g. X-Refresh-Secret compared with the existing constant-time helper) on __refreshFleet, __refreshLoad, __refreshDrivers, nocache and manual-range paths, and send it from fleet-refresh-background.mjs; or hard-refuse those path…  
      <sub>CRITICAL · security · X-authgates-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/require-user.mts:85`** — 30s user cache refuses the fresh token issued right after a tokenVersion bump  
      *Fix:* In requireUser, when the cached doc's tokenVersion is LOWER than claims.tv (a token can only carry a tv the store once held), bypass the cache and re-read the store once before deciding; also drop the cache entry in bumpTokenVersion's callers. Add a test: bum…  
      <sub>High · logic · X-authgates-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/manifest-history.mts:83`** — ?pdf=1 skips the viewer gate for every JSON branch, not just the PDF one  
      *Fix:* Compute the exception exactly as the branch that needs it: `const wantsPdf = pdf === '1' && !!one && DATE_RE.test(one)` (or move the gate to sit immediately after the PDF branch returns), and add the `?pdf=1` without-date case to function-gates.test.mjs.  
      <sub>High · security · A5-S27-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/nuvizz-pod.mts:77`** — Unauthenticated POD endpoint spends up to 8 NuVizz calls per miss and can trip the scan breaker  
      *Fix:* Stop honouring a caller-supplied cc (or validate it against the two known company codes), short-circuit to a single host/company when the guid shape is invalid, and add a small per-IP throttle (lib/require-user.mts throttled()) so an anonymous miss loop canno…  
      <sub>High · security · X-security-2 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/load-assign.mts:62`** — Dispatcher gate trusts the 90-day token role; demoted/deactivated dispatcher keeps assigning and reading staf…  
      *Fix:* In each dispatcher-gated handler, after authenticate, `getDoc(DRIVER_AUTH/claims.sub)` and refuse unless `active !== false && role === 'dispatcher'`, as driver-admin does (one Firestore read).  
      <sub>High · security · A6-S31-8 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/work-report.mts:120`** — Dispatcher role checked from the 90-day token, not the live credential  
      *Fix:* Resolve role (and active) from `driver_auth/<sub>` via normalizeRole(credDoc.role) in these handlers, as load-manifest and driver-admin already do; use that live role for the worklog/workedBy role field too.  
      <sub>Med · security · A6-S31-19</sub>
- [ ] **`netlify/functions/dispatch.cjs:276`** — Unauthenticated CORS-* endpoint serves Glory Bound customer manifests  
      *Fix:* Gate the handler behind the same bearer/shared-secret check the load-scan functions use, or remove the function if it has no consumer; confirm with Chad whether the glorybounddispatch rules permit anonymous reads.  
      <sub>Med · security · A6-S33-11</sub>
- [ ] **`dispatch-map/netlify/functions/freight-class-report.mts:53`** — Full customer shipment history CSV is ungated with CORS * (documented as deliberate)  
      *Fix:* Fetch the CSV from inside the app with apiFetch and hand it to the user as a blob download (then gate at viewer), or issue a short-lived signed link; at minimum add the same IP throttle the background gate uses.  
      <sub>Low · security · A5-S27-11</sub>

### W2.2 — low (1 items)

- [ ] **`dispatch-map/netlify/functions/lib/customer-comms.mts:225`** — adminTokenOk accepts the shared secret from the URL query string  
      *Fix:* Drop the url.searchParams.get('token') fallback and accept the header only.  
      <sub>Low · security · A3-S15-14 · reproduced by running the code</sub>


## W3. Two outright crashes

**2 items** — 0 critical, 2 high, 0 medium, 0 low · 1 batch

**Why it matters.** One endpoint 500s on every call; one report drops the whole board. Cheapest fixes in the list.

### W3.1 — critical and high (2 items)

- [ ] **`dispatch-map/netlify/functions/lib/uline-forecast-store.mts:92`** — davisClosedFromEnv calls parseClosedList that is never imported — every forecast GET 500s  
      *Fix:* Add `import { parseClosedList } from '../../../src/lib/davis-calendar.js';` to uline-forecast-store.mts (the same import manifest-run.mts uses), and add a one-line test that calls davisClosedFromEnv so a missing import cannot ship again.  
      <sub>High · logic · A5-S25-9 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/work-report.mts:156`** — `.map(toManifestStop)` passes the index as `warn`; any mismatch drops the whole board  
      *Fix:* Change line 156 to `.map((s: any) => toManifestStop(s))` (or pass an explicit warn collector).  
      <sub>High · logic · A6-S31-3 · reproduced by running the code</sub>


## W4. Never write config from a failed read

**5 items** — 0 critical, 5 high, 0 medium, 0 low · 1 batch

**Why it matters.** A Firestore blip during a save replaces stored config with defaults — the NuVizz kill switch, the comms mailer, a night’s manifest history.

### W4.1 — critical and high (5 items)

- [ ] **`dispatch-map/netlify/functions/customer-comms-config.mts:122`** — Config save during a Firestore read blip replaces stored config with defaults  
      *Fix:* Give writeConfig a strict read (getDoc without the catch) and return 503 to the caller on failure, or switch the write to updateDocFields with only the patched keys so an unreadable current state cannot be overwritten.  
      <sub>High · firestore-semantics · A5-S26-12 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/customer-comms.mts:261`** — writeConfig on a failed read replaces the comms config with defaults (mailer silently OFF)  
      *Fix:* Make writeConfig read strictly (throw on an unreadable doc and surface a 500 to the UI) or write the patch with updateDocFields so untouched fields survive.  
      <sub>High · firestore-semantics · X-firestore-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/manifest-archive-store.mts:36`** — Manifest archive read blip replaces a day's revision history and bypasses the supersede guard  
      *Fix:* Let the read failure throw (drop `.catch(() => null)`); archiveManifest already has an outer try that reports ok:false, and the ingest deliberately leaves an unfiled email unmarked for retry.  
      <sub>High · firestore-semantics · X-errors-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/nuvizz-scan-config.mts:207`** — scan_config save on a failed read wipes the kill switch, rules and ceiling override  
      *Fix:* Use a STRICT read (let readScanConfig throw and return 500 from the handler) and/or write the edit with updateDocFields (field-masked) instead of setDoc; fix the writeScanConfig comment.  
      <sub>High · firestore-semantics · X-firestore-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/routing-engine-tuning.mts:62`** — Engine tuning POST drops every other knob when the prior read blips  
      *Fix:* Remove the `.catch(() => null)` on the prior read (let the handler's outer catch return 500), or use updateDocFields with the clamped patch so only the named knobs change.  
      <sub>High · firestore-semantics · X-errors-2 · reproduced by running the code</sub>


## W6. One calendar: Eastern day and 8pm shift day

**23 items** — 0 critical, 4 high, 10 medium, 9 low · 3 batches

**Why it matters.** The driver snapshot reads tomorrow’s board after 8pm; the dock prints the UTC date beside an Eastern clock; the assign screen and the board disagree after 8pm.

### W6.1 — critical and high (10 items)

- [ ] **`dispatch-map/netlify/functions/nuvizz-driver-route.mts:288`** — Driver snapshot defaults to the UTC day but the stop index is keyed by ET day  
      *Fix:* Import `etDayString` from ./lib/firestore.mts and default `date` (and `fetchHos`'s `today`) to it, matching nuvizz-pull-today-stops; optionally have App.jsx pass the board date explicitly.  
      <sub>High · date-time · A5-S28-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/nuvizz-driver-route.mts:302`** — Driver route snapshot defaults to the UTC day: reads tomorrow's board after 8pm ET  
      *Fix:* Import etDayString from ./lib/firestore.mts and use it for both defaults (lines 266 and 302), matching every other index reader.  
      <sub>High · date-time · X-datetime-3 · reproduced by running the code</sub>
- [ ] **`load-scan/src/AssignScreen.jsx:31`** — Truck list is the ET-calendar-day board while assignments key on shiftDay  
      *Fix:* Fetch the loads for AssignScreen with the same day key the assignments use (pass shiftDay into api.fetchManifest / a board read keyed by shiftDay) instead of reusing the parent's etToday() manifest; whichever key is right, both sides must use the same one.  
      <sub>High · date-time · A6-S33-3 · reproduced by running the code</sub>
- [ ] **`load-scan/src/lib/fmt.js:12`** — fmtDate/fmtDateTime show the UTC calendar day for ET evening timestamps  
      *Fix:* In fmtDate, only use the regex shortcut when the string is a bare date (/^\d{4}-\d{2}-\d{2}$/); for anything with a time component build the date parts with Intl.DateTimeFormat in America/New_York (as fmtTime and etToday already do).  
      <sub>High · date-time · A6-S33-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:2013`** — addStopNote fires partialUpdate with a near-empty echo when getStop is 200 with no record  
      *Fix:* Treat a read whose rawBefore has no id-shaped stopId as a failed read: return {ok:false, error:'could not read stop … nothing was written'} instead of falling back to payload.stopId (apply to all four partialUpdate ladders).  
      <sub>Med · null-handling · A4-S21-11 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/nuvizz-undelivered-report.mts:37`** — Undelivered report computes 'today' in UTC while warehouse day keys are ET  
      *Fix:* Use the ET day string (etDayString() from lib/firestore.mts, already imported elsewhere) for today instead of todayUTC(), so 'today' and the warehouse keys share a calendar.  
      <sub>Med · date-time · A5-S25-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:6830`** — Delivery Ticket shifts comment times by -4h; Notes panel shows the same stamp unshifted  
      *Fix:* Make the ticket use the same interpretation as the rest of the app — format `addedOn` with fmtNoteTime-style digit reads (or a shared helper) and drop the `+ 'Z'` UTC conversion; if NuVizz comments really are UTC, fix fmtNoteTime instead so the two agree, and…  
      <sub>Med · date-time · A1-S3-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:7063`** — Same comment stamp shown as local ET on the card and as UTC→ET on the Delivery Ticket  
      *Fix:* Confirm the zone with one real comment against the portal, then route both call sites through ONE formatter (and treat the events' `dttm` in fmtNoteTime the same way if it shares the convention).  
      <sub>Med · date-time · A1-S3-12 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:10745`** — nowMin gate compares an ET board date to the browser-local calendar day  
      *Fix:* Use the already-computed `dateIsToday` (ET) for the gate and derive nowMin in ET (e.g. via Intl.DateTimeFormat with timeZone 'America/New_York' for hour/minute), updating the wiring test's regex accordingly.  
      <sub>Med · date-time · A1-S4-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:17942`** — nowMin 'today' gate uses browser-local date/clock while the board's today is ET  
      *Fix:* Gate on `isTodayET(selectedDate)` and derive minutes in ET (Intl.DateTimeFormat with timeZone 'America/New_York', hour/minute numeric) in both this call and the Map twin at 10745.  
      <sub>Med · date-time · A2-S7-6 · reproduced by running the code</sub>

### W6.2 — medium (10 items)

- [ ] **`dispatch-map/src/App.jsx:26427`** — Coverage date defaults to the UTC day, not the board's ET day  
      *Fix:* Seed covDate from the ET day (the same Intl en-CA/America/New_York formatter the client uses elsewhere), or leave it empty and let the server default to etDayString() by omitting the date param when unset.  
      <sub>Med · date-time · A2-S10-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/components/DriversPanel.jsx:29`** — fmtDateTime prints the UTC date with the Eastern time — evening logins show tomorrow  
      *Fix:* In fmtDateTime, derive the date from the same zoned formatter (Intl.DateTimeFormat with timeZone 'America/New_York' and year/month/day parts) instead of calling fmtDate on the raw ISO string; keep fmtDate for bare YYYY-MM-DD values.  
      <sub>Med · date-time · A2-S11-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/customer-notes-writer.ts:92`** — todayYmd uses UTC — evening scans stamp pro_history with tomorrow's date  
      *Fix:* Import and call `todayInET()` from './date-util.js' in todayYmd (or accept the date as an injected parameter like the stamps, so the pure test path stays dependency-free).  
      <sub>Med · date-time · A2-S12-3 · reproduced by running the code</sub>
- [ ] **`load-scan/src/App.jsx:3417`** — Midnight ET: any App re-render re-fetches the manifest and wipes the loader's open truck  
      *Fix:* Freeze the manifest date for the session (compute once into state, or ignore date changes while `activeLoad` is set) and only refresh on an explicit refresh/switch.  
      <sub>Med · date-time · A6-S32-7</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-scan.mts:1494`** — unplannedStopNbrs is replaced by a lean/forward slice, not the 'latest FULL descent'  
      *Fix:* Refresh the set only from a FULL-floor descent: have scanDate return (or the caller pass in `extra`) a `descentFull` flag = includeUnplanned && !opts.unplanned?.sinceStopNbr && !opts.forwardUnplanned, and use `descentCompleted && descentFull` at line 1494; ot…  
      <sub>Low · comment-mismatch · A4-S19-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:173`** — buildStopPayload/buildImportStopRef interpolate an absent serviceDate as 'undefinedT08:00:00'  
      *Fix:* In buildStopPayload and buildImportStopRef, validate `isDayString(settings?.serviceDate)` and throw 'missing/invalid serviceDate' so the handler returns 400 before any NuVizz call.  
      <sub>Low · null-handling · A4-S20-14 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:922`** — shiftScheduleToDate can emit a window whose timeTo precedes timeFrom  
      *Fix:* After building, if timeTo < timeFrom on the same day, fall back both ends to the create-path default (12:00–17:00) or push timeTo to timeFrom; add a test for the single-ended window.  
      <sub>Low · date-time · A4-S20-12 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/nuvizz-pull-today-stops.mts:13`** — Header says date defaults to today UTC; code defaults to the ET day  
      *Fix:* Change the header line to `defaults to today's EASTERN calendar day (etDayString)`.  
      <sub>Low · comment-mismatch · A5-S28-7</sub>
- [ ] **`dispatch-map/src/App.jsx:10776`** — openFlaggedStop captures a stale handlePanToStop (deps only [stops])  
      *Fix:* Add `google` (and `saveBoardView` if it is stable) to the dependency list, or wrap `handlePanToStop` in `useCallback([google])` and depend on it.  
      <sub>Low · react-state · A1-S4-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:26565`** — Real-delivery preview fallback asks for the same ET day it just failed on (evenings)  
      *Fix:* Compute yesterday from the ET day the server just reported in its error (parse the date out of j.error) or from an ET-formatted today, not from a UTC ISO string.  
      <sub>Low · date-time · A2-S10-5 · reproduced by running the code</sub>

### W6.3 — low (3 items)

- [ ] **`dispatch-map/src/components/MessagesPanel.jsx:66`** — SMS thread timestamps render in the browser's zone while the rest of the app pins ET  
      *Fix:* Pass { timeZone: 'America/New_York' } to the toLocale* calls and compute the same-day test from ET calendar days (todayInET-style Intl formatting).  
      <sub>Low · date-time · X-datetime-12 · reproduced by running the code</sub>
- [ ] **`netlify/functions/dispatch.cjs:89`** — Dwell goes negative when departure crosses midnight; lowercase am/pm not converted  
      *Fix:* If departure < arrival, add one day to departure (or drop the dwell); compare ampm with toUpperCase().  
      <sub>Low · date-time · A6-S33-10 · reproduced by running the code</sub>
- [ ] **`src/screens/DriversScreen.jsx:203`** — Root app renders dates and ETA windows in browser-local time despite its ET 'today' rule  
      *Fix:* Add timeZone: 'America/New_York' to the toLocale* calls in DriversScreen.jsx, StopDetail.jsx and normalize.js (Dashboard.jsx:22 already does this for its label).  
      <sub>Low · date-time · X-datetime-13 · reproduced by running the code</sub>


## W7. Receiving hours: stop the code corrupting what a dispatcher typed

**18 items** — 0 critical, 7 high, 7 medium, 4 low · 2 batches

**Why it matters.** Chad has said he wants every red. These are the reasons some reds are wrong and some never fire.

### W7.1 — critical and high (10 items)

- [ ] **`dispatch-map/netlify/functions/lib/flag-alert.mts:351`** — Assumed-close guard is defeated for collapsed rows: hoursTier is dropped by the collapse  
      *Fix:* Add `hoursTier: r.hoursTier` to the collapsedRows projection in board-flags.js (and any other field a consumer filters on), and make the guard here fail closed: treat a missing hoursTier as not-alertable for amber rows, or assert the field is present in colla…  
      <sub>High · data-contract · A3-S16-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/routing-constraints.mts:44`** — 'No 53ft' as the app writes it (no_53ft) never blocks a 53' trailer  
      *Fix:* Add `case 'no_53ft':` alongside `case 'no_53':` in equipmentReqOk, add `'no_53ft'` to the `EquipmentReq` union, to KNOWN_REQS/TRAILER_BLOCKERS in routing-build-background.mts, and to TRAILER_BLOCKER_KEYS in routing-assignment-solver.mts (or normalise `no_53ft…  
      <sub>High · data-contract · A4-S23-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/customer-notes-writer.ts:290`** — Audit-trail write poisons hours provenance; scanner overwrites hand-typed hours on next scan  
      *Fix:* Only write `auto_sources.receiving_hours` when the scanner actually wrote (or already owns) the hours field — e.g. guard the block at 291 with `if (hoursWouldChange || scannerOwnsHours)` — or record the disclosure under a separate key (e.g. `auto_seen.receivi…  
      <sub>High · logic · A2-S12-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/signal-scanner.ts:338`** — Day-qualified path stores a lunch CLOSURE as the receiving window (no refusing-context guard)  
      *Fix:* Apply the same refusing-context check to day-qualified segments: skip a daySegRe match whose preceding 28 chars end in CLOSED/NO DELIVER…/LUNCH or whose following text starts with FOR LUNCH, and apply the 90/180-minute width floor to day-qualified ranges too.  
      <sub>High · logic · A3-S13-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/signal-scanner.ts:483`** — 'CLOSED FRIDAYS @ 12PM' is marked a CLOSED DAY — tail check accepts AT but not @  
      *Fix:* Widen the tail test to the same vocabulary the hours regexes use: /^\s+(?:AT|@|AFTER)\s*(?:NOON|[0-9])/i.  
      <sub>High · logic · A3-S13-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/time-restrictions.js:312`** — 'CLOSES AT' order text silently overwrites dispatcher-TYPED receiving hours  
      *Fix:* Apply the explicitClose override only when the hours came from the scanner branch (e.g. `if (explicitClose != null && hoursProvenance !== 'dispatcher' && hoursProvenance !== 'saved')`), or gate it on `hoursTier !== 'typed'`; add a test pairing a typed note wi…  
      <sub>High · logic · A3-S14-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/trailer-block.js:103`** — Any edit to the restriction list promotes the Uline advisory to a 'dispatcher hardcoded' block  
      *Fix:* Check ADVISORY_ONLY_KEYS before the manual short-circuit (an advisory key never hardens unless a distinct human signal exists), or require a per-key confirmation rather than the list-wide flag; at minimum make `tractor_trailer_friendly` in the list win over a…  
      <sub>High · logic · A3-S14-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/signal-scanner.ts:231`** — Labelled afternoon-only range 'RECEIVING HOURS 1-5' is stored as a 1am–5am window  
      *Fix:* In parseTimeRange, when NEITHER half carries a written meridiem and the resolved open is before 05:00 (or the window is entirely before noon and under ~4h wide), shift both halves +12h — mirroring the envelopeClose rule — or return null so the raw text is lef…  
      <sub>Med · logic · A3-S13-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/signal-scanner.ts:409`** — 'DELIVER BY 5/30' (a date) is stored as receiving hours 06:00-17:00  
      *Fix:* Refuse a captured token that is immediately followed by '/' or '-' + digits (a date), e.g. add `(?![\/-]\d)` after the TIME_TOKEN capture in the CLOSE_ONLY/OPEN_ONLY wrappers, or check `normalized.slice(m.index+m[0].length)` for /^\s*[\/-]\d/ before accepting.  
      <sub>Med · logic · A3-S13-5 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/signal-scanner.ts:464`** — 'CLOSED MON-FRI …' marks Monday as a closed day (pattern stops at the span dash)  
      *Fix:* Add a negative lookahead after the day token in the CLOSED patterns so a span is not read as a single day: e.g. `MON(?:DAY)?S?\b(?!\s*-)`; optionally expand 'CLOSED <day>-<day>' spans properly via expandDaySpan.  
      <sub>Med · logic · A3-S13-7 · reproduced by running the code</sub>

### W7.2 — medium (8 items)

- [ ] **`dispatch-map/src/lib/time-restrictions.js:275`** — Typed open-only receiving hours are ignored, so the sheet and the pin disagree  
      *Fix:* Use time-marks.js dayWindowMinutes (or replicate its open-only fallback) instead of dayReceivingWindow so an open-only typed day yields openMin with closeMin null and provenance 'dispatcher'/'saved'.  
      <sub>Med · logic · A3-S14-5 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/time-restrictions.js:289`** — Day-qualified hours for OTHER days are applied to today via the scanner's summary window  
      *Fix:* When `scanned.byDay` exists (has keys) and has no entry for `dayKey`, treat the order text as saying nothing about today (`open = close = undefined`) instead of falling back to the summary; only use `scanned.open/close` when there is no byDay at all.  
      <sub>Med · logic · A3-S14-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/time-restrictions.js:323`** — Split-window label/mark replaces typed note hours but is attributed to the dispatcher  
      *Fix:* When the note branch supplied hours, do not let `split` override the label/mark (use the note window and add the split as a secondary note), or set provenance/sources to 'order-text' for the split and make `_closeMin` use `split.shutFromMin` when the split dr…  
      <sub>Med · data-contract · A3-S14-4 · reproduced by running the code</sub>
- [ ] **`netlify/functions/fleet-refresh-background.mjs:61`** — Cron runs the load-number probe every 15 min around the clock; comments say 5 min, business hours  
      *Fix:* Add an ET business-hours gate to the handler (or narrow the cron) to match the stated intent, and correct the header/footer comments to what the code does; confirm with Chad which env switches are set on this site.  
      <sub>Med · config · A6-S33-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:3424`** — stopMarkerIcon cache key omits the suppressed-restriction input that flagColor() reads  
      *Fix:* Add `pinTintKind(note)` (or the raw restriction-fact booleans) to the cacheKey so the flagColor input is part of the signature.  
      <sub>Low · logic · A1-S2-6</sub>
- [ ] **`dispatch-map/src/lib/signal-scanner.ts:434`** — Bare-pair fallback reads '10-15 LBS PER BOX' as 10:00-15:00 receiving hours  
      *Fix:* Extend the `after` refusal to common unit/quantity qualifiers: /^\s*(FOR\s+LUNCH|MINS?\b|MINUTES?\b|LBS?\b|POUNDS?\b|PCS?\b|PIECES?\b|BOXES\b|SKIDS?\b|PALLETS?\b|FT\b|%)/i.  
      <sub>Low · logic · A3-S13-8 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/time-restrictions.js:468`** — proHasPrefix strips leading zeros from the PRO but not from the prefix  
      *Fix:* Normalise the prefix the same way: `const p = String(prefix).trim().replace(/^0+/, '');` and return true when p is empty.  
      <sub>Low · logic · A3-S14-15 · reproduced by running the code</sub>
- [ ] **`netlify/functions/fleet-refresh-background.mjs:3`** — Header comments describe a 5-minute business-hours job; code is 15 min, all hours  
      *Fix:* Rewrite the header and footer comments to state the actual cadence, hours and tenant list (or implement the business-hours gate they describe).  
      <sub>Low · comment-mismatch · A6-S33-12</sub>


## W8. NuVizz writes: make the result match what NuVizz did

**50 items** — 0 critical, 17 high, 21 medium, 12 low · 5 batches

**Why it matters.** Guards that never fire live, corrections reported as failed, an unplan that makes zero calls, and an undo that re-creates real orders.

### W8.1 — critical and high (10 items)

- [ ] **`dispatch-map/netlify/functions/lib/freight-class.mts:134`** — Freight class uses `pallets` (NuVizz TOTAL pieces) as the pallet count  
      *Fix:* Use `stop.cartons` (real skid count) for `pallets`, lbPerPallet and cubeFt3PalletEst, and expose totalPallets as `pieces`; mirror the field names freight-geometry.mts already uses and add a test with cartons != pallets.  
      <sub>High · data-contract · A3-S16-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-list.mts:357`** — Past dispatcher override bypasses the live-route clamp: routed open stop filed on a past day  
      *Fix:* Only honour an override that is not already in the past for an on-route stop, e.g. `if (set && !finishedEarly && (set >= today || !s.loadNbr)) return set;` (or prune `< today` entries when the map is read for a scan).  
      <sub>High · logic · A3-S18-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-request.mts:270`** — Counter/breaker Firestore failure after a completed NuVizz call rejects the write  
      *Fix:* Wrap `await deps.recordCall(...)` and `await deps.tripCircuit(...)` in try/catch inside doFetchWithRetry: log the accounting failure, still increment totalThisInstance, and return the NuVizz response; accounting must never decide the outcome of a vendor call …  
      <sub>High · error-handling · X-nuvizzwrite-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-scan.mts:938`** — Unplanned descent has no failure channel: refused/5xx/401 probes report descentComplete:true  
      *Fix:* Give the descent the same failure channel loads got: thread a tally into probeStop (count non-404 statuses and thrown errors, mirroring isLoadProbeFailureStatus), and make scanUnplannedStops/scanDate report `complete: false` (or a separate `descentFailures`) …  
      <sub>High · error-handling · A4-S19-8 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-scan.mts:1320`** — scanDate dedupe reads s.stopNbr on wrapped load rows — load-sourced never wins  
      *Fix:* Key the set the same way normalizeStop resolves the row: `const seen = new Set(loadStops.map((s: any) => (s?.stop ?? s)?.stopNbr).filter(Boolean).map(String))`, and compare `String(u?.stop?.stopNbr)` against it; add a unit test that feeds one wrapped load row…  
      <sub>High · logic · A4-S19-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:428`** — Executed-stop guard matches words; NuVizz stopStatus is a numeric code — never fires live  
      *Fix:* Make isExecutedStopStatus accept the vendor's codes as well as words: treat '24','27','30','38','40','50','80','90','91' (and any code >= 24 that is not '99'/'10'/'20'/'05') as executed, or map the code through statusFromCode-style logic before the regex; add…  
      <sub>High · data-contract · A4-S20-8 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:1066`** — addressMatchesTyped fails on RD/ROAD, HWY/HIGHWAY etc. — landed corrections report as failed  
      *Fix:* In `agrees`, compare tokens through a small street-type/directional synonym map (RD/ROAD, HWY/HIGHWAY, BLVD/BOULEVARD, LN/LANE, CT/COURT, PKWY/PARKWAY, PL/PLACE, CIR/CIRCLE, TER/TERRACE, E/W/S/N) in addition to the prefix rule, and add the RD->ROAD case the t…  
      <sub>High · logic · A4-S20-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:309`** — removeStopNbrs is never executed: an unplan-only card returns ok with zero calls  
      *Fix:* Either make the classic engine honor removeStopNbrs (resolve against the fetched load's stopNbr->stopId and add to plan.removeStopIds, with the executed-stop guard), or refuse a card that carries removeStopNbrs without an order (`ok:false, 'unplan needs the l…  
      <sub>High · data-contract · A4-S21-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:376`** — commitBoard silently drops a stop whose getStop fails; Save still reports ok  
      *Fix:* When `gs` is not ok (or has no stopId) for a number not on the load, set `refuse` with a 'stop N could not be read for planning (stale board — refresh and retry)' error and `break`, exactly as runCommitBoardImport/Rwb do; keep the 404-only silent-skip if that…  
      <sub>High · logic · A4-S21-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:1261`** — rwbOrderMismatch reads addressLine1; NuVizz records carry addr1, so street is never in the key  
      *Fix:* Read `a.addr1 ?? a.addressLine1 ?? a.address1 ?? a.addrLine1` in the key (and include addr2/zip if present), and change the nuvizz-rwb.test.mjs fixture (line 50) to use `addr1` so the DAWSONVILLE pin exercises the real shape.  
      <sub>High · data-contract · A4-S21-8 · reproduced by running the code</sub>

### W8.2 — critical and high (10 items)

- [ ] **`dispatch-map/netlify/functions/nuvizz-manual-scan.mts:21`** — Sync manual scan forwards ?date=/?days= into the forced full-scan path at dispatcher  
      *Fix:* Build the inner URL the way manualScanUrl() does in nuvizz-manual-scan-background (origin + pathname + manual=1, discarding date/days), or gate the explicit branch at admin and require NUVIZZ_LIVE_READ_ENABLED like nuvizz-pull-today-stops.  
      <sub>High · security · X-authgates-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/nuvizz-write.mts:231`** — A throw mid-batch discards applied NuVizz writes, skips the ledger, answers 400/503  
      *Fix:* In each executor, wrap every per-load write step (and the post-save assign/dispatch loop) in try/catch that records the throw as a failed step ({op, ok:false, error}) and continues to the result/write-through; in the handler, always write the op ledger row on…  
      <sub>High · error-handling · X-nuvizzwrite-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:24506`** — Single New Order reuses one clientOpId across different orders after a lost response  
      *Fix:* Regenerate opIdRef.current whenever the delivery fields change after a failed submit (or key the op id on a hash of payloadRow), and treat res.idempotent === true as 'already created earlier' in the message rather than a fresh create.  
      <sub>High · async-race · A2-S9-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:25054`** — Undo-auto-import stays live during and after a LIVE bulk push — re-import pushes created orders again  
      *Fix:* In createAll and createAsLoad (and pushChecked for symmetry) call setAutoImportUndo(null) and setImportInfo('') when the push starts; also early-return from undoAutoImport when `busy` is true, matching addRow/removeRow/clearRows.  
      <sub>High · react-state · A2-S9-1 · reproduced by running the code</sub>
- [ ] **`netlify/functions/nuvizz.cjs:889`** — tenant=glorybound reaches the fleet endpoints and triggers a 601-probe DAVIS scan under a 'glorybound' key  
      *Fix:* Reject unknown tenants up front (`if (!['davis','uline'].includes(tenant)) return 400`) for every NuVizz-hitting path, and gate the four fleet screens on isNuvizz the way Dashboard already does.  
      <sub>High · logic · A6-S34-2 · reproduced by running the code</sub>
- [ ] **`netlify/functions/nuvizz.cjs:1769`** — __refreshFleet returns ok:true before the Firestore write lands; hard refresh re-reads the stale board  
      *Fix:* In __refreshFleet, `await writeFleetToFirestore(...)` (it already runs in batches) before clearing the caches and returning, and only report ok when the write succeeded; alternatively return the scanned result to the client and have it use that instead of re-…  
      <sub>High · async-race · A6-S34-1 · reproduced by running the code</sub>
- [ ] **`src/screens/LoadDetail.jsx:17`** — Glory Bound load/stop drill-downs are sent to NuVizz with synthetic ids and always fail  
      *Fix:* For tenant 'glorybound' resolve the load/stop from the dispatch.cjs payload (add `__load`/`__stop` paths to dispatch.cjs keyed by the synthetic nbr, or pass the already-fetched object down from Dashboard) instead of calling the NuVizz passthrough; or hide the…  
      <sub>High · data-contract · A6-S35-17 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/cs-notify.mts:159`** — buildEmail interpolates NuVizz-supplied strings into HTML unescaped  
      *Fix:* Run each interpolated value through an HTML escaper (the `escapeHtml` already exported from customer-comms.mts, or a local copy) when building `html`.  
      <sub>Med · security · A3-S15-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-request.mts:358`** — UAT-pointed deploy writes call counter and circuit breaker into production (default) DB  
      *Fix:* Gate the prod wiring on the invariant: in getNuvizzRequester make recordCall/isCircuitOpen/tripCircuit no-ops (return NaN / false) when !isFirestoreEnabled(), or have incrementCallCounter/readCircuit/setCircuit themselves throw or short-circuit when uatMiscon…  
      <sub>Med · config · X-firestore-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-scan.mts:503`** — isUnplanned means 'no driver' here but 'not planned & not terminal' on the list path  
      *Fix:* Make the scan path match the list contract: `isUnplanned: !isPlanned && !isTerminalStatus(statusCode)` (isTerminalStatus is already in this file), and expose the driver signal under its own name (e.g. `hasDriver`) if anything needs it.  
      <sub>Med · data-contract · A4-S19-4 · reproduced by running the code</sub>

### W8.3 — medium (10 items)

- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-scan.mts:1345`** — Load window self-calibrates from a scan with unanswered probes  
      *Fix:* Skip calibration when `loadTally.failed > 0` (`if (includeLoads && !partialLoad && loadTally.failed === 0) calibrateLoadRange(...)`).  
      <sub>Med · logic · A4-S19-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:342`** — summarize() ignores apiResult.failed — a failed:1 ack with success status reads as ok  
      *Fix:* Treat `Number(body?.apiResult?.failed) > 0` with no created/updated count as a failure (error 'NuVizz reported N failed record(s)'), and add a test.  
      <sub>Med · error-handling · A4-S20-11 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:449`** — cancelResponseConfirms: refusal regex misses 'not possible'/'not permitted to' phrasings  
      *Fix:* Invert the default: require a positive confirmation pattern (e.g. /\b(cancell?ed|has been cancell?ed)\b/ without 'not' nearby) rather than 'contains cancel and no refusal word', and add 'not possible|not supported|already' to the refusal list.  
      <sub>Med · logic · A4-S20-13 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:1006`** — buildLiteralAddress clears addr2 on `null`; verifier treats null/'' as not typed — suite wiped, op reports ok  
      *Fix:* Treat null the same as absent in buildLiteralAddress (`if (next.addr2 !== undefined && next.addr2 !== null)`), and make addressMatchesTyped use the same rule set as the builder: skip null/undefined, treat '' as a clear only for addr2 (the one field the builde…  
      <sub>Med · null-handling · A4-S20-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:1324`** — Benign-drift rule hides from.address.name changes on PICKUP stops too  
      *Fix:* Only apply rule 2 when the stop is a delivery (pass the stop or side into the check, e.g. skip the exemption when primarySideKey(stop) === 'from'), or restrict it to addresses whose addressType is in ADDRESS_BOOK_TYPES.  
      <sub>Med · logic · A4-S20-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:1796`** — Import full-echo whitelist omits volume (loose pieces) and sealNbr (price)  
      *Fix:* Add 'volume' to IMPORT_ECHO_NUMBERS and 'sealNbr' (and 'bol' if the record carries it) to IMPORT_ECHO_STRINGS, and pin them in nuvizz-write-import.test.mjs; alternatively document explicitly why they are excluded, as the comments already do for comments[].  
      <sub>Med · data-contract · A4-S20-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:77`** — cancelStop is transport-retried; a cancel that applied on a 5xx is reported as not cancelled  
      *Fix:* Add 'cancelStop' to the noRetry set so a cancel is attempted once and any transport failure is reported as 'unverified — check the order in the portal', matching the file's own non-idempotent-write rule.  
      <sub>Med · error-handling · A4-S21-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:267`** — hasUnmodeledDelivery reads a null stopSeq as position 0 and lets an unmodeled RA through  
      *Fix:* Treat a null/non-finite stopSeq on a non-DO stop as unmodeled (refuse) rather than as position 0: e.g. `const seq = Number(s?.stopSeq); (!Number.isFinite(seq) || seq > 1)` combined with the existing type check, so only the seq-1 origin pickup is exempt.  
      <sub>Med · null-handling · A4-S21-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:443`** — Fast-path (assign-only) loads are invisible to holderOf, enabling a silent cross-load grab  
      *Fix:* In the steal guard, only accept `batchNbrs.has(srcNbr)` when that source load is actually stop-changing in this Save (e.g. track a `changingNbrs` set of loads with orderedNbrs/emptyLoad), otherwise refuse with the existing 'still planned on load … open that l…  
      <sub>Med · logic · A4-S21-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:1461`** — RWB stale-board guard is DO-only; a seq-less non-DO stop the card omits is silently unplanned  
      *Fix:* In hasUnmodeledDelivery treat a null/non-finite stopSeq on a non-DO stop as unmodeled (or refuse as seq-pending), and build the stale-board guard's set from p.curNbrs minus the origin PU rather than the DO-only index.  
      <sub>Med · logic · A4-S21-14 · reproduced by running the code</sub>

### W8.4 — medium (10 items)

- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:2657`** — Client-supplied poll budgets (pacing.tries / convergence.phaseWaitMs) are unbounded NuVizz spend  
      *Fix:* Clamp server-side: tries ≤ 10, waitMs ≥ 500 in runNewRoute; phaseWaitMs ≤ e.g. 60000 and polls ≤ 20 in runImportLoad; ignore client values outside the clamp.  
      <sub>Med · config · A4-S21-13 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:2670`** — runNewRoute verifies attachment with deliveryOrder(), which drops pickup-type (PU) orders  
      *Fix:* Count attachment from every stop on the read-back load (`made.stops.map(s => String(s.stopNbr))`, or deliveryOrder plus the load's non-DO stopNbrs) instead of deliveryOrder(), and stamp that full set through to the board.  
      <sub>Med · logic · A4-S21-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/nuvizz-pull-today-stops.mts:49`** — Lean map feed drops dupNbr/dupNbrOtherId, so the scan's '2 orders share this number' badge never shows  
      *Fix:* Add 'dupNbr' and 'dupNbrOtherId' (and audit the rest of LIVE_LIST_FIELDS, e.g. addrListSig if any client reads it) to LEAN_STOP_FIELDS.  
      <sub>Med · data-contract · A5-S28-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/nuvizz-stop-explorer.mts:112`** — Cache path silently truncates ranges over 62 days but reports partial:false, full coverage  
      *Fix:* Compute the requested day count before clamping and set `partial: requested > nDays` with `covered.to = days[days.length-1]` (or return 400 for ranges beyond the cap so the client can say so).  
      <sub>Med · data-contract · A5-S28-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:13166`** — Live NuVizz window rows keep raw list shape; status filter/day column misread them  
      *Fix:* Have the explorer's live path map rows through `toBoardStop` (as the cache path already does at nuvizz-stop-explorer.mts:55) so both paths return the same board-shaped row, or in the client decoration derive `status: s.status ?? s.statusCode`, `isPlanned`/`no…  
      <sub>Med · data-contract · A1-S5-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:16629`** — New-route belt sync stamps every requested stop as planned even when NuVizz attached only some  
      *Fix:* Sync only when `rr.allAttached` is true, or sync the attached subset (have the server echo `attachedNbrs` and use it), leaving the rest unplanned.  
      <sub>Med · data-contract · A1-S6-11</sub>
- [ ] **`dispatch-map/src/App.jsx:20127`** — Engine-draft card names can exceed NuVizz's 20-char route-name cap; Save refused  
      *Fix:* Truncate the label so `${label} E${seq}` (and any '-n' suffix) fits ROUTE_FIELD_MAX (e.g. slice label to 20 - suffix length), or run validateNewRoute on the key and shorten until it passes.  
      <sub>Med · data-contract · A2-S7-9 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/work-report.mts:138`** — Whole nuvizz_load_scans collection listed once per requested day (up to 31 times)  
      *Fix:* List the collection once per request and filter per day in memory (the function already has the pure `sessionsOverlappingShift`), and consider a mask or date-keyed doc ids so only the two calendar dates around each shift are read.  
      <sub>Med · other · A6-S31-12</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-scan.mts:993`** — findCeiling re-probes the level the gallop loop just probed — 8 wasted calls/descent  
      *Fix:* Track the last sample result in a variable inside each loop (e.g. `let hiExists = true; for (...; g < MAX_GALLOP && (hiExists = await sampleExists(hi)); g++) {...}` then `if (g === MAX_GALLOP && await sampleExists(hi)) return ...` / or simply `if (hiExists) r…  
      <sub>Low · logic · A4-S19-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-scan.mts:1090`** — Terminal-skip: synthesized (no-call) entries count against maxProbes and mark descents truncated  
      *Fix:* Charge only real calls to the cap: keep `probes` for iterated numbers (logging) and add `let calls = 0; calls += plan.toProbe.length` (or `batch.length` on the non-skip path) and use `calls` in the while-condition and in `complete`.  
      <sub>Low · comment-mismatch · A4-S19-6</sub>

### W8.5 — low (10 items)

- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-scan.mts:1209`** — Forward walk treats 50 existing other-date orders as an 'end-of-frontier dead zone'  
      *Fix:* Drive the dead-zone streak off `exists` (chunks with NO existing numbers) and add a separate, larger cap on consecutive non-new-but-existing chunks; or advance the walk's start past `maxSeen` when a chunk was all-existing so later cycles do not re-walk the sa…  
      <sub>Low · logic · A4-S19-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:696`** — addressIsResolvable/pinEchoAddress docstrings claim they are WIRED into every partialUpdate write; they are n…  
      *Fix:* Replace the "WIRED as of v0.54.91 …" paragraphs on addressIsResolvable and pinEchoAddress with "NOT wired — see pinEchoedConsignee (unwired in v0.54.92)".  
      <sub>Low · comment-mismatch · A4-S20-6</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:1364`** — normalizeStop only unwraps the `Stop` envelope; `{stop:{stop}}` yields null status/load  
      *Fix:* Unwrap with the same probe rawStopFrom uses: `const S = j?.Stop || (j?.stop && j.stop.stop ? j.stop : j) || {}` (or derive status/load from the wrapper that contains the record rawStopFrom found).  
      <sub>Low · data-contract · A4-S20-5 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:1389`** — normalizeStop.proNbr reads `pronbr`/`proNbr`; the v7 Stop record carries `proNumber`  
      *Fix:* Read `stop.proNumber ?? stop.pronbr ?? stop.proNbr ?? null` and change the test fixture to use `proNumber`.  
      <sub>Low · data-contract · A4-S20-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write-ops.mts:2020`** — buildRouteCreateBody emits a header with earliestStartDttm but no latestStartDttm  
      *Fix:* Derive `latest` from `earliest` when it is missing (e.g. same day at 18:00:00) or throw alongside the `!earliest` check so the header always carries both fields.  
      <sub>Low · logic · A4-S20-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:213`** — runCommitLoad remove path takes header/versionId from name-resolved load with no identity check  
      *Fix:* After fetchLoad, if `loadId` (caller, trustable) is set and `f.load.loadId` differs, return the same 'load identity mismatch' refusal runCommitBoard uses.  
      <sub>Low · logic · A4-S21-12 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:1189`** — commitBoard(import) create mode never surfaces the loadId learned from the read-back  
      *Fix:* After convergence set `p.resolvedLoadId = loadId` and use `p.resolvedLoadId ?? p.load?.loadId ?? p.L?.loadId ?? null` when building the result row.  
      <sub>Low · data-contract · A4-S21-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/nuvizz-write.mts:2701`** — newRoute ignores dispatch:true when no driverId is staged, with no warning  
      *Fix:* Move the dispatch block out of the assign branch: fire it when `payload?.dispatch` and (no driver staged OR assign succeeded), and push a warning when dispatch was requested but not attempted.  
      <sub>Low · logic · A4-S21-5 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:13275`** — Loads-view roster fetch re-hits NuVizz every time the day's roster is legitimately empty  
      *Fix:* Server side, treat a stored roster doc as a hit regardless of `loads.length` (or store/check `count` with a short TTL); client side, do not refetch on a mere view toggle — cache the roster per boardDate in the component or accept it from the parent, which alr…  
      <sub>Low · logic · A1-S5-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:13332`** — Empty roster load row opens a route panel keyed by the NuVizz load id, not the route name  
      *Fix:* Push roster-only rows with `loadNbr: nm` (the route name, which is what stops carry) and keep the id only in `realId`.  
      <sub>Low · data-contract · A1-S5-8 · reproduced by running the code</sub>


## W5. Stop reporting success the system never observed

**29 items** — 0 critical, 7 high, 13 medium, 9 low · 3 batches

**Why it matters.** CLAUDE.md: never report an intent as an outcome. Saves, sends and pushes that say ok after failing.

### W5.1 — critical and high (10 items)

- [ ] **`dispatch-map/netlify/functions/day-completion-report-background.mts:196`** — Report email failure after a written snapshot is never retried and never persisted  
      *Fix:* Persist the send outcome on the day_completion doc with a field-masked write (e.g. emailedAt / emailError) and let the spare firing (or a rerun) resend when snapshot exists but emailedAt is absent.  
      <sub>High · error-handling · A3-S15-11 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/sms-store.mts:54`** — Inbound driver SMS lost silently: store failure swallowed, webhook still 200s and counts it  
      *Fix:* Make recordSmsMessage throw (or return false) on write failure; in the webhook return a non-2xx when any report failed to store so the vendor retries (the doc id is derived from messageId, so a retry de-dupes), and in send-sms surface `recorded:false` in the …  
      <sub>High · error-handling · X-errors-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/send-sms.mts:84`** — Bulk send runs sequential vendor+Firestore calls under the 10s default timeout  
      *Fix:* Add `[functions."send-sms"] timeout = 26` to dispatch-map/netlify.toml and bound the per-request batch to what fits (or fan the sends out with bounded concurrency and record the cap increment per successful send rather than once at the end).  
      <sub>High · error-handling · A5-S29-11</sub>
- [ ] **`dispatch-map/src/App.jsx:6463`** — POD photo pull ignores the wrong-twin refusal and reports 'No delivery photos on file'  
      *Fix:* `const refusal = onRefreshed?.(d.stop); if (refusal) { setErr(refusal); return; } setTried(true);`  
      <sub>High · error-handling · A1-S3-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:7525`** — Customer # block says 'Saved' when the Firestore save was refused or threw  
      *Fix:* Make the note-save handlers signal failure (rethrow or return `{ok:false, error}`) and have `submit` stop and show it; hide/disable the Add/Edit controls when `saveDenied` is set, and render `saveError` outside the editing branch.  
      <sub>High · error-handling · A1-S3-4</sub>
- [ ] **`dispatch-map/src/App.jsx:10142`** — Phone Save hides the save bar before the write resolves; a failed note save is invisible  
      *Fix:* Make the click handler await the save and only leave edit mode on success: `onClick={async () => { const ok = await onSave(D); if (ok !== false) { dirtyRef.current = false; setEditing(false); } }}` with `handleSave` returning false (and calling `reportDenied(…  
      <sub>High · error-handling · A1-S4-1</sub>
- [ ] **`dispatch-map/src/App.jsx:16286`** — Stub-row ✕ passes (route.key, stopNbr) to a one-arg callback: removes nothing, false toast  
      *Fix:* Change line 16286 to `onRemoveStop(s.stopNbr)` to match the normal row's contract (or make both rows use the same helper).  
      <sub>High · logic · A1-S6-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/manifest-ocr-background.mts:152`** — Post-gate validation errors return a 4xx Netlify discards; job doc never written  
      *Fix:* For each post-gate early exit, write `{ status: 'error', error: <message>, created_at }` to the job doc (as the ANTHROPIC_API_KEY-missing branch already does) before returning, so the poll surfaces it in three seconds.  
      <sub>Med · error-handling · A5-S27-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:2274`** — useDriverSnapshot caches an ok:false failure and re-serves it as 'No route assigned' with no error  
      *Fix:* Do not write the minimal snapshot into `__snapshotCache` on the ok:false path (keep `setSnapshot(minimal)` for the UI only), or cache it together with the error string and re-surface `setError(cached.error)` on a cache hit.  
      <sub>Med · error-handling · A1-S1-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:5253`** — fetchDriverPhone caches a transient fetch failure as 'no number' for the page lifetime  
      *Fix:* Only cache a definitive answer: move the cache write inside the success path (cache `null` only when the server answered ok with no phone) and let the catch path delete the in-flight entry without populating the cache, so the next open retries.  
      <sub>Med · error-handling · A1-S2-3 · reproduced by running the code</sub>

### W5.2 — medium (10 items)

- [ ] **`dispatch-map/src/App.jsx:8478`** — Saving a phone from the Customer # block silently persists every unsaved notes-editor edit  
      *Fix:* Write only the contact change: build the payload from the persisted `note` (plus mergeSavedContact) rather than the dirty draft, and fold the resulting contacts into the draft afterwards.  
      <sub>Med · logic · A1-S3-14 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:8548`** — Desktop note Save closes the editor before the write settles; the error has nowhere to render  
      *Fix:* Await `onSave(D)` and only `setEditing(false)` on success; render `saveError` in the sidebar regardless of `editing`.  
      <sub>Med · error-handling · A1-S3-5</sub>
- [ ] **`dispatch-map/src/App.jsx:14068`** — CaptureHealthPanel never shows derivations_failed, which the endpoint adds so it is not invisible  
      *Fix:* Add a `{s.derivations_failed} derivations failed` MiniBadge and list days whose `derivations_failed` is non-null under the attention block (or in the cell tooltip) naming the stages.  
      <sub>Med · comment-mismatch · A1-S5-10</sub>
- [ ] **`dispatch-map/src/App.jsx:14513`** — From==To rule previews as a 24-hour band; the server silently drops that row on Save  
      *Fix:* Mirror clampScanRules in the preview: treat startHour === endHour as 'no window' in both inWin sites (skip the rule) and show a red 'zero-width window — this row will be dropped on save' note in RuleRow; or simply run `clampScanRules(form.rules)` before feedi…  
      <sub>Med · data-contract · A1-S6-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:19880`** — Build trigger failure is swallowed; job sits on 'queued' with Build disabled forever  
      *Fix:* Handle the trigger result: `.then(r => { if (!r.ok) { setJob({ status: 'error', error: `build request failed (${r.status})` }); setBuilding(false); unsub(); } }).catch(e => { setJob({ status: 'error', error: e.message }); setBuilding(false); unsub(); })`, and…  
      <sub>Med · error-handling · A2-S7-4</sub>
- [ ] **`dispatch-map/src/App.jsx:28232`** — ForecastRunButton has no catch — a network failure leaves it stuck on 'Reading…'  
      *Fix:* Wrap the await in try/catch (setLine(`✗ ${e.message}`)) with setBusy(false) in a finally, or make forecastPost catch fetch rejections and return { ok: false, error }.  
      <sub>Med · error-handling · A2-S10-3 · reproduced by running the code</sub>
- [ ] **`load-scan/src/App.jsx:1482`** — Close-out proceeds even when the pre-close flush failed, closing the server record short  
      *Fix:* Make `flushQueue` return whether the queue drained, and refuse to send `close` (with a clear message) while unsynced rows remain for this load/date.  
      <sub>Med · error-handling · A6-S32-8</sub>
- [ ] **`load-scan/src/App.jsx:3112`** — Driver editor closes and discards the form even when the save failed  
      *Fix:* Have `act` return a boolean (or rethrow) and only `closeEditor()` on success.  
      <sub>Med · error-handling · A6-S32-11</sub>
- [ ] **`load-scan/src/lib/scanner.js:143`** — Native path failure after getUserMedia leaks the live camera stream into the Quagga fallback  
      *Fix:* In startNative wrap everything after getUserMedia in try/catch that stops the stream's tracks and clears srcObject before rethrowing.  
      <sub>Med · error-handling · A6-S33-19 · reproduced by running the code</sub>
- [ ] **`load-scan/src/lib/scanner.js:165`** — Native path leaks the camera stream when play()/BarcodeDetector fails before fallback  
      *Fix:* Wrap the body after getUserMedia in try/catch that stops the stream's tracks and clears videoEl.srcObject before re-throwing.  
      <sub>Med · error-handling · A6-S33-5 · reproduced by running the code</sub>

### W5.3 — low (9 items)

- [ ] **`dispatch-map/netlify/functions/lib/customer-comms.mts:904`** — resolveLogRange silently answers an invalid ?month= with today's single day  
      *Fix:* When the month (or date) parameter is present but unusable, return the empty `none` result with mode 'month' (or surface an error) instead of falling through to the default window.  
      <sub>Low · error-handling · A3-S15-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/scan-schedule.mts:85`** — Env hour overrides use || so midnight (0) silently reverts to the default  
      *Fix:* Parse with a helper that accepts finite numbers including 0 (e.g. const n = Number(v); Number.isFinite(n) && v !== '' && v != null ? n : dflt) for the hour fields, here and on the module constants.  
      <sub>Low · null-handling · A5-S25-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:9651`** — MobileStopsTab silently drops hiddenByFilters/onClearFilters — phone never explains a filtered-out search  
      *Fix:* Add `hiddenByFilters = 0, onClearFilters = null` to the `MobileStopsTab` props and, in the `sortedStops.length === 0` branch, render the same 'It IS on this board — hidden by your filters' text plus the Clear-filters button used at 4491–4494.  
      <sub>Low · data-contract · A1-S4-2</sub>
- [ ] **`dispatch-map/src/App.jsx:12040`** — handleSave silently no-ops when db is null; mobile editor closes as if saved  
      *Fix:* When `!db`, set saveError to a plain message ('Notes database not configured') instead of returning, and/or feed `!db` into saveDenied so the button is disabled with a reason.  
      <sub>Low · error-handling · A1-S5-11</sub>
- [ ] **`dispatch-map/src/App.jsx:14006`** — Tombstone dry-run error path shows 'Refused: undefined' and drops the real error  
      *Fix:* In the `.then`, treat `d?.ok === false` as an error (`setMarking(m => ({...m, checking:false, error: d.error || d.refusal || 'dry run failed'}))`) instead of storing it as a verdict.  
      <sub>Low · error-handling · A1-S5-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:21819`** — 'Re-score started' is shown without reading the response  
      *Fix:* Capture the response and treat non-2xx as a failure: `const r = await apiFetch(...); if (!r.ok) throw new Error(`HTTP ${r.status}`);` before setting the note, and word the note as 'request accepted' rather than 'started'.  
      <sub>Low · error-handling · A2-S8-7</sub>
- [ ] **`dispatch-map/src/App.jsx:27023`** — 'This month' with no log loaded silently requests 'Today' instead  
      *Fix:* Disable the month preset and select while log?.today is empty, or derive currentMonth from an ET-formatted client date when the server value is missing.  
      <sub>Low · logic · A2-S10-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/components/DriversPanel.jsx:209`** — A 401 clears the token from state but not sessionStorage; act() never signs out  
      *Fix:* On a 401 in both reload() and act(), remove TOKEN_KEY from sessionStorage and setToken('') (a small signOut helper), so the stored token cannot outlive its refusal.  
      <sub>Low · error-handling · A2-S11-8</sub>
- [ ] **`dispatch-map/src/components/DriversPanel.jsx:406`** — Add-driver still demands a driver number; a typed one that exists silently overwrites that driver  
      *Fix:* For isNew, do not require or send driverNumber (let the server generate it) and, if a number is still accepted, refuse client-side when it matches an existing row in `drivers`; ideally also have upsert refuse creation on an existing id unless the caller passe…  
      <sub>Low · data-contract · A2-S11-13</sub>


## W9. Solver and scorecard inputs

**10 items** — 0 critical, 6 high, 3 medium, 1 low · 1 batch

**Why it matters.** A leg Google cannot route is stored as free; an empty capacity field means no cap; freight class counts pieces as pallets.

### W9.1 — critical and high (10 items)

- [ ] **`dispatch-map/netlify/functions/google-route-matrix.mts:65`** — ROUTE_NOT_FOUND elements are stored as 0-second, 0-metre legs  
      *Fix:* In computeChunk, when `e.condition && e.condition !== 'ROUTE_EXISTS'` (or duration is absent), fill that element from `haversineMeters(...)*1.3 / AVG_SPEED_MPS` instead of 0, and count it so the response can flag `degraded` elements.  
      <sub>High · data-contract · A5-S27-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/routing-cleanup-core.mts:479`** — Liftgate stop rides a truck with NO liftgate whenever the fleet is mixed  
      *Fix:* When `liftgateTrucks.length` is non-zero, restrict a liftgate stop to those trucks everywhere a placement is decided: set `as.candidates = liftgateTrucks.map(d => d.driver_key)` for it (the solver's relocate/swap honour isCandidate) AND add a `truckByKey.get(…  
      <sub>High · logic · A4-S23-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/routing-pipeline.mts:85`** — Appointment windows never apply: HH:MM regex cannot match the stored ISO scheduledFrom/To  
      *Fix:* In hhmmToEpochSec/isPlaceholderTime match the clock off the stamp the way the client already does (`/(?:^|[T ])(\d{1,2}):(\d{2})/`), and — since time-restrictions.js documents that NuVizz stamps STRICT on 800/862 stops with an 08:00–20:00 all-day placeholder …  
      <sub>High · data-contract · A4-S24-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/routing-repair.mts:87`** — Repair enforces deck length the constraints module turned off, then re-inserts spilled stops onto the wrong t…  
      *Fix:* Make worstViolator use capacityFits(emptyLoad(), …)/the same CAPACITY_GATES+capLimited rules as canInsert so the two phases agree (drop the deck check while the gate is off); in Phase B prefer re-inserting into the stop's original truck before scanning others.  
      <sub>High · logic · A4-S24-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:8677`** — Driver snapshot on-time % and 'N min late ⚠' judged against the load-wide shared window  
      *Fix:* Apply the same guard the route card uses: compute `loadDefaultWindow(stops)` over the snapshot stops and treat a stop whose `scheduledTime` equals that shared window as having no appointment (`classifyTimeliness` → null), so it is excluded from the on-time de…  
      <sub>High · data-contract · A1-S4-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:20495`** — Truck profile blur writes Number('')=0 to Firestore, which the solver reads as NO cap  
      *Fix:* Parse with a guard: ignore blur when the value is '' or not a finite positive number (e.g. `const n = Number(e.target.value); if (e.target.value.trim() === '' || !Number.isFinite(n) || n <= 0) return;`) and only save when the value actually changed.  
      <sub>High · null-handling · A2-S8-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/routing-repair.mts:151`** — Phase A guard re-reads the shrinking stops.length, halving the budget and shipping invalid routes  
      *Fix:* Compute the cap once before the loop (`const maxIters = stops.length + 2; let guard = 0; while (stops.length && guard++ < maxIters)`), mirroring the solver's Phase 3 fix.  
      <sub>Med · logic · A4-S24-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:7191`** — Note composer reads `duplicate` off the envelope, so a duplicate note is announced as added  
      *Fix:* Read the executor payload the way the date editor does: `const out = r?.result || r || {}; if (r?.ok && out.duplicate) ...` and show `out.message` when present.  
      <sub>Med · data-contract · A1-S3-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/routing-select.js:56`** — fmtTime12 collapses a legacy range string '08:00 - 16:00' to '4:00p' (drops the open)  
      *Fix:* In fmtTime12, only take the stamp branch when the whole string is one timestamp (e.g. anchor it: /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/) and only take the anchored `^(\d{1,2}):(\d{2})` branch when nothing follows the time (/^(\d{1,2}):(\d{2})\s*$/); anything…  
      <sub>Med · logic · A3-S13-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/routing-loads.js:67`** — Extracted load-identity guard is dead code; App.jsx still runs its own four copies  
      *Fix:* Have the roster effect call buildLoadRosterIndex(rosterLoads, resolveNameOwner) and the three write paths call resolveLoadIdentity/loadIdentityRefusal, deleting the inline copies — or correct the comment and add a source-reading test as v0.76.4 did for tracto…  
      <sub>Low · comment-mismatch · A3-S13-11 · reproduced by running the code</sub>


## W10. Board, flags and history correctness

**46 items** — 0 critical, 7 high, 20 medium, 19 low · 5 batches

**Why it matters.** Flags that record the wrong thing or nothing at all, and board rows that show the wrong state.

### W10.1 — critical and high (10 items)

- [ ] **`dispatch-map/netlify/functions/lib/flag-history.mts:130`** — Flag history records assumed-5pm rows and grades them made/missed against the invented close  
      *Fix:* Skip rows with hoursTier === 'assumed' in mergeSweep (or record them but exclude them from classifyOutcome/summarize's made/missed/deliveredLate/missedAfterWarning counts), and carry hoursTier through the collapse projection so the marker survives a bad day.  
      <sub>High · logic · A3-S16-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/history-core.mts:107`** — Nightly history capture runs the number-probe scanDate() on a schedule, gated by an unrelated default-OFF flag  
      *Fix:* Gate the index path on the scanner's real mode (LIST_DISCOVERY / always prefer the index) instead of NUVIZZ_LEAN_DISCOVERY, and make the scheduled path never call scanDate(): on an empty/halted index write a capture-failure record ('index empty — rescan by ha…  
      <sub>High · config · X-background-2</sub>
- [ ] **`dispatch-map/netlify/functions/lib/refresh-stops-core.mts:1493`** — Missed re-enrichment after a reconsignment lets the stale registry pin the moved order forever  
      *Fix:* Make the pending re-enrichment durable: at line 1497 skip the registry record when its stored `addrListSig` disagrees with the row's current one (`if (r.addrListSig && s.addrListSig && r.addrListSig !== s.addrListSig) continue;`), and/or stamp `reenrichPendin…  
      <sub>High · logic · A4-S22-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/tractor-flags-rebuild-background.mts:59`** — A ?date= / ?from&to rebuild REPLACES each touched location's lifetime counts with the window's  
      *Fix:* Either refuse the date/window filter for this job (it is only safe as a full rebuild — drop the ?date/?from&to modes and the comment advertising them), or when a filter is present merge into the existing doc with the same sticky rules updateTractorFlagsForDay…  
      <sub>High · logic · A5-S29-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:1725`** — useStops: a slow response for the previous date overwrites the newly selected date's board  
      *Fix:* Add a monotonically increasing request id (useRef) or an AbortController per refresh; capture it at the start of refresh() and skip every setX() when it no longer matches the latest — the same `cancelled` pattern the sibling hooks already use.  
      <sub>High · async-race · A1-S1-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:3473`** — Pickup 'PU' pin tag is never drawn — circleMarkerSvg ignores tag='PU'  
      *Fix:* In circleMarkerSvg (line 2979) accept `tag === 'PU'` alongside AM/PM (as unplannedDotSvg already does), or route pickups through unplannedDotSvg with the tag when unplanned; add a test that decodes stopMarkerIcon's URL for a PU stop and asserts the 'PU' text …  
      <sub>High · logic · A1-S2-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/board-flags.js:1310`** — R6 no-driver card lost when a pickup at the same customer precedes the delivery  
      *Fix:* Filter pickups out of `group` before the cSeen collapse (mirror R5's `deliveries = group.filter((s) => !isPickupStop(s))`), or include stopType in the visit key.  
      <sub>High · logic · A2-S12-11 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/eta-flag-alert-background.mts:41`** — Day sweep cron is 06:00-18:40 ET in winter and collides with the evening sweep at 06:00 EST  
      *Fix:* Gate the day sweep on the ET clock (skip fires before 07:00 ET, as day-completion does with isReportHour) or narrow the evening window to stand down once the day sweep's first ET fire time is reached; alternatively make the history write a field-masked merge …  
      <sub>Med · async-race · X-datetime-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/eta-flag-alert-background.mts:254`** — History write is a full replace that drops scored_at/summary/next_day_captured, defeating its own 'already fi…  
      *Fix:* Preserve the settled fields on the write (`...(prev?.scored_at ? { scored_at: prev.scored_at, summary: prev.summary, next_day_captured: prev.next_day_captured } : {})`), or use updateDocFields with a mask of the fields this sweep owns.  
      <sub>Med · firestore-semantics · A5-S26-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/eta-flag-evening-background.mts:262`** — In EST the 11:00 UTC evening sweep and the day sweep both run at 6:00am ET and race on the flag-history doc  
      *Fix:* Make eveningTargetDate stand down once the day sweep's UTC window has opened (derive the cutoff from the day sweep's 11:00 UTC start rather than a fixed 7:00am ET), or change the evening schedule to `0 0-10 * * *`; longer term make the history write a field-m…  
      <sub>Med · async-race · A5-S26-3 · reproduced by running the code</sub>

### W10.2 — medium (10 items)

- [ ] **`dispatch-map/netlify/functions/lib/cs-notify.mts:209`** — CS-notify dedup ledger is still a read-modify-write REPLACE — overlapping scans lose entries  
      *Fix:* Claim each (date, matchKey) and each stop number with `createDocIfAbsent` on per-row documents (e.g. nuvizz_ops/cs_notify_<date>/sent/<key>) before sending, or at minimum replace the two `setDoc` calls with field-masked `updateDocFields` writes of only the ne…  
      <sub>Med · async-race · A3-S15-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:1641`** — applyPlanOverlay self-cleans the shared overlay from ANY consumer — the grid window can erase the board's pai…  
      *Fix:* Only the board consumer (useStops) should be allowed to drop entries; give applyPlanOverlay an option such as `{ authoritative: false }` for the window call at 13129 that paints without deleting (or keep two keyed maps, one per consumer).  
      <sub>Med · logic · A1-S1-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:1692`** — reflectBoardPlan: comment says window rows take the board's driver/sequence; code only mirrors when the LOAD …  
      *Fix:* Extend `agrees` to also compare driverUserName/driverName and routeSeq (null-tolerant), or always take the board's driver/seq fields when the load agrees.  
      <sub>Med · comment-mismatch · A1-S1-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:4071`** — Board flags panel: two orders at one customer share a dismissKey → duplicate React keys, one dismiss hides bo…  
      *Fix:* Give per-stop rows a per-stop identity: include `s.stopNbr` in the closed_today and no_location fingerprints (or use `key={r.dismissKey + '|' + r.stopNbr}` in the panel and keep per-customer dismissal only if that is the intended semantics — state it in the r…  
      <sub>Med · react-state · A1-S2-5 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:9390`** — History warehouse errors are stored but never rendered; failure reads as 'Nothing in saved history'  
      *Fix:* Render `remote.error` in the results area (e.g. 'History search unavailable right now (reason)') and exclude the error state from `noResults` so the NuVizz-lookup button is not offered when the warehouse did not actually answer.  
      <sub>Med · error-handling · A1-S4-4</sub>
- [ ] **`dispatch-map/src/App.jsx:13219`** — Map-screen day-status pill counts search-narrowed rows while labelled 'Today's board'  
      *Fix:* Compute dayStatus over `loadStops || stops` (the Map already passes `loadStops={stops}` as the whole board) in board mode, keeping `baseStops` only for window mode.  
      <sub>Med · comment-mismatch · A1-S5-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:13874`** — Diagnostics 'Scan now' swallows every failure and spins 16 s regardless of outcome  
      *Fix:* Route the Diagnostics button through the shared useManualScan hook (primary nuvizz-manual-scan-background with its fallback chain, cooldown and scanErr), or at minimum surface the caught error in the panel instead of an empty catch.  
      <sub>Med · error-handling · A1-S5-6</sub>
- [ ] **`dispatch-map/src/App.jsx:14672`** — SchedulePanel: failed initial load spins forever; the error branch is unreachable  
      *Fix:* Check the error state first: `if (status === 'error' && !data) return <error>;` before the loading/`!form` guard (or guard loading with `status === 'loading'` only and treat null form after error as the error case).  
      <sub>Med · react-state · A1-S6-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:16770`** — Confirmed-save board sync stamps a hash-like routeName (no isHashLikeId guard)  
      *Fix:* Apply the same guard as the failed branch on the OK path: pick the first of [L.routeName, card.name, loadDisplayName(cardKey)] that passes !isHashLikeId, else fall back to the server-echoed loadNbr, and skip the sync if none qualifies.  
      <sub>Med · data-contract · A1-S6-10</sub>
- [ ] **`dispatch-map/src/App.jsx:19040`** — toggleStop's 'removed' flag is set inside a state updater that may run later  
      *Fix:* Decide before updating: read `selectedIds` from a ref (selectedIdsRef kept in sync) to compute `wasSelected`, then call setSelectedIds and choose the message from `wasSelected`.  
      <sub>Med · react-state · A2-S7-7 · reproduced by running the code</sub>

### W10.3 — medium (10 items)

- [ ] **`dispatch-map/src/App.jsx:23989`** — Flag history openDay has no request guard — a slow earlier day's rows land under a newer day's header  
      *Fix:* Keep a ref of the last requested date and ignore responses whose date does not match it before calling setDayRows.  
      <sub>Med · async-race · A2-S9-5 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:24951`** — OCR poll treats every non-done/error reply as pending; post-202 refusals spin 6 minutes  
      *Fix:* In the poll loop, treat a reply with ok === false (or a non-2xx pr.status other than 404) as a terminal failure with its error text; and on the server, write {status:'error'} to the job doc for the post-gate refusals at lines 129/132/152 before returning.  
      <sub>Med · error-handling · A2-S9-12 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:27624`** — Manifest history: a night's detail can render under a different night's row  
      *Fix:* Ignore a response whose `date` is no longer the open one (check `openDate`/a ref before setDay), or render the detail only when `day.date === r.date`.  
      <sub>Med · async-race · A2-S10-11</sub>
- [ ] **`dispatch-map/src/components/DriversPanel.jsx:368`** — 'Temporary PIN … forced to change at first sign-in' issues a STANDING PIN  
      *Fix:* Either send `forceChange: true` in the issue-pin body (matching the copy), or change the copy to say the PIN is standing and drop 'Temporary'.  
      <sub>Med · comment-mismatch · A2-S11-5</sub>
- [ ] **`dispatch-map/src/lib/board-flags.js:66`** — fmtMin rounds minutes to 60 — panel and route card print times like '5:60p'  
      *Fix:* Round once, then split — mirror flag-sms: `const mm = ((Math.round(min) % 1440) + 1440) % 1440; h = Math.floor(mm/60); m = mm % 60;`.  
      <sub>Med · logic · A2-S12-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/board-flags.js:1410`** — No-driver card names assumed 5pm closes as customer deadlines, contradicting its own rule  
      *Fix:* Build `atRisk` from `realRisk` plus `doomed` (not `supersededRows`), or keep assumed entries but tag them (`assumed: true`) and print them as '~5:00p (assumed)'.  
      <sub>Med · comment-mismatch · A2-S12-4 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/load-assign.mts:74`** — Assignments doc is read-modify-written per tap; overlapping taps drop an assignment  
      *Fix:* Write assignments with a field-masked patch of `assignments.<loadNbr>` (patchDoc with a nested field path) or an updateTime precondition with retry; alternatively serialize toggles client-side.  
      <sub>Med · async-race · A6-S31-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/day-completion.mts:44`** — ?history=1&days=<non-numeric> yields NaN and silently returns an empty history  
      *Fix:* Parse with a finite check: `const n = Number(url.searchParams.get('days')); const days = Number.isFinite(n) ? Math.max(1, Math.min(HISTORY_DAYS, Math.floor(n))) : HISTORY_DAYS;`  
      <sub>Low · null-handling · A5-S26-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/eta-backtest.mts:330`** — Header says defaults are 'the whole captured window'; code pins 2026-07-28..2026-08-17  
      *Fix:* Derive the default `to` from etDayString()-1 and `from` from the warehouse's earliest sealed day (or a fixed lookback), or change the comment to say the defaults are a fixed reference window.  
      <sub>Low · comment-mismatch · A5-S26-18</sub>
- [ ] **`dispatch-map/netlify/functions/eta-flag-alert-background.mts:79`** — ?now=<non-number> replay writes NaN sighting minutes into flag history  
      *Fix:* Compute `nowMin` with a finite check (`Number.isFinite(n) ? n : null`) and return 400 for a malformed `?now=`; make writeHistory bail when `!Number.isFinite(nowMin)`.  
      <sub>Low · null-handling · A5-S26-14 · reproduced by running the code</sub>

### W10.4 — low (10 items)

- [ ] **`dispatch-map/netlify/functions/eta-flag-check.mts:340`** — ?now=<non-number> passes a NaN clock to the engine and mislabels every urgent row  
      *Fix:* Validate `nowParam` with `Number.isFinite` (accept HH:MM as eta-backtest does) and return 400 on anything else; never pass NaN into the engine or the explainers.  
      <sub>Low · null-handling · A5-S26-13 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/history-capture-health.mts:58`** — diagnose conclusion counts load keys over all stops, not eligible ones  
      *Fix:* Compute `with_load_key` over the eligible subset (the same predicate used for `byLoad`), or test `byLoad.size === 0` in the branch at line 81.  
      <sub>Low · logic · A5-S27-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/history-capture-health.mts:82`** — ?diagnose conclusion can blame min_route_stops when no eligible stop has a load key  
      *Fix:* Test `loadSizes.length === 0` before the `every` and emit the 'eligible stops exist but none carry a load identity' conclusion in that case (or compute with_load_key over eligible stops only).  
      <sub>Low · logic · A5-S27-14 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/day-completion.mts:513`** — flagLabel prints '1h60m warning' — minutes are rounded after the hour is floored  
      *Fix:* Round once first: `const m = Math.round(f.leadMin); const h = Math.floor(m / 60); const mm = m % 60;` and build both branches from `m`.  
      <sub>Low · logic · A3-S15-5 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/tractor-flags.mts:94`** — Comment says the primary-alias claimant wins a collision; code makes the first-processed card win  
      *Fix:* Do two passes: register every card's primary `externalIds.nuvizz` first, then fill from `aliases[]` only where the name is still unclaimed — that makes the code match the comment.  
      <sub>Low · comment-mismatch · A5-S25-12 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/tractor-flags.mts:123`** — tractorCount counts aliases, not employees, once aliases[] joined the roster  
      *Fix:* Count employees in buildVehicleRoster (increment a per-card counter when vehicleType==='tractor' and at least one alias exists) and carry that through tractorSlice instead of `aliasSet.size`.  
      <sub>Low · data-contract · A5-S25-11 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:14916`** — Profile migration sets the 'migrated' flag before the write succeeds; a refused write loses local profiles si…  
      *Fix:* Set the migrated flag only after the Promise.all resolves, and call `reportDenied('bottom_panel_profiles', e, 'write')` in the catch so a refused migration is surfaced like every other refused write.  
      <sub>Low · firestore-semantics · A1-S6-6</sub>
- [ ] **`dispatch-map/src/App.jsx:23445`** — Daily completion screen fails whole when only the history call fails to parse  
      *Fix:* Wrap the history fetch so a parse/network failure resolves to {ok:false} (e.g. `.then(r => r.json()).catch(() => ({ ok: false }))`) and keep rendering the live stats.  
      <sub>Low · error-handling · A2-S9-13 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:25984`** — Gmail admin key is appended to URLs as a query parameter (browser history / request logs)  
      *Fix:* Send the key in a header (e.g. x-admin-key) for the POST calls and have the start redirect exchange it server-side, with gmail-auth.mts reading the header first.  
      <sub>Low · security · A2-S9-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:27277`** — Unsubscribed list ignores the server's `capped` flag — a clipped list reads as complete  
      *Fix:* When data.capped is true render a line such as 'showing the first N — the list was capped' and pass a higher ?limit= when needed.  
      <sub>Low · data-contract · A2-S10-8</sub>

### W10.5 — low (6 items)

- [ ] **`dispatch-map/src/App.jsx:27294`** — Unsubscribed list prints a capped row count as the total and drops the server's `capped` flag  
      *Fix:* When `data.capped` is true, render a 'showing the first N — more exist' line next to the count and treat the split pills as partial.  
      <sub>Low · data-contract · A2-S10-12</sub>
- [ ] **`dispatch-map/src/lib/auth.js:4`** — Header says the retired flag yields 'the REAL login'; resolveGateMode renders the app with a warning  
      *Fix:* Rewrite the header to match resolveGateMode: the old flag alone renders the board plus a visible warning; only VITE_LOGIN_ENABLED puts up the gate.  
      <sub>Low · comment-mismatch · A2-S11-19 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/board-flags.js:183`** — arrivalAnchor prefers arrival over delivered when both exist, adding dwell already done  
      *Fix:* Check deliveredDTTM first in the field order, or when both same-day stamps exist return the delivered one.  
      <sub>Low · logic · A2-S12-8 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/board-flags.js:1013`** — startedRoutes is computed and never read; comment says the driverless rule reads it  
      *Fix:* Delete the startedRoutes set and the 1013–1016 paragraph, or make the comment say it is retained only for the panel/debug.  
      <sub>Low · comment-mismatch · A2-S12-7</sub>
- [ ] **`dispatch-map/src/lib/map-legend.js:157`** — Legend counts a flag tint for hidden pins whose actual pin is a DNS ✕ or route colour  
      *Fix:* Count tints only for entries the tint is actually painted on — move the tints increment below the hidden gate, or pass the resolved pin colour kind from the marker layer in the entry instead of re-deriving it from the note.  
      <sub>Low · logic · A3-S13-12 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/uline-forecast-score.js:680`** — mergeActuals flags a disagreement on raw row count even when the Uline PRO count agrees  
      *Fix:* Compare `actualCount(have.latest).value` with `Number(r.orders)` (or with a backfill ulinePros when present) instead of `Number(have.latest?.orders)`.  
      <sub>Low · data-contract · A3-S14-11 · reproduced by running the code</sub>


## W11. React state, effects and races in the dispatch board

**28 items** — 0 critical, 5 high, 11 medium, 12 low · 3 batches

**Why it matters.** Stale closures and in-flight races that show a dispatcher the wrong day’s data or a panel that will not act.

### W11.1 — critical and high (10 items)

- [ ] **`dispatch-map/netlify/functions/auth-change-password.mts:48`** — Fresh post-change token is refused by require-user's 30s user cache on a warm instance  
      *Fix:* In require-user.mts, on a tokenVersion mismatch re-read the store bypassing the cache before refusing (cheap, only on the mismatch path), or export an `invalidateUserCache(username)` and call it from bumpTokenVersion/patchUser; the endpoints themselves need n…  
      <sub>High · async-race · A5-S25-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:7103`** — StopActivityTimeline shows the previous order's events after switching stops  
      *Fix:* Reset `st` (and `open` if desired) when `stopNbr`/`stopId` change — e.g. `useEffect(() => setSt({ loading:false, events:null, error:null }), [stopNbr, stopId])` — or key StopDataSections/StopSidebar by stop id in the three parents.  
      <sub>High · react-state · X-react-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:8437`** — Sidebar draft never re-adopts an updated note (same id), so Save writes stale fields back  
      *Fix:* Depend on the note's content, not its id: key the adoption effect on `note` (or a stable last_updated/serialized signature) and keep the `dirtyRef` guard; also re-seed the draft from the current `note` when Edit is pressed.  
      <sub>High · react-state · A1-S3-3</sub>
- [ ] **`dispatch-map/src/App.jsx:10058`** — Draft adoption keyed on note?.id ignores same-doc updates; stale draft overwrites them on Save  
      *Fix:* Depend on the note's content, not its id: `}, [note])` (or a cheap version stamp like `note?.last_updated?.seconds`), keeping the `dirtyRef` guard so in-progress edits are still protected. Apply the same change to the desktop effect at 8438–8443.  
      <sub>High · react-state · A1-S4-5 · reproduced by running the code</sub>
- [ ] **`load-scan/src/App.jsx:960`** — Loaded-sequence stamp is deleted on every ScanScreen mount (freeze guard resets)  
      *Fix:* Do not decide 'nothing aboard' from React state that has not hydrated: read the queue (`store.queuedFor`) inside the effect and count `activeScans` from it, or skip the clear until `refreshLocal` has completed once (e.g. a `hydrated` ref).  
      <sub>High · react-state · A6-S32-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:2258`** — useDriverSnapshot: cached path never clears `loading` — driver drawer sticks on skeleton  
      *Fix:* In the cache-hit branch call `setLoading(false)` (and also in the `if (!driver)` branch), or reset loading unconditionally at the top of the effect before choosing the cached/fetch path.  
      <sub>Med · react-state · A1-S1-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:8242`** — 'Recent deliveries here' shows the previous customer's PROs while the new lookup is in flight  
      *Fix:* At the top of the effect, when the key is not cached, call `setRows(null)` before starting the fetch (or key StopRecentDeliveries by stop.matchKey so it remounts).  
      <sub>Med · react-state · A1-S3-11</sub>
- [ ] **`dispatch-map/src/App.jsx:11928`** — Async AI/search single-match auto-open can strand the mobile Map with no drawer showing  
      *Fix:* In the single-match branch on mobile, also clear the route (`setSelectedRoute(null); setRouteMapView(false)`) or skip the auto-open while a route sheet is open.  
      <sub>Med · react-state · A1-S5-13 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:17911`** — Roster refetch/failure wipes the identity onRouteCreated indexed for a just-created route  
      *Fix:* Merge instead of replace: build `index` then copy over any existing entries whose key is absent from the new roster (or keep a separate `createdRef` Map consulted after loadRosterRef in openRouteInWorkbench/onAssignDriver/onDispatchLoad), and do not clear the…  
      <sub>Med · react-state · A2-S7-10</sub>
- [ ] **`dispatch-map/src/App.jsx:18584`** — Mobile toast mirror silently drops a repeated identical refusal message  
      *Fix:* Make lastAction identity-bearing: store `{ msg, seq }` (or keep a `lastActionSeq` counter incremented in a setLastAction wrapper) and key the effect on the counter, so every set produces a toast.  
      <sub>Med · react-state · A2-S7-5 · reproduced by running the code</sub>

### W11.2 — medium (10 items)

- [ ] **`dispatch-map/src/App.jsx:21994`** — Engine tab map goes permanently blank after Sequencing → Assignment → Sequencing  
      *Fix:* Either keep the sequencing map div mounted (hide it with `hidden` instead of unmounting the block), or make the creation effect depend on `engineView` and reset `mapRef.current = null` (and clear markers/lines) when the div unmounts so the map is rebuilt on t…  
      <sub>Med · react-state · A2-S8-2</sub>
- [ ] **`dispatch-map/src/App.jsx:25021`** — Multi-file drop: the 'skipped N other non-PDF file(s)' note is wiped the moment the spreadsheet parses  
      *Fix:* Compute the skip note in onFiles and re-apply it after `await onFile(others[0])` (or fold it into importInfo), rather than relying on importErr which finishIngest resets.  
      <sub>Med · react-state · A2-S9-3</sub>
- [ ] **`dispatch-map/src/App.jsx:25098`** — Bulk push idempotency key is lost if a cell is edited during the push (identity compare)  
      *Fix:* Match by index (`idx === targets[k].idx`) or by a stable row id instead of object identity, and/or gate setCell on `busy` like the other grid mutations.  
      <sub>Med · react-state · A2-S9-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/components/LoginScreen.jsx:54`** — Firebase-leg failure warning can never be shown: screen unmounts before signIn resolves  
      *Fix:* Carry the Firebase outcome somewhere that outlives the screen: have signIn/changePassword/confirmPasswordReset return it AND stash it (e.g. a module-level authEvent 'firebase-failed' emitted from auth-client, consumed by App's existing onAuthEvent handler to …  
      <sub>Med · react-state · A2-S11-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/components/PasswordScreens.jsx:51`** — ChangePasswordScreen's 'database connection did not complete' error can never be seen  
      *Fix:* Move the Firebase-leg reporting to App (which stays mounted) — e.g. have App call ensureFirebaseSession() after the gate flips and surface a notice — or have changePassword() defer setSession until after the redeem so the screen is still mounted when it repor…  
      <sub>Med · react-state · A2-S11-12 · reproduced by running the code</sub>
- [ ] **`docs/scorecard-attempts/AttemptsCard.jsx:96`** — A failed delete hides the whole attempts table and reads as a successful removal  
      *Fix:* Track delete failures in a separate `deleteError` state (or toast) and keep rendering `attempts`; only the loader should set `error`.  
      <sub>Med · react-state · A6-S35-10</sub>
- [ ] **`dispatch-map/netlify/functions/auth-users.mts:122`** — Last-admin guard is check-then-act: two concurrent demotions can leave zero admins  
      *Fix:* Serialise the demotion through a Firestore transaction/commit precondition (e.g. re-read after write and roll back if the active-admin count is 0), or accept the race and document it; at minimum re-check the count after the write and restore the role if it hi…  
      <sub>Low · async-race · A5-S26-16 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/auth-store.mts:124`** — bumpTokenVersion returns a tv derived from the caller's stale doc, not the incremented value  
      *Fix:* After the atomic increment, re-read the document (getDoc) and return its tokenVersion, or have incrementDocFields return the committed value.  
      <sub>Low · async-race · A3-S14-14 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/manifest-ocr-result.mts:31`** — Job-doc delete is fire-and-forget in a sync function; 'never accumulate' is not guaranteed  
      *Fix:* Await the delete before responding (one small Firestore call) or pass it to `context.waitUntil` by accepting the second handler argument.  
      <sub>Low · async-race · A5-S27-13</sub>
- [ ] **`dispatch-map/src/App.jsx:6129`** — PdfPageCanvas forgets the measured page ratio when a page leaves the window, shifting the scroller  
      *Fix:* Keep `dims` when going inactive (only zero the canvas), or store the measured ratio in a ref that survives eviction.  
      <sub>Low · react-state · A1-S3-10</sub>

### W11.3 — low (8 items)

- [ ] **`dispatch-map/src/App.jsx:10548`** — DebugCaptureSheet mountedRef never re-arms under StrictMode double-effects  
      *Fix:* Set the flag in the effect body as well: `useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);` — or drop the ref entirely, since the component is never unmounted while open (it returns null when closed).  
      <sub>Low · react-state · A1-S4-11 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:13053`** — Bottom-grid resize handle leaks document pointermove listener on pointercancel  
      *Fix:* Also remove the listeners on `pointercancel` (and on unmount), e.g. register `up` for both 'pointerup' and 'pointercancel', or use setPointerCapture on the handle so the up/cancel always reach it.  
      <sub>Low · react-state · A1-S5-12 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:14706`** — Stale 2.5s 'saved→ready' timer can re-enable Save during a second in-flight save  
      *Fix:* Keep the timer id in a ref, clear it at the start of save() and on unmount, and only downgrade to 'ready' if status is still 'saved'.  
      <sub>Low · async-race · A1-S6-8</sub>
- [ ] **`dispatch-map/src/App.jsx:21355`** — LoadRow rename draft is seeded once, so Rename → Save can revert another device's rename  
      *Fix:* Seed the draft when editing starts (`onClick={() => { setDraft(l.name || ''); setEditing(true); }}`), or add `useEffect(() => setDraft(l.name || ''), [l.name])` in LoadRow and include `load?.name` in SavedLoadManageBar's resync effect.  
      <sub>Low · react-state · A2-S8-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:26465`** — Send-log range requests race; a slower older request overwrites the newer range's rows  
      *Fix:* Keep a request sequence counter (or AbortController) in a ref inside useCommsConsole and ignore responses whose sequence is not the latest before calling setLog/setLogBusy.  
      <sub>Low · async-race · A2-S10-10</sub>
- [ ] **`dispatch-map/src/lib/auth-client.js:152`** — ensureFirebaseSession reads currentUser before persistence restores; re-mints on every boot  
      *Fix:* Await `fb.auth.authStateReady()` (firebase/auth ≥ 10.x) or wrap a one-shot onAuthStateChanged before reading currentUser, then keep the existing check.  
      <sub>Low · async-race · A2-S11-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/auth-client.js:238`** — signOut waits on the network before clearing locally; a hung request leaves the person signed in  
      *Fix:* Clear the local session and Firebase identity first (or race the logout call against a short timeout), then let the auth-logout revocation complete in the background: `clearDenied(); clearSession(); dropFirebaseSession(); authCall('auth-logout', …)` with the …  
      <sub>Low · async-race · A2-S11-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/useSortable.jsx:17`** — setSortDir is a side effect inside the setSortKey updater; double-invoked under StrictMode  
      *Fix:* Use a single state object { key, dir } with one pure updater: toggle = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })). Apply the same change to the App.jsx copy.  
      <sub>Low · react-state · A3-S14-16 · reproduced by running the code</sub>


## W12. Dock scanner: the rest

**20 items** — 0 critical, 7 high, 6 medium, 7 low · 2 batches

**Why it matters.** Everything else in load-scan — the freight that scans red, the report that reads short, the alias that logs in as the wrong person.

### W12.1 — critical and high (10 items)

- [ ] **`load-scan/netlify/functions/driver-admin.mts:198`** — upsert can deactivate the last active dispatcher, bypassing the set-active guard  
      *Fix:* In the upsert branch, when `existing` is set and the resolved `active` is false, apply the same guard: if (isLastActiveDispatcher(await listDocs(DRIVER_AUTH), driverNumber)) return bad('cannot deactivate the last dispatcher — promote another one first', 409).  
      <sub>High · security · A5-S30-3 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/lib/activity.mts:191`** — Activity view counts pickup pieces in expected, so a clean-closed load reads closed_short  
      *Fix:* Compute the load's expected from non-pickup stops in buildActivity (`(l.stops||[]).filter(s=>!s.isPickup).reduce(...)`, falling back to l.expectedPieces when no stops are attached) or have scan-activity.mts derive expectedPieces the same way the phone's loadP…  
      <sub>High · data-contract · A5-S30-7 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/lib/aliases.mts:142`** — planAliasAdd/findAmbiguousAliases ignore displayName, but name login counts it  
      *Fix:* In planAliasAdd and findAmbiguousAliases, treat normalizeDriverAlias(c.displayName) as a claim alongside nuvizzAliases (the same predicate resolveLoginIdentifier uses), so the add is refused and the ambiguity is surfaced.  
      <sub>High · logic · A5-S30-2 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/lib/manifest.mts:190`** — Segment-suffixed stopNbr (007157687-1) yields a bogus PRO key; correct freight scans RED  
      *Fix:* In normalizePro (or prosFor), strip a segment suffix the same way dispatch-map's proKeys does before taking digits: const seg = /^(\d{9})-(\d{1,2})$/.exec(String(v ?? '').trim()); const digits = (seg ? seg[1] : String(v ?? '')).replace(/\D/g, ''); then slice(…  
      <sub>High · logic · A5-S30-1 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/lib/workreport.mts:145`** — Per-person rows judged against the whole load: two-person trucks all read 'short'  
      *Fix:* Compute `short`/`status`/complete-ness once per LOAD from the sum of all sessions' pieces (or from the scan doc's scannedCount), derive per-person rows from that, and count loadsStarted/loadsComplete over distinct loadNbr.  
      <sub>High · logic · A6-S31-5 · reproduced by running the code</sub>
- [ ] **`load-scan/src/App.jsx:1162`** — Gun: second same-PRO label within 3s has its PRO read dropped by the shared gate  
      *Fix:* Register the post-booking cooldown only for camera engines (`if (engineName !== 'wedge') gate.current.allow(...)`), or key the gun's stutter guard on a shorter window/own gate instance.  
      <sub>High · logic · A6-S32-5 · reproduced by running the code</sub>
- [ ] **`load-scan/src/App.jsx:3404`** — Offline truck switch for a loader opens the wrong cached manifest and shows 'No load'  
      *Fix:* Cache per load (`cacheKey(date, driverNumber, loadNbr)`) and, when the fetch for a picked load fails and the cache has no stops for it, stay on the picker with the offline message instead of calling `setActiveLoad`.  
      <sub>High · logic · A6-S32-10</sub>
- [ ] **`load-scan/netlify/functions/lib/worklog.mts:51`** — Finish event `pieces` is the load total, not the person's count; rollups double-count  
      *Fix:* Do not trust client pieces for the events path: on the server derive the person's pieces from the scan doc's workedBy entry (work-report already reads it), or have the client send this worker's own count; at minimum treat `pieces` from a finish event as load-…  
      <sub>Med · data-contract · A6-S31-17 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/lib/worklog.mts:120`** — Source stays 'events' when the finish (or start) was filled in from scan times  
      *Fix:* Track the source per timestamp (e.g. startSource/finishSource) or only keep 'events' when both startedAt and finishedAt came from event kinds; report 'events' only when both are measured.  
      <sub>Med · comment-mismatch · A6-S31-6 · reproduced by running the code</sub>
- [ ] **`load-scan/src/App.jsx:216`** — 'Everything else on the dock' heading placed at mine.size, not at the count of matched trucks  
      *Fix:* Compute `const mineCount = all.filter(l => mine.has(String(l.loadNbr))).length` and compare `i === mineCount` (and guard `mineCount > 0`).  
      <sub>Med · logic · A6-S32-12 · reproduced by running the code</sub>

### W12.2 — medium (10 items)

- [ ] **`load-scan/src/App.jsx:1417`** — Hand-confirm sends a fixed `pieces` snapshot the phone itself does not honour  
      *Fix:* Either send the confirm without a fixed count and let the server compute the remainder the way stopProgress does, or block further scans/voids on a hand-confirmed stop.  
      <sub>Med · data-contract · A6-S32-13 · reproduced by running the code</sub>
- [ ] **`load-scan/src/App.jsx:1873`** — Pickup order card offers 'add a piece by hand'; booking it inflates the load total while closeout says clean  
      *Fix:* Do not pass `onAddPiece`/`onMarkDamaged`/`onVoidPiece` for a pickup (`openStop.isPickup`), and have `record` refuse a PRO whose owner stop `isPickup` (or count `scannedPieces` only over loading stops).  
      <sub>Med · logic · A6-S32-9 · reproduced by running the code</sub>
- [ ] **`load-scan/src/lib/scan-logic.js:479`** — Load total counts scans no loading stop owns; clean=true with a piece over  
      *Fix:* Derive the load's scannedPieces from the per-stop results (distinct OGs owned by loading stops) or at minimum set clean = clean && over === 0; and have evaluateScan (or its caller) treat isPickup stops as not loadable so the scan is refused rather than booked.  
      <sub>Med · logic · A6-S33-2 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/lib/worklog.mts:139`** — Comment promises a wrong phone clock cannot misfile the shift; code derives it from the phone's `at`  
      *Fix:* Clamp: if |Date.parse(at) - Date.now()| exceeds a bound (say 12h), use server time (or reject with a reason) and record `clockSkewMs`; then correct the comment to describe what is actually guaranteed.  
      <sub>Low · comment-mismatch · A6-S31-20 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/lib/workreport.mts:231`** — Worker pieces/hour divides ALL pieces by only the timed minutes  
      *Fix:* Sum pieces only over rows that contribute minutes (the `timed` set already computed for avgMinutesPerLoad) when computing the rate.  
      <sub>Low · logic · A6-S31-11 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/lib/workreport.mts:266`** — CSV cells are not neutralised against spreadsheet formula injection  
      *Fix:* In esc(), prefix a cell whose first character is one of = + - @ (or tab/CR) with a single quote before the existing quoting; and stop accepting workerName from the body in work-session (use claims.name).  
      <sub>Low · security · A6-S31-22 · reproduced by running the code</sub>
- [ ] **`load-scan/netlify/functions/load-manifest.mts:73`** — Manifest read mask drops `scannable`, `appointmentRequired`, `comments`, `address` that toManifestStop reads  
      *Fix:* Add 'scannable', 'appointmentRequired', 'comments', 'address' to the mask (and keep the mask and toManifestStop's field list in one exported constant so they cannot drift).  
      <sub>Low · data-contract · A6-S31-21 · reproduced by running the code</sub>
- [ ] **`load-scan/src/lib/scan-logic.js:118`** — Expired lone PRO is reported 'superseded' (orphan) instead of booking when next frame is complete  
      *Fix:* Move `if (expired(now)) abandon('expired', now);` to the top of push(), before the frame.complete branch.  
      <sub>Low · logic · A6-S33-7 · reproduced by running the code</sub>
- [ ] **`load-scan/src/lib/scanner.js:16`** — Header says Quagga moved to multiple:true; the config is multiple:false  
      *Fix:* Delete or rewrite lines 16-20 to say Quagga runs single-result and pairing happens in createPairBuffer.  
      <sub>Low · comment-mismatch · A6-S33-18</sub>
- [ ] **`load-scan/src/lib/shift.js:57`** — fmtMinutes prints '60m' and '1h 60m' for values that round up  
      *Fix:* Round once up front: const t = Math.round(min); then split t into hours and minutes.  
      <sub>Low · logic · A6-S33-6 · reproduced by running the code</sub>


## W13. Dispatch board client: the rest

**46 items** — 0 critical, 5 high, 19 medium, 22 low · 5 batches

**Why it matters.** Screens and helpers in App.jsx and src/lib that show or do the wrong thing, outside the themes above.

### W13.1 — critical and high (10 items)

- [ ] **`dispatch-map/src/App.jsx:10487`** — Debug capture promises no customer names/addresses but ships them via matchKey  
      *Fix:* In scrubStop replace `matchKey: s.matchKey` with a one-way digest (e.g. first 12 hex of SHA-256 of the key, or a per-bundle sequential alias) so the join survives but the name/address does not; update the warnings[] text and the sheet copy to match what is ac…  
      <sub>High · security · A1-S4-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:12706`** — Desktop status pill never shows halted-scanner banner; scanErr hidden when collapsed  
      *Fix:* Mirror the mobile markup: move the `{scanErr && ...}` div out of the `!statusCollapsed` block and add the same `{scanState?.halted && (...)}` banner after it in the desktop pill.  
      <sub>High · logic · A1-S5-1</sub>
- [ ] **`dispatch-map/src/App.jsx:20010`** — Right-rail Loads click opens an EMPTY Compare card for a built load  
      *Fix:* In pickLoadToCompare, when no stop matches, look the number up in loadRosterRef.current (indexed by loadNbr/loadId) and retry the match on `p.routeName === entry.name` before falling back to the bare number; or have the rail pass `r.ambiguous ? (r.loadNbr || …  
      <sub>High · data-contract · A2-S7-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:20143`** — Engine-draft cards are created with loadNbr:null, so their Save is always refused  
      *Fix:* Import routeLoadNbr from lib/route-create.js and set `loadNbr: routeLoadNbr(key, selectedDate)` on the pushed card (and skip/rename the trip if it returns ''), or derive it in sendPendingCreates when `r.loadNbr` is empty.  
      <sub>High · data-contract · A2-S7-8 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:20930`** — Desktop Routing map ignores the grid Status/driver filter (prop only wired on mobile)  
      *Fix:* Add `onStatusFilterChange={setStatusFilterIds}` to the desktop BottomStopsTable call (after `onSearchMatchChange` at line 20943), matching the mobile call at line 20747.  
      <sub>High · logic · A2-S8-1</sub>
- [ ] **`dispatch-map/src/App.jsx:3594`** — Status card says 'Orders paused until 10 AM' while the orders feed runs every 15 min  
      *Fix:* Drop the `< 10` clause (or derive 'paused' from the server's scan plan / dueKinds rather than a client-side hour) and always print `fmtFeedAge(unplannedAt)`; keep a 'paused' phrasing only when the server reports the kind as off-schedule.  
      <sub>Med · comment-mismatch · A1-S2-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:8265`** — Recent-deliveries footer prints 'first visit to this customer' when the lookup failed  
      *Fix:* Keep `rows` null (or a distinct 'error' value) when both lookups failed: `if (alive) setRows(list)` and treat null as 'unknown' in the renderer.  
      <sub>Med · comment-mismatch · A1-S3-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:9400`** — PastProSearch merges customers by lowercase name, collapsing distinct locations of one chain  
      *Fix:* Key the merge Map by `matchKey` (falling back to name+addr) instead of by name: `const key = (c.matchKey || `${c.name}|${c.addr1}|${c.city}|${c.zip}`).toLowerCase()`, and use the same key for `localCustomers.key` at 9362.  
      <sub>Med · logic · A1-S4-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:12834`** — Desktop empty state claims 'No loads are built for this date' when filters hide stops  
      *Fix:* Branch on `stops.length`: when `stops.length > 0` show 'No stops match the current filters.' (plus the searchHiddenByFilters / clearAllStopFilters affordance the mobile view has) regardless of date; reserve 'No loads are built for this date yet.' for `stops.l…  
      <sub>Med · logic · A1-S5-5 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:12984`** — 'Cancelled' grid bucket includes code-80 Unable-to-deliver; window pull only 99  
      *Fix:* Split the bucket: keep 'Cancelled' for code 99 / normalizedStatus CANCELLED (and add that value client-side), and add an 'Unable to deliver' bucket for code 80 / EXCEPTION, with matching `codes` so board mode and window pulls agree.  
      <sub>Med · logic · A1-S5-3 · reproduced by running the code</sub>

### W13.2 — medium (10 items)

- [ ] **`dispatch-map/src/App.jsx:14437`** — Cadence preview ignores the 10-min hard floor: a typed 5 shows 5, scanner delivers 10  
      *Fix:* Import RULE_BOUNDS from scan-plan.mts and compute the preview as `effectiveCadence(Math.max(RULE_BOUNDS.intervalMin[0], Number(min)))` (or run the form rules through clampScanRules before PlanGrid/PlanEstimate/ScanKindCard read them).  
      <sub>Med · comment-mismatch · A1-S6-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:14971`** — truck_profiles seed on any empty snapshot uses full-replace setDoc; an offline cold start can clobber edited …  
      *Fix:* Only seed when the snapshot is from the server (`!snap.metadata.fromCache`), and use `setDoc(..., p, { merge: true })` so a seed can never overwrite edited fields.  
      <sub>Med · firestore-semantics · A1-S6-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:16537`** — Dropped reorder ends up reported as saved and the card is marked clean  
      *Fix:* Do not include a load in markSaved/okKeys when its order fields were stripped (track the stripped keys from buildBoardPayload and skip markSaved for them), and keep the warning visible by appending it to the final result toast rather than overwriting it.  
      <sub>Med · logic · A1-S6-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:18705`** — Dispatch override '#id:' key uses route NAME; never retires, masks later roster status  
      *Fix:* Use the resolved id: `const idKey = loadId;` (and also set `'#id:' + loadNbr` when a real loadNbr was resolved) so the key matches what buildRosterStatusMap writes and the retire loop can drop it.  
      <sub>Med · comment-mismatch · A2-S7-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:19162`** — New route can duplicate the name of an existing empty Draft load  
      *Fix:* Include non-cancelled roster names in existingNames (e.g. `[...routeGroups.map(g => g.name || g.key), ...loadRosterList.filter(l => !isCancelledStatus(l.status)).map(l => l.name)]`) and have createNewRoute refuse when `loadRosterRef.current.get(routeName.toLo…  
      <sub>Med · logic · A2-S7-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:21803`** — Engine tuning Save writes 0 (or the floor) for any field the user cleared  
      *Fix:* Skip (or treat as a reset) any edit whose trimmed string is empty: `const s = String(v).trim(); if (!s) continue; const n = Number(s); ...`, and disable Save / show an error while any edited field is blank.  
      <sub>Med · null-handling · A2-S8-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:25222`** — Pushed tab drops `email` from the cloud push log — every pushed order shows no email  
      *Fix:* Add `email: r.email || ''` to the cloudPushedRows object literal.  
      <sub>Med · data-contract · A2-S9-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:25843`** — 'Every order you push from Bulk Add is logged here' is false for load-mode creates  
      *Fix:* In createAsLoad's success path, build pushedLogRecords from payloadRows (orderRef = stopNbr, nuvizzNbr = stopNbr, plus the load number in manifestNumber or a new field) and POST them to manifest-push-log the same way createAll does; or change the on-screen se…  
      <sub>Med · comment-mismatch · A2-S9-11</sub>
- [ ] **`dispatch-map/src/App.jsx:26521`** — Cleared Daily-cap box saves as 0 — program stays ON but sends nothing  
      *Fix:* Refuse the save (say('save','err',…)) when String(dailyCap).trim() === '' or Number(dailyCap) is not finite, rather than coercing; only send dailyCap when the field holds a number.  
      <sub>Med · null-handling · A2-S10-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/components/MessagesPanel.jsx:238`** — Echo cleanup deletes a FAILED send when an older identical outbound exists  
      *Fix:* Exclude failed echoes from the cleanup and only match records at least as new as the echo: `p.filter((pm) => pm.status === 'failed' || !(messages||[]).some((m) => m.direction==='out' && normPhone(m.contactPhone)===pm.phone && (m.text||'').trim()===pm.text.tri…  
      <sub>Med · logic · A2-S11-2 · reproduced by running the code</sub>

### W13.3 — medium (10 items)

- [ ] **`dispatch-map/src/lib/address-fix.js:54`** — Unit-token branch swaps on ANY digit in addr2, proposing phone numbers / PO boxes as the street  
      *Fix:* Use STARTS_WITH_NUMBER.test(a2) in Case A2 (same rule the rest of the file uses) and return null otherwise so the manual editor is offered instead.  
      <sub>Med · logic · A2-S11-14 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/ai-search.js:140`** — timeCompare string-compares HH:MM; an unpadded value inverts the result  
      *Fix:* Normalize both sides in timeCompare: `const pad = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s||'')); return m ? `${m[1].padStart(2,'0')}:${m[2]}` : ''; }` and compare pad(have) with pad(want), returning false when either is empty.  
      <sub>Med · logic · A2-S11-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/matchKey.js:26`** — Match key differs for 'Acme LLC' vs 'Acme' — trim() runs after spaces became underscores  
      *Fix:* Trim and collapse BEFORE replacing whitespace: `.replace(NAME_SUFFIXES,'').replace(/[^\w\s]/g,'').trim().replace(/\s+/g,'_')` for both name and street, mirrored in match-key.mts, and add the 'Acme LLC' === 'Acme' case to the parity test. Note existing docs ke…  
      <sub>Med · logic · A3-S13-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/uline-forecast-score.js:731`** — Unscored/unforecast nights report the raw row count, not the Uline PRO count the rest of the view uses  
      *Fix:* Use `c.actual ?? actualCount(row?.latest).value` for both pushes instead of `row?.latest?.orders`.  
      <sub>Med · data-contract · A3-S14-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:139`** — customer_notes `updated_by` is hardcoded 'dispatcher' although a signed-in user now exists  
      *Fix:* Derive the stamp from the session when one exists: `updated_by: getSession()?.user?.username || NOTES_UPDATED_BY`, in both writers; update the comment.  
      <sub>Low · comment-mismatch · A1-S1-9</sub>
- [ ] **`dispatch-map/src/App.jsx:1445`** — useSortable: comment promises asc → desc → null, code never clears; setState inside an updater  
      *Fix:* Keep sort state in one object ({key, dir}) and compute the next state in a single pure updater: different key → {key,'asc'}; same key asc → desc; same key desc → {key:null}.  
      <sub>Low · comment-mismatch · A1-S1-4</sub>
- [ ] **`dispatch-map/src/App.jsx:3570`** — fmtFeedAge prints 'NaN d ago' for a malformed timestamp  
      *Fix:* After computing `new Date(iso).getTime()`, return null when it is NaN (mirroring fmtAbsoluteET), so the row falls back to '—'.  
      <sub>Low · null-handling · A1-S2-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:3781`** — Manual scan: the documented 60 s cooldown is skipped whenever the scan errors, so a failing button can be mas…  
      *Fix:* Move `setScanCooldown(true); setTimeout(() => setScanCooldown(false), 60000)` into the `finally` (or duplicate it in the catch) so the cooldown applies on failure too.  
      <sub>Low · logic · A1-S2-7</sub>
- [ ] **`dispatch-map/src/App.jsx:5290`** — SmsComposeModal comment says the driver's number never reaches the browser; send-sms echoes it in results[].to  
      *Fix:* In send-sms.mts omit `to` from results for driverName-resolved recipients (return label only), or correct the two comments if exposing it is acceptable.  
      <sub>Low · comment-mismatch · A1-S2-9</sub>
- [ ] **`dispatch-map/src/App.jsx:5680`** — CarryoverControl clamps only new picks; a persisted carryoverDays > 14 still misreports the fold  
      *Fix:* Clamp `carryoverDays` to 0..14 when the filters are read from localStorage (in the useState initializer) and/or in CarryoverControl before deriving sinceForValue.  
      <sub>Low · data-contract · A1-S2-10 · reproduced by running the code</sub>

### W13.4 — low (10 items)

- [ ] **`dispatch-map/src/App.jsx:6558`** — BOL weight: '' or non-numeric stop.weight stops the fallback chain (0 or blank instead of line sum)  
      *Fix:* Normalise with a finite check: `const num = (v) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? null : n; }` and use `num(stop.weight) ?? num(raw.weight) ?? lineWtSum`.  
      <sub>Low · null-handling · A1-S3-8 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:9277`** — BottomSheet comment promises drag handle, 3 snap stops, backdrop and fling-to-close; none exist  
      *Fix:* Rewrite the comment to describe the actual behaviour (full-screen or fit-content slide-up, no gestures, consumer supplies its close control) and drop the unused `heights` props at the four call sites (or implement the described snapping).  
      <sub>Low · comment-mismatch · A1-S4-8</sub>
- [ ] **`dispatch-map/src/App.jsx:9914`** — MobileDriversTab reads driver fields the Motive feed does not carry (dead code)  
      *Fix:* Either delete the unused component or change it to read vehicleNumber / driverName / locatedAt (via fmtTimeAgo) and key on vehicleId || vehicleNumber, matching DriverSnapshotHeader.  
      <sub>Low · data-contract · A1-S4-13 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:11315`** — Chat highlight matches stop numbers by raw substring of the answer text  
      *Fix:* Match on word boundaries: build a Set of digit tokens from the text (`text.match(/\d+/g)`) and test `tokens.has(id)`, or use `new RegExp('(?<!\\d)' + id + '(?!\\d)')`.  
      <sub>Low · logic · A1-S4-12 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:14593`** — ScanKindCard '≈ N scans on a Tuesday' counts rules with enabled:false  
      *Fix:* Add `if (r.enabled === false) continue;` to the perDay loop in ScanKindCard (same as PlanGrid.cell).  
      <sub>Low · logic · A1-S6-5 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:20341`** — Grid-header date picker is gated on the Setup-panel toggle, not on whether Setup is visible  
      *Fix:* Gate the compact DatePicker on whether controlsContent is actually on screen — e.g. `const setupVisible = !isMobile && leftPanelOn && wbRoutes.length === 0;` and render the picker when `!setupVisible` — and drop `leftPanelToggle` from the phone's gear list.  
      <sub>Low · logic · A2-S8-5</sub>
- [ ] **`dispatch-map/src/App.jsx:20786`** — Mobile Setup sheet renders the selected-stops list twice  
      *Fix:* Render one of the two on mobile — e.g. drop the `isMobile && <RoutingSelectedList/>` inside controlsContent now that MobileSelectedStops wraps RoutingStopsPanel above it.  
      <sub>Low · comment-mismatch · A2-S8-10</sub>
- [ ] **`dispatch-map/src/App.jsx:21412`** — fmtRouteDur prints '60m' and '1h 60m' for durations just under an hour boundary  
      *Fix:* Round to whole minutes first, then split: `const t = Math.round(sec / 60); const h = Math.floor(t / 60), m = t % 60;`.  
      <sub>Low · logic · A2-S8-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/App.jsx:27211`** — Comment says a new range re-opens the newest day; it does not when that day is unchanged  
      *Fix:* Add c.openDays (or c.range) to the effect's dependency list so the auto-open re-runs after loadLog clears the set.  
      <sub>Low · comment-mismatch · A2-S10-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/components/ChatPanel.jsx:33`** — renderRich drops any answer line starting with '--' and collapses empty table cells  
      *Fix:* Anchor the separator to pipe/dash/colon/space characters only (e.g. /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$/) and keep empty cells (map to '—') instead of filtering them out.  
      <sub>Low · logic · A2-S10-9 · reproduced by running the code</sub>

### W13.5 — low (6 items)

- [ ] **`dispatch-map/src/components/DriversPanel.jsx:1`** — DriversPanel is not mounted anywhere; docs and guards still treat it as live  
      *Fix:* Either re-add the import and the menu entry in App.jsx (both the desktop nav and the phone chip menu) or delete the component and update api.js/auth-core.mts comments and the wiring tests so the loadscan-admin exclusion is not justified by a caller that does …  
      <sub>Low · other · A2-S11-7</sub>
- [ ] **`dispatch-map/src/components/LoginScreen.jsx:215`** — Screens promise a one-hour reset link; the server expires it after 30 minutes  
      *Fix:* Import a shared TTL (or state '30 minutes') in both screens so the copy matches RESET_TTL_MINUTES; the email already uses the constant.  
      <sub>Low · comment-mismatch · A2-S11-4</sub>
- [ ] **`dispatch-map/src/components/PasswordScreens.jsx:199`** — Reset screen says the link 'expires an hour after it was sent'; server TTL is 30 minutes  
      *Fix:* Change the copy to 30 minutes or export the TTL from a shared constant the client can import.  
      <sub>Low · comment-mismatch · A2-S11-15</sub>
- [ ] **`dispatch-map/src/lib/api.js:70`** — loadscan-admin exclusion is bypassed by a trailing slash  
      *Fix:* Strip trailing slashes before taking the last segment (e.g. clean.replace(/\/+$/, '')), and add the trailing-slash case to api-fetch.test.mjs.  
      <sub>Low · security · A2-S11-18 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/uline-forecast-score.js:648`** — tonightLine treats a forecast of 0 as an open night; closedShipDays/classifyNight call it closed  
      *Fix:* Change the guard at 648 to `if (!cov || est == null || est === 0)` (or `closed.has(shipIso)`) so the tonight line uses the same closed rule as the rest of the module.  
      <sub>Low · logic · A3-S14-12 · reproduced by running the code</sub>
- [ ] **`dispatch-map/src/lib/useSortable.jsx:40`** — Descending sort puts null/undefined cells FIRST; header comment promises 'nulls last'  
      *Fix:* Fold direction into the comparator (multiply only the non-null comparison by -1 for desc) and keep the null checks returning 1/-1 unchanged, in both copies.  
      <sub>Low · comment-mismatch · A3-S14-8 · reproduced by running the code</sub>


## W14. Dispatch functions and libraries: the rest

**36 items** — 0 critical, 5 high, 12 medium, 19 low · 4 batches

**Why it matters.** Endpoints, scheduled jobs and shared libraries outside the themes above.

### W14.1 — critical and high (10 items)

- [ ] **`dispatch-map/netlify/functions/customer-comms-sweep-background.mts:56`** — Customer email cap is per-RUN, not per-day: 2x dailyCap still goes out in one calendar day  
      *Fix:* Compute the day's allowance from a calendar-day counter (sum of both dates' ledgers written today, or a `customer_comms_day_<etDay>` sent counter) rather than resetting `remaining` per invocation; pass `budgetCeiling = dailyCap - sentSoFarToday` into every sw…  
      <sub>High · logic · X-background-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/manifest-email-ingest.mts:73`** — Nightly manifest doc drops grade/coverage; the nav badge can never light for a real miss  
      *Fix:* Add `coverage: diff.coverage ?? null, grade: diff.grade ?? null` to toStoredEmailRun (and pin them in the 'stored shape matches' test at manifest-email-ingest.test.mjs 142-148); the client's gradeOf already prefers stored grade/coverage over the fallback.  
      <sub>High · data-contract · A3-S13-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/manifest-extract.mts:213`** — intOrNull(null) returns 0: null header totals and null units become real zeros  
      *Fix:* Treat null/undefined/'' as null before coercing: `const intOrNull = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; }` and add a test with null header totals asserting no header warnings …  
      <sub>High · null-handling · A3-S17-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/marginiq.mts:62`** — resolveDriverPhone ignores employee status: texts can go to terminated employees  
      *Fix:* Apply the same gate in loadMap: `if (!isMessageable(e)) continue;` before indexing the names.  
      <sub>High · logic · A3-S18-5 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/route-departures.mts:106`** — ?refit=1&days=<non-numeric> publishes an EMPTY departure table  
      *Fix:* Parse with `parseInt(..., 10)` and fall back to 21 when not finite; validate `through` against /^\d{4}-\d{2}-\d{2}$/; and refuse to publish (return 409 or force dry) when `Object.keys(table).length === 0` or `daySamples.length === 0`.  
      <sub>High · null-handling · A5-S28-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/auth-users.mts:137`** — reset returns ok:true with neither an email nor a temp password when Resend rejects the send  
      *Fix:* When `emailed` is false, fall through to the temp-password branch (generate, hash, write, return it once) or at least return `ok: false` with an error naming the send failure so the caller can retry with `tempPassword: true`.  
      <sub>Med · comment-mismatch · A5-S26-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/day-completion-report-background.mts:131`** — Yesterday's reconciliation has no retry: spare stands down once a snapshot exists  
      *Fix:* In the `late` branch, do not return when the snapshot exists; fall through to step 3 (or run step 3 first, independently guarded by its own try/catch), and have step 3 use readDayCompletionStrict so a read blip is retried rather than recorded as 'no snapshot'.  
      <sub>Med · logic · A5-S26-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/eta-backtest.mts:606`** — Model F does not 'restart at the depot' as its comment claims; first open leg starts at the previous stop  
      *Fix:* Replay the tail properly: for each k, re-run the walk from DEPOT at DEPART_MIN over `visits.slice(k)` (or add the depot->stop k leg and drop the stop k-1->k leg from `shift`) instead of subtracting a scalar shift from the full-chain predA.  
      <sub>Med · comment-mismatch · A5-S26-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/eta-backtest.mts:657`** — observed_travel ratios are rounded to whole numbers by pct(), so implied road factor/mph are wrong  
      *Fix:* Add an unrounded percentile (e.g. `pctRaw`) and use it for the ratio percentiles and the implied factor/mph, leaving the rounding in the existing integer-minute call sites.  
      <sub>Med · logic · A5-S26-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/eta-miss-ledger-background.mts:348`** — Departure backfill creates day-docs, so calDayMissing never seeds older days' samples  
      *Fix:* Make the seed test look for the samples, not the doc: `calDayMissing` should return true when the doc lacks a `samples` key (e.g. `!doc || !('samples' in doc)`), mirroring how `needsDepartureBackfill` keys on `'departures' in doc`.  
      <sub>Med · logic · A5-S27-2 · reproduced by running the code</sub>

### W14.2 — medium (10 items)

- [ ] **`dispatch-map/netlify/functions/lib/attempts-core.mts:200`** — Attempts manifest counts only the last run; failed pull writes ok:true/attempts:0 over surviving items  
      *Fix:* After upserting, re-list the day's items and compute counts from the surviving set (reuse recountManifest), and set `ok: fetchOk` (or skip rewriting the manifest counts when the pull failed).  
      <sub>Med · data-contract · A3-S14-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/cs-notify.mts:141`** — cs-notify buildEmail interpolates shipper-typed fields into HTML unescaped  
      *Fix:* Escape every interpolated value in the html branch of buildEmail (reuse escapeHtml from customer-comms.mts) and keep the text branch as-is.  
      <sub>Med · security · A3-S15-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/customer-comms.mts:179`** — clampDailyCap turns null/''/true/[] into a valid cap (0 or 1) instead of rejecting  
      *Fix:* Reject non-number input explicitly: `if (typeof n !== 'number' && typeof n !== 'string') return null; if (typeof n === 'string' && !n.trim()) return null;` before the Number() coercion (or `if (n === null || n === '' || typeof n === 'boolean' || Array.isArray…  
      <sub>Med · null-handling · A3-S15-2 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/customer-comms.mts:1303`** — Send pacing floor is applied to every stop, not to sends — sweep sleeps 600ms per skip  
      *Fix:* Advance `lastSendStart` only when `sendForStop` actually attempted a send (e.g. set it after the call when `!r.skipped`), or move the wait into `sendForStop` immediately before `d.send`; separately, skip stops whose key is already in the ledger read at line 1…  
      <sub>Med · comment-mismatch · A3-S15-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/gmail-store.mts:126`** — patchStatus lenient read + replace wipes the Gmail connection status and search query  
      *Fix:* Replace patchStatus's read-merge-write with updateDocFields(GMAIL_STATUS_DOC, patch) (creates when absent, never touches other fields).  
      <sub>Med · firestore-semantics · X-firestore-4 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/refresh-stops-core.mts:1375`** — Shown-vs-list address check re-enriches every scan when the list row is partially blank  
      *Fix:* Compare the list against the shown address only on the fields the list actually carried: compute shownSig from a copy of s taken after mergeEnrich but with the list-blank fields (addr1/zip where !hasListValue(listRow[k])) blanked, or short-circuit the check w…  
      <sub>Med · logic · A4-S22-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/uline-forecast-ingest.mts:199`** — Two unreadable forecast attachments on one day share a versionId; the second overwrites the first  
      *Fix:* For !lane.ok versions derive the id from the byte digest (createHash('sha256').update(buf)) or append the email id, e.g. versionIdFor(tenant, sentDate, lane.ok ? digest : bytesDigest), so two distinct unreadable files never collide; keep the content digest on…  
      <sub>Med · logic · A5-S25-1 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/customer-comms-config.mts:84`** — A JSON body of `null` throws TypeError and returns 500 instead of 400  
      *Fix:* Normalise the parsed body: `const raw = await req.json().catch(() => null); const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};` (or reuse readJsonBody from lib/require-user.mts).  
      <sub>Low · null-handling · A5-S26-8 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/eta-backtest.mts:348`** — Unbounded ?from/?to range: one Firestore listing per day until the function times out  
      *Fix:* Validate both dates with parseYmd and clamp the span (e.g. 60 days, reported as `clamped` in the response) before the loop.  
      <sub>Low · other · A5-S26-17</sub>
- [ ] **`dispatch-map/netlify/functions/eta-miss-ledger-background.mts:266`** — departureSamplesForDay drops stampSource that impliedDeparture reads  
      *Fix:* Add `stampSource: a ? a.source : null` to the entry built in departureSamplesForDay (or build both entry lists from one helper so the shape cannot drift).  
      <sub>Low · comment-mismatch · A5-S27-5 · reproduced by running the code</sub>

### W14.3 — low (10 items)

- [ ] **`dispatch-map/netlify/functions/eta-miss-ledger-background.mts:358`** — Catch comment says uncaptured day leaves no stamp; listStops returns [] so it is stamped  
      *Fix:* Correct the comment to say the catch covers Firestore errors only, and — if late captures should be retried — skip the stamp when listStops returns an empty array for a weekday.  
      <sub>Low · comment-mismatch · A5-S27-8 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/freight-class-report.mts:83`** — ?to=<non-date> without ?from throws RangeError outside the try → non-JSON 500  
      *Fix:* Validate `from`/`to` with /^\d{4}-\d{2}-\d{2}$/ up front and return a 400 JSON error, or move the date computation inside the existing try block.  
      <sub>Low · null-handling · A5-S27-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/attempts-store.mts:100`** — deleteAttemptItem doc says 'returns whether a row was present'; code returns true for a missing row  
      *Fix:* Read the item (getDoc) before deleteDoc and return deleted: existed && !survived; or reword the comment to say the flag means 'absent after the call'.  
      <sub>Low · comment-mismatch · A3-S14-13 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/attempts-store.mts:113`** — deleteAttemptItem reports deleted:true for a row that never existed, contrary to its comment  
      *Fix:* List (or getDoc) BEFORE the deleteDoc and set `deleted` from the pre-delete presence; keep the idempotent no-op behaviour but report `deleted:false` when nothing was there.  
      <sub>Low · comment-mismatch · A3-S14-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/auth-core.mts:83`** — 'password'/'dispatch' entries of the common-password list are unreachable dead branches  
      *Fix:* Match the common words as a prefix/substring (e.g. `low.startsWith(w)`) or drop the unreachable entries and add the ≥10-char variants actually worth refusing.  
      <sub>Low · logic · A3-S14-10 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/day-completion.mts:213`** — Comment promises per-order counts and a per-dock collapse the stop index cannot deliver  
      *Fix:* Either collapse the open list on a physical-visit key (matchKey / business+address) if one line per dock is the intent, or rewrite the comment to say rows are one per PRO (= stopNbr) and the collapse only guards against duplicate rows.  
      <sub>Low · comment-mismatch · A3-S15-8</sub>
- [ ] **`dispatch-map/netlify/functions/lib/day-completion.mts:367`** — reconcileDay bucket for a multi-row stop with mixed terminal outcomes depends on row order  
      *Fix:* Rank terminal outcomes deterministically (e.g. open > unable > cancelled > delivered, or unable beats delivered) when merging rows for one stop number, rather than first-wins.  
      <sub>Low · logic · A3-S15-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/refresh-stops-core.mts:936`** — Scan metric 'at' mixes the ET date with the UTC clock  
      *Fix:* Stamp `at` with an ET-formatted date+time (Intl en-CA with timeZone America/New_York, hour/minute) or store the plain ISO instant and label it as such.  
      <sub>Low · comment-mismatch · X-datetime-9 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/scan-schedule.mts:5`** — Comments state a */15 cron, weekend defaults 22/20 and a 35000 ceiling; code is */5, 23/19, 2000  
      *Fix:* Update the comments to */5, 23/19 and the 2,000 hard cap (or derive the defaults in the comments from the constants they sit next to).  
      <sub>Low · comment-mismatch · A5-S25-5</sub>
- [ ] **`dispatch-map/netlify/functions/lib/scan-schedule.mts:43`** — Weekend blackout comments say Fri 22 → Sun 20; code and tests are Fri 23 → Sun 19  
      *Fix:* Update the two comments to 23 / 19 (or reference WEEKEND_BLACKOUT_START_HOUR/END_HOUR instead of literal numbers).  
      <sub>Low · comment-mismatch · A5-S25-13</sub>

### W14.4 — low (6 items)

- [ ] **`dispatch-map/netlify/functions/lib/scan-schedule.mts:116`** — Day-band sanity check skips when only one edge is overridden, leaving a band that never matches  
      *Fix:* Evaluate the cross-field check against the effective pair: resolve start = out.dayBandStartHour ?? default(4) and end = out.dayBandEndHour ?? default(13) and delete whichever override(s) are present when start >= end.  
      <sub>Low · logic · A5-S25-3 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/sms-store.mts:38`** — Fallback SMS doc id has a random suffix, so the promised webhook retry de-dupe cannot happen  
      *Fix:* Either drop the random suffix (accepting that two distinct sends in the same millisecond to the same number collide, which the ms timestamp already makes near-impossible) or rewrite the comment to say the fallback is unique-per-call, not de-duplicating.  
      <sub>Low · comment-mismatch · A5-S25-6 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/uline-forecast.mts:110`** — ISO-looking date strings pass through forecastDateToIso without calendar validation  
      *Fix:* Validate the ISO branch the same way as M/D/Y: build Date.UTC(y, m-1, d) and return null when the round-trip changes month or day.  
      <sub>Low · logic · A5-S25-7 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/lib/uline-manifest.mts:182`** — ST column anchor has two different fallbacks (2900 vs 2960) in the same parser  
      *Fix:* Hoist one constant (e.g. const STATE_X_DEFAULT = 2960) and use it in both places.  
      <sub>Low · logic · A5-S25-8 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/manifest-ocr-background.mts:136`** — Chunk docs leak on an incomplete upload and for jobs that are never kicked  
      *Fix:* Delete the already-read parts in the incomplete-upload branch (or always run the deletion loop in a finally), and add a created_at-based sweep of stale manifest_pdf__ docs (e.g. in the OCR handler or a nightly job).  
      <sub>Low · other · A5-S27-12 · reproduced by running the code</sub>
- [ ] **`dispatch-map/netlify/functions/motive-driver-positions.mts:102`** — pagination.total of null coerces to 0 and stops the page walk after page 1  
      *Fix:* Guard the coercion: `const total = j?.pagination?.total; if (typeof total === 'number' && Number.isFinite(total) && out.length >= total) break;`.  
      <sub>Low · null-handling · A5-S27-7 · reproduced by running the code</sub>


---

## Not on this checklist

**195 reviewer claims that were never verified** (83 medium, 112 low). A reviewer reported each one, but the verifier run was cut short by an API limit and, at your direction, only the high and critical claims were re-checked. They are in the CSV with their confidence scores and in Appendix B of the review. Verify a batch before working it; roughly nine in ten survived verification elsewhere in this review, so most are probably real.

**4 findings that need a live fact to settle.** Each needs something the code cannot answer: a document shape in Firestore, a NuVizz response, or how Davis actually dispatches. They are listed in the review under "Uncertain findings".

**5 refuted reports.** Checked and found not to be bugs. Listed in the review's appendix so the coverage is auditable.

---

## Revision log

| Date | Who | What |
|---|---|---|
| 2026-09-03 | Claude (code review) | Created from the full review of `bb379fc`: 338 confirmed findings sorted into 14 workstreams. |
