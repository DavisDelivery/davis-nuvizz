# Delivery Attempts tracking

Track **who originally had a delivery** when it was attempted, even after the
order is unplanned and re-routed to a different driver.

## The problem

When a driver can't complete a delivery, Davis customer service prepends **`ATT`**
to the shipment number (e.g. stop `007137828` → shipment `ATT007137828`) and
**unplans** it. Later it gets re-planned onto a *different* driver. By the time you
look, NuVizz no longer shows who originally had it — the driver association is gone.

## The approach

Two scheduled jobs on the same ET day, joined by stop number:

```
08:30am ET   PLAN SNAPSHOT   freeze the routed plan: stopNbr → {driver, load, route, customer}
             (everything is planned/routed by 8:30, so every delivery has a driver)

08:00pm ET   ATTEMPT SCAN    re-probe each morning stop live; keep the ones whose
                             shipment number now starts with "ATT"; join each back to
                             its morning driver by stopNbr → the day's attempts list
```

The `ATT` marker lands on **`shipmentNbr`**, never on `stopNbr`, so the stop number
is a stable join key (`lib/nuvizz-scan.mts` `isAttemptShipment` is the one
authoritative test — the same rule as the portal's "Shipment Number Starts With att"
saved search). Each day is stored on its own, browsable by date — a history.

## Pieces

| File | Role |
|------|------|
| `dispatch-map/netlify/functions/lib/nuvizz-scan.mts` | Surfaces `shipmentNbr` + `isAttempt` on every normalized stop. |
| `dispatch-map/netlify/functions/lib/attempts-core.mts` | Schedule gate, plan capture, attempt scan + join (pure builders unit-tested). |
| `dispatch-map/netlify/functions/lib/attempts-store.mts` | Firestore paths for `att_plan` + `attempts`. |
| `dispatch-map/netlify/functions/nuvizz-att-plan-snapshot-background.mts` | Cron `30 12,13 * * *` → 8:30am ET plan freeze. |
| `dispatch-map/netlify/functions/nuvizz-att-scan-background.mts` | Cron `0 0,1 * * *` → 8pm ET attempt scan + join. |
| `dispatch-map/netlify/functions/nuvizz-attempts.mts` | CORS read endpoint for the scorecard. |
| `docs/scorecard-attempts/` | Drop-in scorecard card + integration guide. |

## Firestore layout

```
att_plan/{tenant}__{YYYY-MM-DD}                 ← snapshot meta
att_plan/{tenant}__{YYYY-MM-DD}/stops/{stopNbr} ← morning plan: stopNbr → driver/load/route
attempts/{tenant}__{YYYY-MM-DD}                 ← attempts manifest (counts)
attempts/{tenant}__{YYYY-MM-DD}/items/{stopNbr} ← one detected attempt, joined to morning driver
```

## DST / scheduling

Crons fire on fixed UTC instants; all date/hour logic uses the America/New_York
clock. Each job fires **two** UTC candidates (one for EDT, one for EST) and a
once-per-day ET-hour gate (`attemptFireDecision`) lets exactly one act year-round.
A dropped first candidate is covered by the second (it still sees the day
not-yet-done). The 8pm scan fires at 00:00–01:00 UTC — the *next* UTC date but the
*same* ET day — so the target date is `etDayString()`, not `todayUTC()`.

## Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `NUVIZZ_ATT_ENABLED` | enabled | Master kill switch (only the literal `false` disables). |
| `NUVIZZ_ATT_PROBE_CONCURRENCY` | `8` | Parallel `/stop/info` re-probes in the evening scan. |
| `FIREBASE_SA` | — | Required (shared with the rest of the dispatch app) to read/write Firestore. |

Both jobs honor the shared NuVizz call counter / circuit breaker and the
`NUVIZZ_SCANS_ENABLED` kill switch (the re-probe rides `lookupStopByPro`).

## Manual / backfill

Cron fires only on published deploys. Trigger by hand (bypasses the time gate):

```
POST /.netlify/functions/nuvizz-att-plan-snapshot-background?date=YYYY-MM-DD
POST /.netlify/functions/nuvizz-att-scan-background?date=YYYY-MM-DD   # needs that day's snapshot first
GET  /.netlify/functions/nuvizz-attempts?date=YYYY-MM-DD
```

### Once `AUTH_REQUIRED=true` is set, the two POSTs need an admin session

Passing `?date=` puts these on the **override** branch, which is gated at **admin**
(`lib/background-gate.mts` → `gateScheduledOverride`). The cron path — which sends no
query string at all — is untouched and needs nothing.

```
curl -X POST -H "Authorization: Bearer $DISPATCH_SESSION" \
  "https://<site>/.netlify/functions/nuvizz-att-plan-snapshot-background?date=YYYY-MM-DD"
```

**READ THE 202 AS "RECEIVED", NEVER AS "DONE".** These are `*-background` functions:
Netlify answers the caller `202 Accepted` the instant the request lands and then throws
the handler's real response away, so a refused override looks *exactly* like an accepted
one from curl. Confirm it actually ran:

- `GET /.netlify/functions/nuvizz-scan-config?explain=1` → `backgroundRefusals` lists every
  refused background job, newest first, with the reason. Empty means nothing was refused.
- Then re-read the day (`nuvizz-attempts?date=…`) and check the manifest counts moved.

Skipping that check is how a re-freeze silently does nothing and the evening scan is then
run against a snapshot that was never written — a second wrong answer, with no error
anywhere.

## Known limitation (v1)

The candidate set is the morning snapshot, so an order that was created *and*
attempted the same day (after the 8:30 freeze) won't be matched. Davis plans
everything by 8:30am, so this is rare; the manifest reports `unmatched`/`unprobed`
counts so any gap is visible rather than silent.
