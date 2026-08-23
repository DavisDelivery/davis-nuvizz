# Davis NuVizz Mobile v0.2

Mobile-first dispatch dashboard for Davis Delivery over the nuVizz REST API v7. Dual-tenant (Davis carrier view + Uline shipper view).

## Screens

- **Home (Dashboard)** — today's KPIs, day-progress bar, exceptions feed, active loads list
- **Map** — Leaflet map of every stop today, color-coded by status, route lines per driver (distinct color), tap-pin → slide-up detail panel
- **Loads** — full list of today's loads, search + filter by status, progress bars, driver/miles/start
- **Stops** — every stop today, search by PRO/customer/address, filter by status / driver / customer
- **Drivers** — leaderboard ranked by completed stops + on-time %, top-driver hero card, tap loads to open
- **Load detail** — full load info, stats grid, origin, sequenced stops list
- **Stop detail** — address + map links, contact, schedule, timing (planned/actual/dwell), freight counts, load ref, exceptions, event timeline

## KPIs on the Dashboard

- Total stops + % complete
- Total loads + active count
- Total miles (planned or actual)
- Average dwell time
- Bucketed stop counts (complete / active / pending / failed)

## Architecture

```
 iPhone
    │
    ▼
 React SPA (Vite, ~1,988 LOC, single-bundle 61KB gzipped)
    │
    │  /.netlify/functions/nuvizz?tenant=davis&path=__today
    ▼
 Netlify Function (nuvizz.js)
    │  1. Basic Auth → JWT via /auth/token/{companyCode}
    │  2. Token cached per tenant until expiresAt
    │  3. Special aggregator paths:
    │       __today      → every stop today + their loads + summary KPIs
    │       __daterange  → any range
    │       __health     → auth sanity check
    │  4. Passthrough: any real nuVizz path
    ▼
 https://contact-support.nuvizz.com/deliverit/openapi/v7
```

**The aggregator is the big unlock.** `__today` fires one call to `/stop/info/customer/{cc}?fromDTTM=...&toDTTM=...` (returns every stop for today), then in parallel (concurrency 5) fetches the load detail for every unique loadNbr found. Result: one HTTP roundtrip from the browser, full day's data.

## Environment variables (Netlify)

**Values live in Netlify, never in this repo.** Set them under
*Site configuration → Environment variables*, on **each** site that needs them.

The canonical, documented inventory is [`dispatch-map/.env.example`](dispatch-map/.env.example),
which separates browser-visible `VITE_*` vars from server-only ones and explains what
each does. This file deliberately does **not** reproduce it — a table of variable names
beside a value column is a fill-in-the-blank invitation, and that is precisely how real
NuVizz and Motive credentials came to be committed here in May 2026. They were redacted
in June (`aef1ca2`), but redacting the working tree does not remove them from the commit
that introduced them, and the only thing that ever makes a leaked credential safe is
**rotating it at the vendor**.

The NuVizz credential set this app needs is described in `.env.example`. Two notes that
have bitten before:

- **`NUVIZZ_DAVIS_*` is read by BOTH Netlify sites** — the parent app
  (`netlify/functions/nuvizz.cjs`) and dispatch-map
  (`dispatch-map/netlify/functions/lib/nuvizz-scan.mts`). Rotate the password and update
  only one site, and the other site's scans start failing.
- Netlify's **secret scanning** greps every file in the repo for the *values* of this
  site's env vars and fails the deploy on a hit. Never paste a real value into any file
  here, including a doc or a test fixture — see `dispatch-map/test/no-lifelike-addresses.test.mjs`.

## Deploy

```bash
cd davis-nuvizz
npm install
npm run build      # Vite production build
netlify deploy --prod
```

Or push to GitHub (`DavisDelivery/davis-nuvizz`) and connect Netlify for CI/CD.

## First boot

On load, the app hits `__health` which tests auth against both tenants. Top banner turns red with the exact error if credentials are wrong. Green = everything wired correctly.

## File map

```
davis-nuvizz/
├── index.html
├── netlify.toml
├── package.json
├── vite.config.js, tailwind.config.js, postcss.config.js
├── netlify/
│   └── functions/
│       └── nuvizz.js              (238 lines — proxy + aggregator)
└── src/
    ├── main.jsx, index.css
    ├── App.jsx                    (main shell, bottom nav, routing)
    ├── lib/
    │   ├── api.js                 (API client)
    │   └── normalize.js           (raw nuVizz → UI shapes)
    ├── components/
    │   └── UI.jsx                 (shared: pills, KPIs, progress, etc.)
    └── screens/
        ├── Dashboard.jsx
        ├── MapScreen.jsx          (Leaflet, loaded from CDN)
        ├── LoadsScreen.jsx
        ├── StopsScreen.jsx
        ├── DriversScreen.jsx
        ├── LoadDetail.jsx
        └── StopDetail.jsx
```

## What's different from v0.1

| v0.1 (the junky one) | v0.2 |
|---|---|
| 3 screens, load lookup by number only | 7 screens including dashboard + map + full-day lists |
| No KPIs | 6 KPIs + day-progress bar |
| No map | Full Leaflet map with route lines + filters |
| "Paste a load number" to see anything | Everything for today loads automatically |
| No exception surfacing | Dedicated exceptions feed on home |
| No driver performance view | Ranked leaderboard with on-time % |
| Customer search only | Search every stop by PRO/customer/city/driver |
| Single 749-line file | 11 modular files, 1,988 lines |

## Next (ask when ready)

- **Actions from detail screens** — close/approve/cancel stop, add note, reassign driver
- **Historical date range** — pick yesterday / last week
- **Uline billing xlsx upload** — drop the weekly audit file, auto-reconcile against the NuVizz data
- **Motive GPS overlay on map** — live truck positions
- **Push/iPhone add-to-home** — PWA manifest + service worker
