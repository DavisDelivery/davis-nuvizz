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

| Var | Example |
|---|---|
| `NUVIZZ_DAVIS_COMPANY_CODE` | `Davis` |
| `NUVIZZ_DAVIS_USER` | `__REDACTED__` |
| `NUVIZZ_DAVIS_PASS` | `__REDACTED__` |
| `NUVIZZ_ULINE_COMPANY_CODE` | `Uline` |
| `NUVIZZ_ULINE_USER` | `__REDACTED__` |
| `NUVIZZ_ULINE_PASS` | `__REDACTED__` |

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
