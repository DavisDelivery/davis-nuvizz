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

## Load order is the REVERSE of delivery order

A trailer unloads from the doors forward, so the last stop delivered has to go on
first, at the nose. Each stop carries a `loadSeq`: **1 = first onto the trailer =
nose = the last stop delivered.**

`loadSeq` is the reverse rank of the delivery sequence (`loadStopSeq ?? routeSeq`
— measured Aug 4 2026, `loadStopSeq` is never populated on live loads, so this is
`routeSeq` running 1..N with no nulls). Using the same key as the delivery sort
means the two orders are exact inverses and cannot drift apart:
`loadSeq + routeSeq === N + 1` at every position, which is asserted in the tests.

**The server array stays in delivery order.** `loadSeq` is a field that gets
stamped on, never a re-sort — every other consumer of the manifest reads delivery
order and must keep getting it. Only the loading screen sorts by `loadSeq`.

### Co-located stops share a position

One address can carry several orders, arriving as separate stops with the same
sequence number. Measured Aug 4 2026: BEN 1 has one shared pair; DENIS SALKIC has
17 stops across 15 sequence numbers. They come off the trailer at one place, so
they go on at one place — stops sharing a delivery sequence get the **same**
`loadSeq` and stay adjacent.

So `loadSeq` ranks *distinct sequence values*, not stops: Denis's load is
`loadSeq` 1..15, not 1..17.

### On screen

Every row shows both numbers — "Load 1 of 13 · Delivery stop 13" — so nobody has
to do the arithmetic on a dock at 5am. The ends are labelled physically, because
a loader thinks in trailer positions, not integers: the first group reads
**"nose of the trailer"** and the last reads **"at the doors"**.

### The resequence guard

A loaded trailer is a physical record of *one* route order. If dispatch
resequences after loading has started, the freight is already in the wrong place
and re-drawing the screen with new numbers would hide exactly that.

So the sequence in force when the **first piece** is recorded is written down
(`stampLoadedSequence`) and never overwritten. On every refresh the current
`sequenceFingerprint` is compared against it. If they differ, the screen **keeps
showing the order the truck was loaded against** and raises a loud banner instead
of silently renumbering. The session doc carries `loadedAgainstSequence` (first
write wins) and a `sequenceChanged` flag, so the record shows it too.

The fingerprint is order-insensitive — a harmless re-sort of the array is not an
alarm; only a stop's sequence actually changing, or a stop appearing/disappearing,
is.

## Averitt freight is NOT scannable — confirmed from the pallet

Photographed on the dock, Aug 2026. An Averitt skid carries **Averitt's own
label, never a Uline label**. It has three barcodes and none of them fit the
scanner:

| field on the label | value seen | why it fails |
| --- | --- | --- |
| `PRO#` | `0259185096` | 10 bare digits; `isProBarcode` needs exactly 7 |
| `SHIPMENT#` | `5010437803` | 10 bare digits |
| `HU` (handling unit) | `1076461290` | 10 bare digits — the per-pallet piece ID |

There is no `OG`-prefixed barcode, so `pairFrame` can never complete a piece.
Every value classifies as `unknown` and is dropped. The load sits short and
will not close.

**Do not "just widen the PRO regex".** The three barcodes are indistinguishable
by format — all bare 10 digits. Accept 7–10 and scanning the SHIPMENT# yields
PRO `0437803`, which matches no stop, so the driver gets a RED *wrong freight*
on freight that is correct. A false red at 5am is worse than no scan.

Averitt *does* carry the two things the app needs — a shipment ID and a
per-pallet HU — so this freight could be made properly scannable later. That
needs to know what the barcodes actually **encode** (symbology, and any prefix
not shown in the human-readable text), which takes a physical scan of one
label. A photograph cannot settle it.

The matching delivery receipt reads `TOTAL HANDLING UNITS: 2` / `TOTAL PIECES: 2`
for a 2-skid shipment, consistent with HU being one-per-piece here.

### Hand-confirm

A stop the app cannot scan is marked `scannable: false` and gets a hand-confirm
path instead:

- **Two-step by construction.** The confirm button does not exist until "No
  barcode we can read" is tapped, and it re-arms on every render. One stray tap
  cannot book freight onto a truck.
- **Only where it is needed.** Offered only on a `scannable: false` stop that is
  still short — never as an alternative to scanning readable freight.
- **Counts, but is never mistaken for a scan.** Hand-confirms are stored in
  their own `handConfirms` list on the session doc, keyed and de-duplicated by
  stop, with `scannedPieces` and `confirmedPieces` recorded separately. They
  never become an OG.
- **Covers the remainder only**, so a partly scanned stop cannot double count.
- **Offline first**, on the same queue as scans, with the same flush and retry.

The trigger derives from `countIsEstimated` (the stop sent no piece total),
which on live data is exactly the Averitt / Inbound Integration set — 9 of 337
stops, measured Aug 4 2026. That is a correlation, not a law: setting
`scannable` on the index row overrides it in both directions, without a deploy.

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
| `GET/POST /driver-admin` | dispatcher | credentials, PINs, lockouts, alias editing, roles, review queue |
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

After first run, more dispatchers are made from inside the app: a dispatcher
can promote any credential with `set-role` ("make dispatcher" in the Drivers
panel) and demote it back. The last active dispatcher can never be demoted or
deactivated — with the bootstrap secret used and removed, zero dispatchers
would be unrecoverable. Promote a second dispatcher **before** you need one.

## Local

```bash
npm install
npm run dev      # vite dev server
npm test         # pure-logic suite (node --test)
npm run build    # -> dist/
```

## Roles

Three roles. The only thing that differs is **whose load am I looking at** —
piece matching, duplicate catching, counts and the offline queue are identical,
because they work on a load, not on a person.

| role | sees |
| --- | --- |
| `driver` | their own load, resolved from the hand-seeded alias set |
| `loader` | the day's loads as a pick list; chooses the truck they are working |
| `dispatcher` | the credential admin surface |

Set with `set-role` from the Drivers panel. The role is read from the **live
credential doc** on every request, not from the 90-day token, so a change takes
effect on the next call rather than at token expiry.

### Loader mode

A forklift operator loads somebody else's truck — **one truck start to finish,
several per shift** (confirmed with Chad). So the pick is once per truck, not
once per scan:

1. Sign in as themselves. The identity path never runs for a loader — they have
   no aliases, and running it would file an unmatched-alias review row on every
   sign-in.
2. `load-manifest` returns the day's loads as **summaries only** (`summariesOnly:
   true`): load number, driver name, route, stop count, piece count. No stops —
   a phone must never receive all ~600.
3. Picking a truck fetches that load through the existing `?loadNbr=` override.
   No second path was invented for this.
4. Closing the load offers **Next truck**, which re-reads the pick list.

The header shows whose truck it is, because a dock identifies a trailer by its
driver, not by its load number.

## Hardware scanners (keyboard wedge)

The Zebra MC3400 and a DS3678-ER paired to a tablet both deliver barcodes as
**keystrokes ending in Enter** (Tab also accepted), not camera frames. "Use
scanner gun" on the scan screen focuses a hidden input that accumulates the
burst and commits on the suffix; the committed string feeds the exact same
classify → pair → `evaluateScan` path as the camera. Configure the gun for
keystroke output with an Enter suffix (DataWedge default).

The verdict is audible, because nobody reads a screen forty times a truck at
5am with gloves on:

| verdict | sound | screen |
| --- | --- | --- |
| good piece | short high beep | green full-screen flash, clears itself |
| wrong freight | harsh double buzz | red screen, **stays until tapped** |
| duplicate | flat low tone | "already scanned", clears itself |
| appointment stop | two quick high beeps | amber flash, clears itself |

The two label barcodes arrive as two trigger pulls, so the gun pair window is
8s (vs 1.5–5s for camera frames). A lone half-scan still expires before the
operator reaches the next pallet.

## Layout

```text
src/lib/scan-logic.js    barcode classification, frame pairing, match outcomes, completeness
src/lib/scanner.js       dual-engine capture: BarcodeDetector, Quagga2 fallback
src/lib/wedge.js         keyboard-wedge capture for hardware scanner guns
src/lib/feedback.js      WebAudio verdict sounds for gun mode
src/lib/offline.js       IndexedDB scan queue + manifest cache
src/lib/session.js       token storage, offline expiry check
netlify/functions/lib/   firestore client, auth, alias resolution, field translation
```
