# load-scan

Driver-facing load verification scanner for Davis Delivery. A driver signs in on
their phone at the dock, sees the load NuVizz assigned them today, and scans each
piece of freight as it goes on the truck. The app says in real time whether the
right freight is on the right truck, and refuses to let a load close quietly with
a piece missing.

Deploys to the **ddsloadout** Netlify site (`https://ddsloadout.netlify.app`,
site id `1cca4f6e-39d8-49e4-86a5-2beae0161023`), base directory `load-scan`.

## Hard rules

- **Zero NuVizz calls, ever.** There is no NuVizz client code in this subtree by
  design. Everything comes from the pre-built Firestore stop index that
  dispatch-map's scan already populates.
- **Offline first.** The dock has no signal. Every scan is written to IndexedDB
  before any network attempt; the UI never waits on a request.
- **Never guess a load.** If a driver's identity cannot be resolved to exactly one
  credential, the app says so and asks for the load number off the paperwork.

## The label

A Uline label carries two barcodes:

| position | symbology | content | role |
| --- | --- | --- | --- |
| bottom, marked PRO | Code 39 | bare 7-digit PRO, e.g. `7152411` | which stop |
| upper, under "N of M" | Code 128 | `OG` + 10 digits, e.g. `OG6028479182` | which **piece** |

The OG is unique per physical piece and is the deduplication key. NuVizz does not
store it. The "2 of 3" index is printed as text only — it is in neither barcode,
so it cannot be used for completeness. Completeness is distinct OG count against
`expectedPieces`.

## Field semantics

NuVizz mislabels every freight count. Translation happens once, in
`netlify/functions/lib/manifest.mts`, and the NuVizz names never appear
downstream:

| NuVizz | index key | actually is | emitted as |
| --- | --- | --- | --- |
| `totalPallets` | `pallets` | total pieces | `expectedPieces` |
| `totalCartons` | `cartons` | skids | `skids` |
| `volume` | `volume` | loose pieces | `loose` |

Note that dispatch-map's header sums `cartons` and labels it "total pallets" on
screen. That number is skids. `expectedPieces` here will legitimately differ from
it — do not "fix" this side to match.

### The piece-count identity (measured, not assumed)

`totalPallets` (total pieces) is exactly `totalCartons + volume` (skids +
loose). Measured Aug 4 2026 across **337 live stops on 20 drivers**: 328
carried a piece total and **every one matched the sum — zero disagreements**.
The remaining 9 sent no total at all; all were Averitt orders on the Inbound
Integration feed, which is why a missing total is computed from the parts
rather than treated as zero.

### What the NuVizz order screen shows (verified on a live Averitt stop)

NuVizz's own order screen carries the same mislabel: it displays `totalCartons`
under the heading **"Pallets"**. So both NuVizz's UI and dispatch-map's header
will disagree with `expectedPieces` here, and both are wrong about what they are
counting. Do not reconcile toward either screen.

Averitt freight arrives on the **Inbound Integration** feed, not Uline's, and
those orders send **no piece total at all** — `totalPallets` is absent, so
`expectedPieces` is computed from skids + loose and `countIsEstimated` is set.
The flag means "computed here", not "uncertain".

**Never sum the order's item lines.** A real one-pallet Averitt order (ZNShine
solar panels, residential with liftgate) shows **Items(4)** on the order screen:
three of the four lines are accessorials — residential delivery, liftgate, fuel
surcharge — each with quantity 1 and confirmation type "Pieces". Summing item
lines gives 4 pieces for one physical pallet. Charge lines are not freight.

## Environment

| var | required | purpose |
| --- | --- | --- |
| `FIREBASE_SA` | yes | service-account JSON; without it no endpoint can read the stop index |
| `LOADSCAN_JWT_SECRET` | yes | at least 32 chars, signs session tokens. Rotating it signs everyone out. |
| `LOADSCAN_ADMIN_PROXY_SECRET` | yes | at least 16 chars, set on **both** ddsloadout and dd-dispatch-map. Proves an admin call came from dispatch-map's server. |
| `LOADSCAN_ADMIN_BOOTSTRAP_SECRET` | temporary | at least 16 chars. Lets one request create the first dispatcher credential. **Already used and removed — set it again only to create another first dispatcher.** |
| `FIRESTORE_DATABASE` | no | named database; unset = `(default)` |

`FIREBASE_SA` is defined **twice**: site-scoped on dd-dispatch-map and site-scoped
here. Team-level was considered and rejected — Netlify shared variables reach every
site in the team (24 of them, several unrelated to Davis dispatch) and cannot be
limited to a subset. A rotation therefore has to be applied in both places.

## Endpoints

Every endpoint requires a bearer token. There is no `Access-Control-Allow-Origin`
header anywhere: the app is same-origin with its functions, so none is needed.

| endpoint | who | what |
| --- | --- | --- |
| `POST /driver-login` | anyone | driver number + PIN to a 90-day token. 5 failures locks 15 min. |
| `POST /driver-change-pin` | driver | 4-6 digits, must differ from current |
| `GET /load-manifest` | driver | token to alias set to today's stops, filtered server side |
| `POST /scan-session` | driver | idempotent upsert on `(loadNbr, og)` |
| `GET/POST /driver-admin` | dispatcher | credentials, PINs, lockouts, alias editing, review queue |
| `GET /driver-alias-report` | dispatcher | distinct `driverUserName` values for hand-mapping |
| `GET /health` | anyone | routing check, no data |

## Driver identity — seeding the alias sets

`driver_auth/{driverNumber}.nuvizzAliases` is authoritative and hand-maintained
through the Dock scanner drivers panel in dispatch-map.

Measured over the 22 dispatch days to Jul 29, 2026: the stop index carries **64
distinct driver values, every one a full name present in both the `driverName` and
`driverUserName` columns**. No bare short code (`VINCENT`, `BRAD`) appears anywhere.
So `DAVIS_DRIVERS.userName` in dispatch-map's `nuvizz-driver-route.mts` is not a
usable alias value — only the full-name column matches a real stop. Seed from the
alias report, then add the short code as a second alias only if it ever shows up.

## First-run setup

```bash
# 1. create the first dispatcher (needs LOADSCAN_ADMIN_BOOTSTRAP_SECRET set)
curl -X POST https://ddsloadout.netlify.app/.netlify/functions/driver-admin \
  -H 'content-type: application/json' \
  -H 'x-bootstrap-secret: <LOADSCAN_ADMIN_BOOTSTRAP_SECRET>' \
  -d '{"action":"bootstrap-dispatcher","driverNumber":"1","displayName":"Dispatch","pin":"482913"}'

# 2. unset LOADSCAN_ADMIN_BOOTSTRAP_SECRET

# 3. sign in as that dispatcher, pull the alias report, and hand-map each
#    distinct driverUserName to a driver number in the Drivers panel.
```

## Local

```bash
npm install
npm run dev      # vite dev server
npm test         # pure-logic suite (node --test)
npm run build    # -> dist/
```

## Layout

```text
src/lib/scan-logic.js    barcode classification, frame pairing, match outcomes, completeness
src/lib/scanner.js       dual-engine capture: BarcodeDetector, Quagga2 fallback
src/lib/offline.js       IndexedDB scan queue + manifest cache
src/lib/session.js       token storage, offline expiry check
netlify/functions/lib/   firestore client, auth, alias resolution, field translation
```
