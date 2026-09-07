// nuvizz-window-check.mts — "Check vs NuVizz": ONE live list call for the grid's current
// window and filters, diffed against the rows the grid is showing.
//
// Chad, Sep 7, after the Workbench (525) and the Routing window (550) disagreed and the
// reconciliation took eleven vendor calls and an afternoon: "a way to do what we just did —
// check what we are showing to what nuvizz shows for the same set of filters." This is the
// button behind that. The client posts the filter it is on and the rows it is showing; this
// pulls NuVizz's answer for the same filter and reports three lists — shown here but not in
// NuVizz's list, in NuVizz's list but not shown here, on both but planned/load/day differ —
// plus the four header numbers for each side. The pure diff lives in lib/window-check.mts.
//
//   POST { fromDate, toDate }        a calendar range (the grid's Custom / Last-N-days window)
//   POST { arrivalPeriod: '0d' }     a NuVizz period preset
//        + statusCodes?: string[]    clamped to open work (10/20/40/50); none → all four
//        + shown: ShownRow[]         what the grid is showing: stopNbr, status, day, routeName,
//                                    weight, cartons, volume, businessName, city
//
// COST: exactly one metered NuVizz call per request, attributed on-demand. Throttled per
// instance so a stuck finger cannot turn a diagnostic into a spend. Gated at dispatcher.
// Writes nothing anywhere.

import { setCallTrigger } from './lib/nuvizz-request.mts';
import { requireUser, readJsonBody, jsonResponse, throttled } from './lib/require-user.mts';
import { checkCodes, diffWindow, pullLiveWindow, ACTIVE_CODES } from './lib/window-check.mts';

const MAX_SHOWN_ROWS = 6000;

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST only' }, 405, cors);
  // Gate BEFORE the body is read: the one branch below spends a metered NuVizz call.
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;
  if (throttled('window-check', 6, 60_000)) {
    return jsonResponse({ ok: false, error: 'Checked too often — wait a minute. Each check is one NuVizz call.' }, 429, cors);
  }
  // 550 rows of nine short fields is ~80 KB; the default 64 KB body cap would refuse a normal window.
  const parsed = await readJsonBody(req, 2 * 1024 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body || {};

  const isDay = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const range = (isDay(body.fromDate) && isDay(body.toDate))
    ? (body.fromDate <= body.toDate ? { from: body.fromDate, to: body.toDate } : { from: body.toDate, to: body.fromDate })
    : null;
  const period = !range && typeof body.arrivalPeriod === 'string' ? body.arrivalPeriod : null;
  if (!range && !period) return jsonResponse({ ok: false, error: 'give fromDate+toDate or arrivalPeriod' }, 400, cors);
  const codes = checkCodes(body.statusCodes);
  const shownIn: any[] = Array.isArray(body.shown) ? body.shown.slice(0, MAX_SHOWN_ROWS) : [];
  // Only open work is compared (see lib/window-check.mts): rows on screen outside the checked
  // statuses — delivered history in an unfiltered window — are set aside and reported as such.
  const shown = shownIn.filter((s) => s && s.stopNbr != null && codes.includes(String(s.status ?? '').trim()));
  const ignoredShown = shownIn.length - shown.length;

  setCallTrigger('on-demand'); // a dispatcher pressed Check vs NuVizz → on-demand
  const TIMEOUT_MS = Math.min(24_000, Math.max(1_000, Number(process.env.NUVIZZ_EXPLORER_TIMEOUT_MS) || 22_000));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const live = await pullLiveWindow({ range, period }, codes, ac.signal);
    const diff = diffWindow(shown, live.rows, { all: live.allRows });
    return jsonResponse({
      ok: true,
      at: new Date().toISOString(),
      calls: 1,
      filter: { range: live.range, period: live.period, covered: live.covered, statusCodes: codes, compared: ACTIVE_CODES.filter((c) => codes.includes(c)) },
      partial: live.partial,
      ignoredShown,
      ...diff,
      // Board-shaped rows for "Use NuVizz's list for this window": the client joins its own
      // cached coordinates by stop number; a row the cache never saw lists without a pin.
      liveRows: live.rows,
    }, 200, cors);
  } catch (e: any) {
    const aborted = ac.signal.aborted || e?.name === 'AbortError';
    return jsonResponse({ ok: false, error: aborted ? 'NuVizz timed out — the date window may be too large. Try a narrower range.' : (e?.message || 'check failed') }, aborted ? 504 : 502, cors);
  } finally {
    clearTimeout(timer);
  }
};
