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
 * not have and the copy would arrive with a 12–5 default. The two must say the same thing —
 * so this is the seeder's rule exactly: both ends in the contract's yyyy-MM-ddTHH:mm:ss shape,
 * and opening BEFORE closing. An inverted "18:30–17:00 strict" is dropped by the seeder too.
 */
export function windowLabel(r) {
  const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) ? v.slice(0, 19) : null);
  const a = iso(r?.scheduledFrom);
  const b = iso(r?.scheduledTo);
  if (a && b && a < b) return `${a.slice(11, 16)}–${b.slice(11, 16)}${String(r?.timeConstraint || '').toUpperCase() === 'STRICT' ? ' strict' : ''}`;
  return 'no window';
}

/**
 * PURE. The one-line result of a Seed, from what the server actually sent.
 *
 * `failed` arrives as the LIST of refused orders (netlify/functions/uat-seed.mts), so the count
 * is its length. Read as a number, an empty list is truthy and prints as nothing — every clean
 * seed said "Seeded 3,  failed" — and one refusal printed "[object Object] failed". The board's
 * size is stated only when the server read it: a refused seed read no board.
 */
export function seedHeadline(result) {
  const r = result && typeof result === 'object' ? result : {};
  const nFailed = Array.isArray(r.failed) ? r.failed.length : 0;
  const board = typeof r.boardRows === 'number' && Number.isFinite(r.boardRows) ? ` · board now holds ${r.boardRows}` : '';
  return `Seeded ${r.seeded ?? 0}${nFailed ? `, ${nFailed} failed` : ''} · ${r.callsUsed ?? 0} UAT call(s)${board}`;
}

/**
 * PURE. Is this production row freight still waiting for a route? The SERVER'S rule, word for
 * word (prod-catalogue.mts, unplannedTotal), so the "un-planned only" list is the rows the count
 * counts. A cancelled or unable-to-deliver order with no route is written isPlanned:false AND
 * isUnplanned:false (lib/nuvizz-list.mts: "neither planned nor unplanned: it is done"), and
 * `!isPlanned` alone called it plannable — the bug that once put PRO 007151447-2 on a truck.
 */
export function isUnplannedRow(r) {
  return r?.isUnplanned === true || (r?.isPlanned === false && r?.isUnplanned !== false);
}

/** PURE. What the "In production" cell says about a row that is not on a load: "un-planned" for
 *  open freight, otherwise the order's own status ("cancelled", "exception", …). */
export function notPlannedLabel(r) {
  if (isUnplannedRow(r)) return 'un-planned';
  return String(r?.normalizedStatus ?? '').trim().toLowerCase() || 'not open';
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
