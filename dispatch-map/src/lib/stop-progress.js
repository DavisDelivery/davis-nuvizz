// STOPS COMPLETED, FOR FOLLOWING THE DAY FROM A PHONE.
//
// Chad: "on the mobile version of the app, I want a stops completed percentage. Like the
// number of stops, the number of stops completed, and then the percentage that's done …
// Don't include any stops that are on a [Chad] route or a Uline appointment route. As it
// will skew the numbers."
//
// WHICH ROUTES ARE LEFT OUT is isSetAsideRoute — the one predicate the flag engine and the
// nightly day report (day-completion.mts, via isExcludedRoute) already share: CHAD, matched
// on the whole name so CHADWICK and CHATTANOOGA still count, and any APPT / APPOINTMENT
// route (ULINE APPT). A second copy of that list here is how two screens come to disagree.
//
// PLANNED ONLY, as the day report does: an unplanned stop is on nobody's truck today, so
// counting it as "not done yet" would hold the percentage down with work nobody is running.
// "Unplanned" means exactly what the phone's own stop badge says it means, so the card and
// the list under it cannot disagree about which stops those are.
//
// PER BOARD ROW, like the "Showing N of M stops" line beside it and like the report — a
// customer with three orders is three rows and three completions.
//
// `statusOf` is passed in — classifyStopStatus in App.jsx, the function that paints the
// badges — so DELIVERED and UNPLANNED here are the badges' words; this module stays pure.
import { isSetAsideRoute } from './board-flags.js';

const str = (v) => String(v ?? '').trim();

export function computeStopProgress(stops, { statusOf }) {
  let total = 0;
  let completed = 0;
  let setAside = 0;
  for (const s of stops || []) {
    const status = statusOf(s);
    if (status === 'UNPLANNED') continue;
    const route = str(s?.loadNbr || s?.routeName);
    if (isSetAsideRoute(route) || isSetAsideRoute(s?.routeName)) { setAside += 1; continue; }
    total += 1;
    if (status === 'DELIVERED') completed += 1;
  }
  if (!total) return null;
  return { total, completed, setAside, pct: Math.round((completed / total) * 100) };
}
