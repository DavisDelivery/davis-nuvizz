# Dispatch Map — Handoff

Status of the build that landed on branch `claude/dispatch-map-build-eEbYe`.
Pick this up when you start M3 + M5.

## TL;DR

- M1 (read-only map) and M2 (metadata + edit UI) are fully wired.
- M4 (Motive overlay) is implemented and toggleable.
- M3 (Diagnostics) is a page shell with TODO comments — nothing actually runs yet.
- M5 (Route polylines) is not implemented; spec at the bottom of this doc.
- The app builds (`npm run build` green) and both Netlify Functions bundle clean
  via esbuild. End-to-end live testing against NuVizz still needs the env
  credentials and a Netlify dev session.

## Repo layout decision (READ ME)

The brief asked me to create a new `DavisDelivery/dispatch-map` repo. My GitHub
MCP scope in this session was restricted to `davisdelivery/davis-nuvizz`
**only**, so I could not create a separate repo. Instead I scaffolded the
entire app as a self-contained `/dispatch-map/` subdirectory inside this repo
on branch `claude/dispatch-map-build-eEbYe`.

**To promote it to its own repo:**

```bash
# Option A — git subtree split (preserves history of the subdir only):
git subtree split --prefix=dispatch-map -b dispatch-map-extract
# then push that branch to the new empty DavisDelivery/dispatch-map repo as main

# Option B — copy + fresh-init (simpler, drops history):
cp -r dispatch-map /tmp/dispatch-map
cd /tmp/dispatch-map && git init && git add . && git commit -m "initial scaffold"
git remote add origin git@github.com:DavisDelivery/dispatch-map.git
git push -u origin main
```

Either way, point Netlify (`dd-dispatch-map.netlify.app`) at the new repo with
publish dir `dist`, functions dir `netlify/functions`, and the env vars listed
below.

## What's built — M1

`src/App.jsx` → `<MapScreen/>`

- Login gate (`<LoginGate/>`) wraps the whole app. Email/password sign-in via
  Firebase Auth. Until the user resolves, nothing renders.
- `useStops()` hits `/.netlify/functions/nuvizz-pull-today-stops` on mount and
  on the manual refresh button. The function:
  - Calls NuVizz `/stop/info/customer/{DAVIS}?fromDTTM=...&toDTTM=...` (today
    UTC by default) via HTTP Basic auth — same pattern as davis-nuvizz's
    `netlify/functions/nuvizz.cjs`.
  - Falls back to `test/fixtures/nuvizz-today-stops.json` if `NUVIZZ_DAVIS_USER`
    isn't set OR `?mock=1` is on the URL. This is how the UI works without
    creds.
  - Returns a normalized shape — PRO (9-digit zero-padded), business name,
    addr1/2, city, state, zip, lat/lng, scheduled window, items summary,
    driver name. **Raw NuVizz payload is preserved on `.raw`** per the
    "preserve raw at every layer" rule.
- Map centered on Buford GA (33.9719, -84.0008), zoom 10.
- `MarkerClusterer` from `@googlemaps/markerclusterer` v2 — handles 750+ markers
  without lag.
- Click a marker → right sidebar (`<StopSidebar/>`) shows PRO, business name,
  full address, **raw addr2 in its own amber-highlighted block** (so the
  dispatcher can see "what's already in the dumping ground"), items, window,
  load + driver.
- Manual refresh button in the top-right map overlay with `last-refreshed` ago
  timestamp + source label ("NuVizz" vs "MOCK DATA").

## What's built — M2

- `src/lib/firebase.js` — initializes Firebase Auth + Firestore from
  `VITE_FIREBASE_*` env. Gracefully no-ops if not configured (login screen
  shows a config warning instead of crashing).
- `src/lib/matchKey.js` — `normalizeMatchKey(name, addr1, city, zip)` per the
  spec in the brief (suffix stripping, street-type abbreviation, underscore
  collapse). Same algorithm runs client-side and (would run) server-side if we
  ever need batch matching server-side.
- `useCustomerNotes()` subscribes to the full `customer_notes` collection live
  via `onSnapshot`. Cheap — ~hundreds of docs max — and means dispatcher edits
  show up instantly across tabs.
- When a stop is clicked the sidebar looks up `notes.get(stop.matchKey)`. If
  present → read-only summary + Edit button. If absent → form is pre-filled
  with `emptyNote(stop)` and "save" creates the doc.
- All schema fields editable:
  - `priority_flag` (red/yellow/green/none)
  - `receiving_hours` (per-day text inputs)
  - `appointment_required` + `appointment_notes`
  - `equipment_restrictions` (multi-select chips: `no_tractor_trailer`,
    `26ft_max`, `no_53ft`, `box_truck_only`, `no_overhead_clearance`)
  - `liftgate_required`
  - `dock_type` (radio: dock_high / ground / either / unknown)
  - `dock_notes`
  - `contacts[]` (name / phone / role rows, add/remove)
- `photo_urls` is in the schema and gets written through, but there's no upload
  UI yet — needs Firebase Storage wiring. Field is intentionally left empty
  until M3 or whenever you wire up Storage.
- **Marker color logic** (`flagColor()`):
  - `priority_flag === 'red'` → `#dc2626`
  - `'yellow'` → `#eab308`
  - `'green'` → `#16a34a`
  - any restriction/liftgate/appointment but no priority → `#7c3aed` purple
  - no note at all → brand blue `#1e5b92`
- **Filter rail** (left side, `<FilterPanel/>`): priority flag chips,
  appointment-required, liftgate, has-any-restriction, unflagged-only,
  equipment-restriction dropdown. Reset button. Filtered count shown.
- **pro_history**: appended on every save (idempotent — only adds if the
  last entry isn't already today's PRO). Max 20, FIFO. Displayed as compact
  chips at the bottom of the sidebar.
- **Sortable mini-table** below the filter rail shows the currently-visible
  stops sortable by Flag / Customer / City / PRO via the `useSortable` hook +
  `<SortableTh/>` component — per the standing dev rule.

## What's built — M2.1 (auto-scanner)

Passive scanner that watches each stop's NuVizz signals and auto-populates
`customer_notes.equipment_restrictions` when known patterns appear. v1 covers
the `no_tractor_trailer` flag only; the pattern table is hardcoded and easy to
extend.

### Where SPL-INSTR-TEXT lives in the NuVizz response

Confirmed by inspecting the live `/load/info/{loadNbr}/{companyCode}` response
(the same payload that `nuvizz-pull-today-stops.mts` already pulls — no second
endpoint needed). Each stop carries:

```
Load.stops[].stop.comments[]   // array of comment objects
```

Each comment with `cmtType === 'ORD_IN'` is an order instruction. Its
`commentDescription` field is prefixed `"SPL-INSTR-TEXT: ..."`. The function
joins all such comments by `\n` and surfaces them as
`signalSources.orderInstructions` on the normalized stop payload.

Sample (real, today): 1,994 comments across 713 stops, 1,280 of which are
`SPL-INSTR-TEXT:` prefixed.

### Performance — zero extra NuVizz calls

The original spec assumed we might need a per-PRO fetch. We do not. The
existing `/load/info/` response already contains `stop.comments[]` inline, so
the scanner runs entirely against data we were already fetching. Map load time
is unchanged.

### Signal sources scanned

```
signalSources.addressLine2      // raw addr2 string — DAVIS-curated, trusted
signalSources.orderInstructions // joined SPL-INSTR-TEXT comments — ULINE, advisory
```

Both raw, both nullable. Per the standing rule we preserve raw — the scanner
reads these, doesn't mutate them.

### Source-locked flags (v0.3.0)

The two sources have different confidence levels, so they map to different
flags. Same physical icon (truck-with-slash) but different color:

| Source | Flag | Marker | Trust |
|---|---|---|---|
| `addressLine2` | `no_tractor_trailer` | red truck-slash pin | Davis dispatcher curated |
| `orderInstructions` | `uline_straight_truck` | amber truck-slash pin | Uline-supplied, verify |

Source-locked, not text-locked: the same phrase (e.g. "STRAIGHT TRUCK ONLY")
can appear in either field, but the trust level is determined by *who wrote
it*, not what they wrote.

### Pattern rules

Hardcoded in [`src/lib/signal-scanner.ts`](src/lib/signal-scanner.ts).
Two separate lists, one per source (`ADDR2_PATTERNS`, `ORDER_INSTR_PATTERNS`).
v0.3.0 covers Davis "NO TRACTOR TRL / NO TT / STRAIGHT TRUCK ONLY / 26FT MAX /
NO 53" phrasings, and Uline's standard SPL-INSTR wording.

To extend: append to the appropriate `*_PATTERNS` array (or add a new source
entry under `SOURCE_RULES`). When the rule set grows past ~5 flags, move to a
Firestore `scanner_config` doc.

### Legacy migration

v0.2.0 wrote `no_tractor_trailer` for *any* hit, including SPL-INSTR-TEXT.
The v0.3.0 writer auto-migrates those docs: if `auto_sources.no_tractor_trailer`
contains only `'orderInstructions'` and `manual_overrides.equipment_restrictions`
is false, the writer swaps `no_tractor_trailer` → `uline_straight_truck` on
the next scan. Manual overrides are always respected.

### Writer behavior

[`src/lib/customer-notes-writer.ts`](src/lib/customer-notes-writer.ts) walks
scan results, groups by `match_key` (so two stops at the same customer merge
into one write), and chunks writes into Firestore batches of 450. Each write
is a `setDoc(..., {merge: true})` so we never clobber human fields.

Schema additions on `customer_notes`:

| Field | Type | Purpose |
|---|---|---|
| `manual_overrides.equipment_restrictions` | `boolean` | Dispatcher locked this field against the auto-scanner |
| `auto_sources` | `{ [flag]: ('addressLine2' \| 'orderInstructions')[] }` | Which sources detected each flag |
| `auto_matches` | `{ [flag]: { source, text, pattern }[] }` | Exact substring + pattern that hit |
| `auto_detected_at` | `Timestamp` | Last auto-scan write |
| `auto_detected_by` | `string` | `'auto-scanner v0.2.0'` |

`equipment_restrictions` uses `arrayUnion` so the auto-scanner adds the flag
without clobbering anything else the dispatcher has set on that array.

### Manual-override mechanism

The auto-scanner respects two signals:

1. **`manual_overrides.equipment_restrictions === true`** — set explicitly by
   the "Override auto-detection" button in the sidebar. While true, the scanner
   updates `auto_*` audit fields but never touches `equipment_restrictions`.
2. **Implicit override on save** — `handleSave()` in `App.jsx` compares the
   draft `equipment_restrictions` against the existing doc as sets. If they
   differ (added, removed, or replaced), the flag flips to `true` automatically.

The override never disables the audit trail, so dispatchers can always see
"the scanner would have detected X" via the Detection Source section.

### UI disclosure

The sidebar has a "Detection source" section (above the existing Customer
Notes block). For every flag currently set OR currently detected, it shows:

- The flag label (e.g. "No tractor trailer")
- A small badge — `Auto-detected`, `Manually set`, `Auto + manual`, or
  `Override · auto also detected`
- The matched text strings indented under the source label

When auto detections exist and `manual_overrides.equipment_restrictions` is
false, an "Override auto-detection" button is shown that flips the flag.

### Marker rendering

Three tiers (highest confidence wins):

| Variant | When | Pin | zIndex |
|---|---|---|---|
| Davis no-TT | `equipment_restrictions` includes `no_tractor_trailer` OR live scan hit | red truck-slash | 600 |
| Uline advisory | `equipment_restrictions` includes `uline_straight_truck` OR live scan hit | amber truck-slash | 500 |
| Default | otherwise | standard colored pin via `flagColor()` | — |

The first-paint "live scan" path means a stop's marker takes the right color
immediately, before the Firestore round-trip. Once the write lands the
doc-driven path keeps it in place.

### General notes field

Schema field `general_notes: string` on customer_notes. Free-form textarea in
the sidebar Edit form (above Contacts). Persists per `match_key` like every
other field — recurs automatically on future stops at the same customer.
Designed for "anything that recurs" — gate codes, security desk procedures,
specific contacts to call, weird parking instructions, etc.

The existing structured fields (`receiving_hours`, `contacts[]`,
`appointment_notes`, `dock_notes`) cover the common cases; `general_notes` is
the catch-all when the recurring info doesn't fit a structured slot.

### Satellite toggle

`<MapScreen/>` carries a `satelliteMode` state and renders a toggle button
just below the top-right status pill. ON → `google.maps.MapTypeId.HYBRID`
(satellite imagery + road labels), OFF → `ROADMAP`. Hybrid keeps road labels
so the dispatcher stays oriented while visually verifying Uline straight-truck
advisories against actual site geometry (truck courts, gate sizes, etc.).

### Detection Source label semantics

v0.3.0 only shows "Manually set" / "Override · auto also detected" when
`manual_overrides.equipment_restrictions === true`. Without that flag, a value
in `equipment_restrictions` is assumed to be the auto-scanner's write
(because the scanner is also a writer). The earlier "Auto + manual" badge was
ambiguous and is gone.

## What's built — M4

- `<MapScreen/>` has a "Show live drivers" toggle in the left rail.
- `useDriverPositions(enabled)` polls `/.netlify/functions/motive-driver-positions`
  every 60s while the toggle is on; clears the interval cleanly on toggle-off
  or unmount.
- Driver markers are rendered as 40×40 dark-truck icons (`truckSvg()`), NOT
  added to the cluster (separate layer, `zIndex: 1000` so they sit on top of
  stop pins).
- `motive-driver-positions.mts` calls `GET /v1/vehicle_locations` with
  `X-API-KEY` header. Returns `{ drivers: [{ vehicleNumber, driverName, lat,
  lng, speedMph, heading, locatedAt, address }] }`.

**Motive API caveat I didn't get to verify:** I used the documented
`/vehicle_locations` endpoint and assumed the standard `{ vehicles: [{
vehicle, current_location, current_driver }] }` response shape based on
public Motive docs. **If Davis's Motive account uses a different endpoint
(some accounts use `/users/{id}/locations` or `/fleet/locations`), the
function will return zero drivers.** Test against your account and adjust the
parse in `motive-driver-positions.mts` if needed.

## What's stubbed — M3

`<DiagnosticsScreen/>` in `App.jsx` has three `<Panel/>` sections, each with a
`Placeholder` that just shows a count. The TODO comments explain exactly what
each one should do:

- **M3-A "Unmatched Stops Today"** — `stops` where `notes.get(stop.matchKey)`
  is undefined. Sortable table + "Create notes" button that should open the
  sidebar editor (needs lifting selectedStop state up to App level, or
  switching to a global store).
- **M3-B "Stale Customers (90+ days)"** — `notes` where `last_updated` is older
  than 90 days. Tricky bit: these customers may not be on today's map, so the
  editor needs a "free-floating" mode that doesn't depend on a selected stop.
- **M3-C "Address Line 2 Migration"** — group today's stops by `addr2`,
  surface unique values, "Promote to Notes" per-customer to convert
  free-form addr2 into structured fields (regex heuristics: `/liftgate/i` →
  `liftgate_required: true`, `/26ft|no.*tractor/i` → push into
  `equipment_restrictions`, `/appt|appointment/i` → `appointment_required: true`).

## Environment variables

### Client (Vite — must be prefixed `VITE_`)

| Var | Where it comes from |
|---|---|
| `VITE_FIREBASE_API_KEY` | davismarginiq Firebase console → Project settings |
| `VITE_FIREBASE_AUTH_DOMAIN` | `davismarginiq.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | `davismarginiq` |
| `VITE_FIREBASE_STORAGE_BUCKET` | `davismarginiq.appspot.com` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | davismarginiq console |
| `VITE_FIREBASE_APP_ID` | davismarginiq console (create a new "Dispatch Map" web app there) |
| `VITE_GOOGLE_MAPS_API_KEY` | new key in GCP, restrict by HTTP referrer to `*.davisdelivery.com/*` and `dd-dispatch-map.netlify.app/*` |
| `VITE_USE_MOCK_NUVIZZ` | optional, `true` to force fixture |

### Server (Netlify Functions only — NEVER prefix `VITE_`)

| Var | Value / source |
|---|---|
| `NUVIZZ_DAVIS_USER` | same as davis-nuvizz project |
| `NUVIZZ_DAVIS_PASS` | same as davis-nuvizz project |
| `NUVIZZ_DAVIS_COMPANY_CODE` | `DAVIS` |
| `NUVIZZ_BASE_URL` | `https://portal.nuvizz.com/deliverit/openapi/v7` |
| `MOTIVE_API_KEY` | `2eb96247-8869-4f47-8062-6964c1dc77a8` (per brief) |
| `MOTIVE_BASE_URL` | optional, `https://api.gomotive.com/v1` |

`.env.example` in the repo lists all of these with the right shape.

## Firestore — required setup

Create the `customer_notes` collection in the `davismarginiq` project (no
manual schema — Firestore is schemaless; first `setDoc` makes it). Doc IDs are
the match key.

You also need **Firestore rules** allowing authenticated users to read/write
`customer_notes`. The existing rules in davismarginiq likely cover this with a
catch-all `request.auth != null` rule; verify before going live or add:

```
match /customer_notes/{key} {
  allow read, write: if request.auth != null;
}
```

## NuVizz API integration notes

- The function uses **HTTP Basic auth** directly against
  `https://portal.nuvizz.com/deliverit/openapi/v7` — no JWT exchange. This
  matches the pattern in `davis-nuvizz/netlify/functions/nuvizz.cjs` (line ~64
  `basicAuthHeader`).
- The endpoint `/stop/info/customer/{companyCode}?fromDTTM=...&toDTTM=...` with
  no customer filter returns every stop in the window — confirmed working in
  davis-nuvizz's `__today` aggregator (see `fetchLoadsAndStopsForRange`,
  same file).
- I did NOT replicate the load-info fan-out that the existing davis-nuvizz
  aggregator does (`parallelMap` over `loadNbrs`). For the dispatch map all we
  need is the stop record itself — load detail is shown only as `loadNbr` +
  `driverName` from the stop's `.load` sub-object. If you need richer load
  data (vehicle type, total miles, etc.) in the sidebar, copy
  `fetchLoadsAndStopsForRange` from nuvizz.cjs.
- **Latitude/longitude:** I trust the `address.latitude` / `address.longitude`
  fields on each stop. If those are null for any customer the marker is
  silently dropped. M3 diagnostics should surface these as "unmappable stops".
- The function **falls back to the bundled fixture** if `NUVIZZ_DAVIS_USER` is
  unset, which means the app appears to "work" in environments without creds.
  Watch the source label on the top-right status pill — "MOCK DATA" means the
  fallback fired.

## Known issues / open questions for Chad

1. **Marker `google.maps.Marker` is deprecated** in favor of
   `AdvancedMarkerElement`. I used the classic Marker because Advanced requires
   a `mapId` (Map ID configured in GCP). Working as-is — Google still serves
   them — but you may want to migrate when M5 routes ship.
2. **Photo upload not built.** `photo_urls` writes through but no upload UI.
   Needs Firebase Storage rules + a `<PhotoUploader/>` component. Probably an
   M3 task.
3. **No undo on Firestore writes.** Save is immediate and replaces the doc.
   If you fat-finger a field there's no history view. Consider a
   `customer_notes_history` subcollection on each save in a later pass.
4. **Diagnostics duplicates the data fetch.** `<DiagnosticsRoute/>` calls
   `useStops` and `useCustomerNotes` independently of `<MapScreen/>`, so
   switching tabs re-fetches. Promote to a context (or top-level state in
   `<Shell/>`) when M3 starts doing real work.
5. **No date picker.** The brief only asks for "today" so the function defaults
   to today UTC. Add `?date=YYYY-MM-DD` to the function URL to view another
   day (the function supports it; UI doesn't expose it).
6. **Match-key collisions:** the algorithm collapses both "St" and "Street" to
   `st` but doesn't distinguish "1234 Main St" from "1234 Main St Suite 4"
   well — `Suite 4` becomes `ste_4`. Two units of the same building share a
   match key. Probably correct (same customer, different suite = same notes?)
   but flag it as you encounter cases.
7. **Address parsing is NuVizz's job.** If a customer types the same address
   in two different formats across two PROs, the match keys diverge. M3-C
   migration UI should expose this so the dispatcher can manually merge.

## Testing locally

```bash
cd dispatch-map
npm install
cp .env.example .env
# Fill in at least VITE_FIREBASE_* and VITE_GOOGLE_MAPS_API_KEY
npx netlify dev    # starts vite + the functions on http://localhost:8888
```

If `NUVIZZ_DAVIS_USER` isn't set the function falls back to the fixture and
you'll see the 10 sample stops around metro Atlanta. Once you set real creds
in `.env`, refresh — should pull live data.

End-to-end smoke test once live:

1. Sign in with a Firebase Auth user from davismarginiq.
2. Map loads, ~750 markers cluster across north Georgia.
3. Click a marker → sidebar opens, addr2 highlighted in amber.
4. Click Edit → fill in a flag + a restriction → Save → marker color
   changes immediately (Firestore live subscribe).
5. Refresh the page → edit persists.
6. Toggle "Show live drivers" → truck icons appear (if Motive API call works
   against the account — see caveat above).

## M5 — next session

Spec from the brief:

> Once NuVizz Route Workbench finalizes routes, pull route assignments per
> driver, draw polylines connecting stops in route order, color by driver.

Suggested approach:

1. New function `nuvizz-pull-routes.mts` that fetches `/load/info/{loadNbr}`
   for every active load today (use davis-nuvizz's `__fleet` scan pattern
   from `nuvizz.cjs` line 333 `scanFleet` — probes the load-number range
   parallel x20).
2. Build a per-driver map: `{ driverUserName: [stopNbr, ...] }` ordered by
   `stopSeq`.
3. On the map, draw a `google.maps.Polyline` per driver connecting stops in
   sequence. Color from a fixed palette keyed off `driverUserName` (steal
   the `DAVIS_DRIVERS` list from `davis-nuvizz/src/lib/api.js` for the
   roster).
4. UI: filter rail toggle "Show routes" + a per-driver legend with
   show/hide checkboxes.
5. Performance: 35 drivers × ~20 stops = 700 polyline segments. Should be
   fine — polylines are cheap. If lag appears, batch into one Polyline per
   driver with all path points in one array (Google handles that natively).

The cluster layer should NOT cluster polylines — they're a separate map
overlay, just like the M4 driver markers.

## File map

```
dispatch-map/
├── README.md
├── HANDOFF.md                                    ← you are here
├── .env.example
├── netlify.toml
├── package.json, vite.config.js, tailwind.config.js, postcss.config.js
├── index.html
├── public/
├── src/
│   ├── main.jsx
│   ├── index.css
│   ├── App.jsx                                   ← single-file React app
│   └── lib/
│       ├── firebase.js                           ← Firebase Auth + Firestore init
│       └── matchKey.js                           ← normalizeMatchKey()
├── netlify/
│   └── functions/
│       ├── nuvizz-pull-today-stops.mts           ← M1 data source
│       └── motive-driver-positions.mts           ← M4 live drivers
└── test/
    └── fixtures/
        └── nuvizz-today-stops.json               ← 10-stop mock around metro Atlanta
```
