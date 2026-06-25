# Scorecard "Attempts" card

Drop-in React card for the driver scorecard
(`davis-driver-scorecard.netlify.app`), to render **right below "Mis
Deliveries."** It shows, per day, who had each delivery the morning it was
attempted — recovered from the routed-plan snapshot even after the order is
unplanned in NuVizz and no longer shows a driver.

> The scorecard is a **separate repo** from this one (`davis-nuvizz` is the
> dispatch app that produces the data). This folder is the canonical copy of the
> component; copy `AttemptsCard.jsx` into the scorecard repo to use it.

## 1. Install

Copy `AttemptsCard.jsx` into the scorecard's components directory. It needs only
React (icons are inline SVG; styling is plain Tailwind utility classes).

## 2. Place it below Mis Deliveries

```jsx
import AttemptsCard from './components/AttemptsCard';

// …inside the scorecard page, immediately after the Mis Deliveries section:
<MisDeliveries /* …existing… */ />

<AttemptsCard />                                  // whole-fleet, today (ET)
// or, on a single-driver scorecard, filter + share the page's date:
<AttemptsCard date={selectedDate} driver={driverUserName} />
```

## 3. Props

| Prop      | Default                              | Purpose                                                            |
|-----------|--------------------------------------|--------------------------------------------------------------------|
| `apiBase` | `https://dd-dispatch-map.netlify.app`| Base URL of the dispatch app serving the feed.                     |
| `date`    | today (ET)                           | `YYYY-MM-DD`. Pass to share the scorecard's date picker; omit to use the card's own. |
| `driver`  | —                                    | Filter to one driver (userName or name substring).                 |

## 4. The feed it reads

```
GET {apiBase}/.netlify/functions/nuvizz-attempts?date=YYYY-MM-DD[&driver=NAME]
→ { ok, date, generated, manifest, count, attempts: [
     { stopNbr, shipmentNbr, originalDriverName, originalDriverUserName,
       originalLoadNbr, routeName, businessName, city, state, zip,
       currentStatus, currentlyUnplanned, matched, detectedAt } ] }
```

CORS is open (`Access-Control-Allow-Origin: *`) and the endpoint reads Firestore
only (no NuVizz traffic), so it returns in well under a second. Browse history by
changing `date`.
