// src/lib/uat-bench-view.js — what the UAT bench screen SAYS about an order (PURE).
//
// Pure core, thin edges: every judgement the bench screen makes about a production row —
// whether it has a usable window, whether it matches what you typed, what its one-line
// summary reads — is a function here with a test, and components/UatBench.jsx only renders
// what these return. (It also has to be a .js module rather than living in the .jsx: node's
// test runner cannot import JSX, so a helper written inside the component is a helper nobody
// can test.)

/** The maximum the bench seeds at a time. Mirrors MAX_SEED in netlify/functions/uat-seed.mts —
 *  the server is the authority, and a test asserts the two agree. A screen that offered more
 *  than the server takes would send a batch refused whole after the user had picked it. */
export const BENCH_MAX = 25;

/** PURE. The one line under each order: where it goes and what it is. */
export function rowSubtitle(r) {
  const where = [r?.city, r?.state].filter(Boolean).join(', ');
  const freight = r?.itemsSummary && r.itemsSummary !== '—' ? r.itemsSummary : null;
  return [r?.addr1, where, freight].filter(Boolean).join(' · ');
}

/**
 * PURE. The delivery window as a dispatcher reads it, or the honest absence.
 *
 * HALF A WINDOW READS AS NONE, and that agrees with the seeder on purpose (lib/uat-seed.mts):
 * a row with an opening and no close carries an estimated ARRIVAL, not a window, and the
 * seeder drops it rather than pairing it with the builder's default. If this screen showed
 * "18:30–" as though it were a deadline, you would tick an order to test a deadline it does
 * not have and the copy would arrive with a 12–5 default. The two must say the same thing.
 */
export function windowLabel(r) {
  const t = (v) => (typeof v === 'string' && v.length >= 16 ? v.slice(11, 16) : null);
  const a = t(r?.scheduledFrom);
  const b = t(r?.scheduledTo);
  if (a && b) return `${a}–${b}${String(r?.timeConstraint || '').toUpperCase() === 'STRICT' ? ' strict' : ''}`;
  return 'no window';
}

/** PURE. Free-text match over the fields a dispatcher would actually type. An empty query
 *  shows everything rather than nothing — a filter that hides the list when you clear it is
 *  a filter people stop using. */
export function matchesQuery(r, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return !!r && typeof r === 'object';
  if (!r || typeof r !== 'object') return false;
  return [r.stopNbr, r.businessName, r.addr1, r.city, r.zip, r.routeName]
    .some((v) => String(v ?? '').toLowerCase().includes(needle));
}

/** PURE. Today, on the board's clock (ET) rather than the browser's — a dispatcher in another
 *  timezone must not open the bench on a different day than the board is showing. */
export function benchToday(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
