// backtest-map-core.js — THE RULES OF THE CLAUDE-vs-DISPATCH MAP, pure and tested.
//
// Chad, 2026-09-25: "I want an interactive map to see Claude's vs my own dispatch." The map draws one
// backtested day twice — the loads dispatch ran, in the order they were driven, and the loads Claude
// planned, in the order the engine sequences them — from the stops STORED with that backtest (see
// backtestMapPayload in lib/claude-shadow/backtest-core.mts), so it can only show what was measured.
//
// COLOUR FOLLOWS THE TRUCK, AND ONLY A FEW AT A TIME. Sixty-odd trucks cannot each have a colour a
// person can tell apart, and a palette that repeats reads as two trucks being one. So every truck is
// drawn in a muted grey, and the ones you pick take the eight validated categorical colours in a
// fixed order — the same colour on both maps, so one driver can be followed from dispatch's plan to
// Claude's. A ninth pick is refused with a note rather than repainting a truck you are looking at.

export const SELECT_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
export const MAX_SELECTED = SELECT_COLORS.length;
export const MUTED = '#7b8190';
export const PLAN_LABEL = { driven: 'Dispatch — as driven', claude: 'Claude' };
// How a dispatch truck's line got its order, when it was NOT the delivery stamps.
export const ORDER_WORD = { planned: 'planned order', 'stop number': 'stop-number order' };

/** Stop id → Claude's reason, for the stops Claude left unplanned. */
export function unplannedOf(m) {
  return new Map((m?.unplanned || []).map((u) => [Number(u.id), String(u.reason || '')]));
}

/**
 * The dispatch trucks whose line is NOT the order they were delivered in (no delivery times, so the
 * planned order or stop numbers stood in), as one sentence — or null when every line is as driven.
 */
export function orderNote(m) {
  const odd = (m?.loads || []).filter((l) => l.orderSource && l.orderSource !== 'driven').sort(byRoute);
  if (!odd.length) return null;
  const words = [...new Set(odd.map((l) => ORDER_WORD[l.orderSource] || l.orderSource))].join(' or ');
  const one = odd.length === 1;
  return `${odd.length} dispatch truck${one ? '' : 's'} had no delivery times, so ${one ? 'its' : 'their'} line follows the ${words}, not the order delivered: ${odd.map((l) => l.route).join(', ')}.`;
}

const byRoute = (a, b) => String(a.route).localeCompare(String(b.route)) || String(a.id).localeCompare(String(b.id));

/** Stop id → { loadId, seq (1-based), of } for one plan. */
export function whereIs(m, plan) {
  const out = new Map();
  for (const [loadId, ids] of Object.entries(m?.plans?.[plan] || {})) {
    ids.forEach((id, i) => out.set(Number(id), { loadId, seq: i + 1, of: ids.length }));
  }
  return out;
}

/** The trucks a plan uses, with what each carries, in route-name order. */
export function planLoads(m, plan) {
  const stops = new Map((m?.stops || []).map((s) => [s.id, s]));
  const orders = m?.plans?.[plan] || {};
  return (m?.loads || []).map((l) => {
    const ids = orders[l.id] || [];
    let spots = 0, lbs = 0;
    for (const id of ids) { const s = stops.get(Number(id)); spots += Number(s?.spots) || 0; lbs += Number(s?.lbs) || 0; }
    return { ...l, stops: ids.length, spots: Math.round(spots * 10) / 10, lbs: Math.round(lbs) };
  }).sort(byRoute);
}

/** Every truck with its stop count under both plans — the list you pick trucks from. */
export function truckRows(m) {
  const d = new Map(planLoads(m, 'driven').map((l) => [l.id, l]));
  const c = new Map(planLoads(m, 'claude').map((l) => [l.id, l]));
  return (m?.loads || []).map((l) => ({
    id: l.id, route: l.route, driver: l.driver, cls: l.cls, orderSource: l.orderSource || 'driven',
    driven: d.get(l.id)?.stops || 0, claude: c.get(l.id)?.stops || 0,
  })).sort(byRoute);
}

/**
 * What one stop did under each plan. Dispatch's side says how its order was known (orderSource);
 * Claude's side is { unplanned: true, reason } for a stop Claude left off every truck.
 */
export function stopStory(m, stopId) {
  const id = Number(stopId);
  const stop = (m?.stops || []).find((s) => s.id === id) || null;
  if (!stop) return null;
  const loads = new Map((m?.loads || []).map((l) => [l.id, l]));
  const side = (plan) => {
    const w = whereIs(m, plan).get(id);
    if (!w) return null;
    const l = loads.get(w.loadId);
    return { loadId: w.loadId, route: l?.route ?? w.loadId, driver: l?.driver ?? '', cls: l?.cls ?? null, orderSource: l?.orderSource || 'driven', seq: w.seq, of: w.of };
  };
  const driven = side('driven');
  const un = unplannedOf(m);
  const claude = side('claude') || (un.has(id) ? { unplanned: true, reason: un.get(id) } : null);
  return { stop, driven, claude, sameTruck: !!driven?.loadId && driven.loadId === claude?.loadId };
}

/**
 * Every stop at the tapped stop's exact point — one customer's several orders sit on one spot, and
 * a tap reaches only the top marker, so the card must list them all (a split is the thing to see).
 * The tapped stop comes first, then the rest by stop number.
 */
export function storiesAt(m, stopId) {
  const id = Number(stopId);
  const tapped = (m?.stops || []).find((s) => s.id === id);
  if (!tapped) return [];
  const here = (m.stops || []).filter((s) => s.id !== id && s.lat === tapped.lat && s.lng === tapped.lng)
    .sort((a, b) => String(a.n).localeCompare(String(b.n)));
  return [tapped, ...here].map((s) => stopStory(m, s.id)).filter(Boolean);
}

/**
 * Toggle a truck in the selection (loadId → colour slot). A truck keeps its slot while picked; a new
 * pick takes the lowest free slot. Returns { next, refused }.
 */
export function toggleTruck(sel, loadId) {
  const next = new Map(sel);
  if (next.has(loadId)) { next.delete(loadId); return { next, refused: false }; }
  if (next.size >= MAX_SELECTED) return { next: sel, refused: true };
  const used = new Set(next.values());
  let slot = 0;
  while (used.has(slot)) slot++;
  next.set(loadId, slot);
  return { next, refused: false };
}

/** Pick several trucks at once (a stop's two trucks), keeping any already picked. */
export function pickTrucks(sel, loadIds) {
  let next = sel, refused = false;
  for (const id of loadIds) {
    if (!id || next.has(id)) continue;
    const r = toggleTruck(next, id);
    next = r.next;
    refused = refused || r.refused;
  }
  return { next, refused };
}

const stopLabel = (s) => `${s.name || s.n} · ${s.city || ''}`.replace(/ · $/, '').trim();

/**
 * One plan as GeoJSON for Google's Data layer: per truck a white casing and its route (Buford, then
 * its stops in order), every stop as a point titled with ITS TRUCK (colour alone never names one),
 * and the terminal. On Claude's plan, a stop Claude left unplanned is still drawn — kind
 * 'unplanned', with the reason — so the day's freight never silently thins out. [lng, lat].
 */
export function planGeo(m, plan) {
  const stops = new Map((m?.stops || []).map((s) => [s.id, s]));
  const loads = new Map((m?.loads || []).map((l) => [l.id, l]));
  const depot = m?.depot;
  const features = [];
  for (const [loadId, ids] of Object.entries(m?.plans?.[plan] || {})) {
    const pts = ids.map((id) => stops.get(Number(id))).filter(Boolean);
    if (!pts.length) continue;
    const l = loads.get(loadId);
    const odd = plan === 'driven' && l?.orderSource && l.orderSource !== 'driven' ? `, ${ORDER_WORD[l.orderSource] || l.orderSource}` : '';
    const line = [...(depot ? [[depot.lng, depot.lat]] : []), ...pts.map((s) => [s.lng, s.lat])];
    if (line.length > 1) {
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { kind: 'casing', loadId } });
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { kind: 'route', loadId } });
    }
    pts.forEach((s, i) => features.push({
      type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: {
        kind: 'stop', loadId, stopId: s.id, seq: i + 1, label: stopLabel(s),
        title: `${stopLabel(s)} — ${l?.route ?? loadId}${l?.driver ? ` (${l.driver})` : ''}, stop ${i + 1} of ${pts.length}${odd}`,
      },
    }));
  }
  if (plan === 'claude') {
    for (const [id, reason] of unplannedOf(m)) {
      const s = stops.get(id);
      if (!s) continue;
      features.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: { kind: 'unplanned', stopId: s.id, label: stopLabel(s), title: `${stopLabel(s)} — left unplanned by Claude${reason ? `: ${reason}` : ''}` },
      });
    }
  }
  if (depot) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [depot.lng, depot.lat] }, properties: { kind: 'depot' } });
  return { type: 'FeatureCollection', features };
}

/** The box that holds every stop and the terminal. */
export function boundsOf(m) {
  const pts = [...(m?.stops || []), ...(m?.depot ? [m.depot] : [])].filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  if (!pts.length) return null;
  return {
    north: Math.max(...pts.map((p) => p.lat)), south: Math.min(...pts.map((p) => p.lat)),
    east: Math.max(...pts.map((p) => p.lng)), west: Math.min(...pts.map((p) => p.lng)),
  };
}

// ── ROUTE BY ROUTE (v1.73.0) ────────────────────────────────────────────────────────────────────────
//
// Chad, 2026-09-25: "a way to pull up one route and see the differences on a route by route basis.
// And I need to see the routes, the stop counts on them, the skid counts on them, the weights, the
// loose pieces, everything." One ROUTE is one truck of the day (route + driver), and Claude planned
// the SAME trucks — so dispatch's version and Claude's version of a route are the same load id.
//
// Everything here reads what the backtest STORED: the per-plan orders and the per-route numbers the
// scorecard itself measured (m.loads[].cols). Freight is summed from the stored stops. Nothing is
// re-measured or guessed; where the data cannot say something (clock times, receiving windows) the
// screen says so instead of inventing it.

/** Share of a limit at which a route is called NEAR it — stated on screen, not hidden. */
export const NEAR = 0.95;

const byIdOf = (m) => new Map((m?.stops || []).map((s) => [s.id, s]));
const loadRef = (loads, id) => {
  const l = loads.get(id);
  return l ? { loadId: l.id, route: l.route, driver: l.driver } : { loadId: id, route: id, driver: '' };
};

/**
 * The freight on a list of stop ids: orders (one stop number each), addresses (distinct customer
 * locations — the physical stops a driver makes), skids, loose pieces, skid spots and weight, as
 * recorded. `noCount` counts orders stored with 0 skids AND 0 loose — "not recorded" and "zero"
 * look the same in the stored day, so the screen says how many there are rather than hide it.
 */
export function freightOf(m, ids) {
  const byId = byIdOf(m);
  const addr = new Set();
  let skids = 0, loose = 0, spots = 0, lbs = 0, noCount = 0, orders = 0;
  for (const id of ids || []) {
    const s = byId.get(Number(id));
    if (!s) continue;
    orders++;
    addr.add(s.k || `@${s.lat},${s.lng}`);
    skids += Number(s.skids) || 0;
    loose += Number(s.loose) || 0;
    spots += Number(s.spots) || 0;
    lbs += Number(s.lbs) || 0;
    if (!(Number(s.skids) > 0) && !(Number(s.loose) > 0)) noCount++;
  }
  return { orders, addresses: addr.size, skids: Math.round(skids * 10) / 10, loose: Math.round(loose), spots: Math.round(spots * 10) / 10, lbs: Math.round(lbs), noCount };
}

/** Customer locations (k) that ride on more than one truck in a plan: k → [loadId, …]. */
export function customerSplits(m, plan) {
  const byId = byIdOf(m);
  const on = new Map();
  for (const [loadId, ids] of Object.entries(m?.plans?.[plan] || {})) {
    for (const id of ids) {
      const k = byId.get(Number(id))?.k;
      if (!k) continue;
      if (!on.has(k)) on.set(k, new Set());
      on.get(k).add(loadId);
    }
  }
  const out = new Map();
  for (const [k, set] of on) if (set.size > 1) out.set(k, [...set].sort());
  return out;
}

/**
 * One route, both ways. For dispatch's version and Claude's: the stops in order with their freight,
 * the leg from the previous stop and the ELAPSED time since leaving Buford (drive + the on-site
 * minutes of the stops before it — not a clock time: the backtest has no start time). What Claude
 * kept, what it put on (and whose truck each came off), what it took off (and where each went, or
 * that it was left unplanned), the trucks it traded with, the stored numbers per plan, and flags.
 */
export function routeCompare(m, loadId) {
  const loads = new Map((m?.loads || []).map((l) => [l.id, l]));
  const L = loads.get(loadId);
  if (!L) return null;
  const byId = byIdOf(m);
  const svc = Number(m?.serviceMin) || 15;
  const dIds = (m?.plans?.driven?.[loadId] || []).map(Number);
  const cIds = (m?.plans?.claude?.[loadId] || []).map(Number);
  const dPos = new Map(dIds.map((id, i) => [id, i + 1]));
  const cPos = new Map(cIds.map((id, i) => [id, i + 1]));
  const wD = whereIs(m, 'driven'), wC = whereIs(m, 'claude');
  const un = unplannedOf(m);
  const cols = L.cols || {};

  const list = (ids, col, statusOf) => {
    const legs = Array.isArray(col?.legs) && col.legs.length === ids.length ? col.legs : null;
    let drive = 0;
    return ids.map((id, i) => {
      const stop = byId.get(id);
      const leg = legs ? legs[i] : null;
      if (leg) drive += Number(leg.min) || 0;
      return { stop, seq: i + 1, leg, elapsedMin: leg ? Math.round(drive + svc * i) : null, status: statusOf(id) };
    }).filter((x) => x.stop);
  };
  const dispatch = list(dIds, cols.driven, (id) => {
    if (cPos.has(id)) return { kind: 'kept', otherSeq: cPos.get(id) };
    if (un.has(id)) return { kind: 'unplanned', reason: un.get(id) };
    const w = wC.get(id);
    return w ? { kind: 'moved', to: loadRef(loads, w.loadId), otherSeq: w.seq } : { kind: 'missing' };
  });
  const claude = list(cIds, cols.claude, (id) => {
    if (dPos.has(id)) return { kind: 'kept', otherSeq: dPos.get(id) };
    const w = wD.get(id);
    return w ? { kind: 'added', from: loadRef(loads, w.loadId), otherSeq: w.seq } : { kind: 'added', from: null };
  });

  const kept = dIds.filter((id) => cPos.has(id)).length;
  // 'missing' (on none of Claude's trucks and not listed unplanned) cannot happen in a plan the
  // evaluator accepted — but if a stored plan ever carries one it is a change, never "same stops".
  const removed = dispatch.filter((x) => x.status.kind === 'moved' || x.status.kind === 'unplanned' || x.status.kind === 'missing');
  const added = claude.filter((x) => x.status.kind === 'added');
  const partners = new Map();
  const tally = (ref, key) => {
    if (!ref) return;
    const p = partners.get(ref.loadId) || { ...ref, gave: 0, took: 0 };
    p[key]++;
    partners.set(ref.loadId, p);
  };
  for (const x of removed) if (x.status.kind === 'moved') tally(x.status.to, 'took');
  for (const x of added) tally(x.status.from, 'gave');
  const partnerList = [...partners.values()].sort((a, b) => (b.gave + b.took) - (a.gave + a.took) || String(a.route).localeCompare(String(b.route)));

  // Tied to the truck by its load id (recorded since v1.73.0); a day stored before that has the route
  // name only, and then two trucks that ran one name cannot be told apart (the flag says so).
  const noCoordsHere = (m?.excluded?.noCoords || []).filter((x) => (x.load ? x.load === L.id : x.route === L.route)).map((x) => x.n);
  let change;
  if (!dIds.length && noCoordsHere.length) change = 'unmapped';
  else if (!dIds.length && !cIds.length) change = 'empty';
  else if (!cIds.length) change = 'parked';
  // A truck that ran but none of whose stops had a map point: dispatch's side is not "empty", it
  // is unmapped — the comparison cannot see it, and says so rather than call Claude's side "filled".
  else if (!dIds.length) change = noCoordsHere.length ? 'unmapped' : 'filled';
  else if (added.length || removed.length) change = 'traded';
  else change = dIds.every((id, i) => cIds[i] === id) ? 'same' : 'reordered';

  const cmp = {
    load: L, change, kept, added, removed, partners: partnerList, serviceMin: svc,
    dispatch, claude,
    freight: { driven: freightOf(m, dIds), claude: freightOf(m, cIds) },
    metrics: { driven: cols.driven || null, reseq: cols.reseq || null, claude: cols.claude || null },
    noCoords: noCoordsHere,
    // The stored no-map-point list names the ROUTE only (no driver); when two trucks ran one route
    // name, which of them carried those orders cannot be told.
    routeShared: (m?.excluded?.noCoords || []).some((x) => !x.load && x.route === L.route) ? (m?.loads || []).filter((x) => x.route === L.route).length : 1,
    legsOk: { driven: cols.driven?.legsOk ?? null, claude: cols.claude?.legsOk ?? null },
  };
  cmp.flags = routeFlags(m, cmp);
  return cmp;
}

// A real number or nothing: Number(null) is 0 and 0 is finite, so a missing value would read as zero.
export const numOrNull = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pctOf = (a, b) => (numOrNull(b) > 0 && numOrNull(a) !== null ? numOrNull(a) / numOrNull(b) : null);

/**
 * What a dispatcher would stop on, for one route. Each flag is { key, level: 'red'|'amber'|'info',
 * text }. Limits are judged on CLAUDE's version (dispatch's day already happened); NEAR is 95%.
 */
export function routeFlags(m, cmp) {
  const out = [];
  const c = cmp.metrics.claude, d = cmp.metrics.driven;
  const L = cmp.load;
  const moved = cmp.removed.filter((x) => x.status.kind === 'moved').length;
  const un = cmp.removed.filter((x) => x.status.kind === 'unplanned').length;
  const missing = cmp.removed.filter((x) => x.status.kind === 'missing').length;
  if (cmp.change === 'parked') out.push({ key: 'parked', level: 'amber', text: `Claude parked this truck — ${moved} of its ${cmp.freight.driven.orders} orders ride other trucks${un ? `, ${un} left unplanned` : ''}` });
  if (un) out.push({ key: 'unplanned', level: 'red', text: `Claude left ${un} of these orders unplanned` });
  if (missing) out.push({ key: 'missing', level: 'red', text: `${missing} of these orders are on none of Claude's trucks and not listed unplanned` });
  // Limits are judged on CLAUDE's version (dispatch's day already happened) — but a route Claude ran
  // no tighter than dispatch did is not news: at or past 95% of a limit only counts when Claude made
  // it so; the same load as dispatch's is said as information, and does not sort a route to the top.
  const ratio = (x, a, b) => (x ? pctOf(x[a], x[b]) : null);
  const limit = (key, cOver, cr, dr, overText, nearText) => {
    if (cOver) { out.push({ key, level: dr !== null && dr > 1 + 1e-9 && cr <= dr + 1e-9 ? 'info' : 'red', text: overText }); return; }
    if (cr === null || cr < NEAR) return;
    const tighter = dr === null || cr > dr + 1e-9;
    out.push({ key, level: tighter ? 'amber' : 'info', text: tighter ? nearText : `${nearText} — no tighter than yours` });
  };
  if (c) {
    const cs = ratio(c, 'spots', 'cap'), cl = ratio(c, 'weight', 'maxLbs'), cd = ratio(c, 'driverMin', 'maxMin');
    const ds = ratio(d, 'spots', 'cap'), dl = ratio(d, 'weight', 'maxLbs'), dd = ratio(d, 'driverMin', 'maxMin');
    limit('cap', !!c.over, cs, ds, `over its skid-spot cap (${c.spots} of ${c.cap})`, `${Math.round((cs || 0) * 100)}% of its skid-spot cap`);
    limit('lbs', !!c.overWeight, cl, dl, `over its weight limit (${fmtInt(c.weight)} of ${fmtInt(c.maxLbs)} lb)`, `${Math.round((cl || 0) * 100)}% of its weight limit`);
    limit('day', !!c.overTime, cd, dd, `the driver's day runs past its limit (${fmtHm(c.driverMin)} of ${fmtHm(c.maxMin)})`, `the driver's day is ${Math.round((cd || 0) * 100)}% of its limit`);
    if (Number(c.blocked) > 0) out.push({ key: 'tractor', level: 'red', text: `${c.blocked} no-tractor stop${c.blocked === 1 ? '' : 's'} on this tractor` });
  }
  // A customer split across two of Claude's trucks — news only when dispatch did not split that
  // customer the same way; a split dispatch also ran is said as information.
  const cSplit = customerSplits(m, 'claude'), dSplit = customerSplits(m, 'driven');
  const mine = [...new Set(cmp.claude.map((x) => x.stop?.k).filter(Boolean))].filter((k) => cSplit.has(k));
  if (mine.length) {
    const fresh = mine.filter((k) => !dSplit.has(k));
    const k0 = (fresh.length ? fresh : mine)[0];
    const eg = cmp.claude.find((x) => x.stop?.k === k0)?.stop;
    const others = cSplit.get(k0).filter((id) => id !== L.id).map((id) => (m.loads || []).find((l) => l.id === id)?.route || id);
    out.push(fresh.length
      ? { key: 'split', level: 'amber', text: `${fresh.length} customer${fresh.length === 1 ? '' : 's'} split with another of Claude's trucks that you did not split — e.g. ${eg?.name || eg?.n || 'a customer'} (also on ${others.join(', ')})` }
      : { key: 'split', level: 'info', text: `${mine.length} customer${mine.length === 1 ? '' : 's'} split across trucks — as you split ${mine.length === 1 ? 'it' : 'them'} too` });
  }
  if (d && Number(d.blocked) > 0) out.push({ key: 'tractor-d', level: 'info', text: `you sent ${d.blocked} no-tractor stop${d.blocked === 1 ? '' : 's'} on this tractor` });
  if (L.orderSource && L.orderSource !== 'driven') out.push({ key: 'order', level: 'info', text: `your order here is the ${ORDER_WORD[L.orderSource] || L.orderSource} — no delivery times` });
  if (cmp.noCoords.length) {
    const shared = cmp.routeShared > 1 ? ` — ${cmp.routeShared} trucks ran ${L.route}, and the stored record cannot say which carried ${cmp.noCoords.length === 1 ? 'it' : 'them'}` : '';
    out.push({ key: 'nocoords', level: cmp.change === 'unmapped' ? 'amber' : 'info', text: `${cmp.noCoords.length} order${cmp.noCoords.length === 1 ? '' : 's'} on ${L.route} had no map point and ${cmp.noCoords.length === 1 ? 'is' : 'are'} left out of both sides${shared}` });
  }
  if (cmp.legsOk.driven === false || cmp.legsOk.claude === false) out.push({ key: 'legs', level: 'info', text: 'the leg-by-leg figures do not add back up exactly to the scored miles — trust the totals' });
  return out;
}

/** Every route as one row for the routes table: both versions' freight and numbers, the trade, flags. */
export function routeRows(m) {
  return (m?.loads || []).map((l) => {
    const cmp = routeCompare(m, l.id);
    const d = cmp.metrics.driven, c = cmp.metrics.claude;
    return {
      id: l.id, route: l.route, driver: l.driver, cls: l.cls, orderSource: l.orderSource,
      change: cmp.change, inn: cmp.added.length, out: cmp.removed.length, partners: cmp.partners.length,
      d: cmp.change === 'unmapped'
        ? { orders: null, addresses: null, skids: null, loose: null, spots: null, lbs: null, noCount: 0, miles: null, driveMin: null, routeMin: null, cap: l.cap, maxLbs: l.maxLbs ?? null }
        : { ...cmp.freight.driven, miles: d?.miles ?? null, driveMin: d?.driveMin ?? null, routeMin: d?.routeMin ?? null, cap: d?.cap ?? l.cap, maxLbs: d?.maxLbs ?? l.maxLbs ?? null },
      c: c ? { ...cmp.freight.claude, miles: c.miles, driveMin: c.driveMin, routeMin: c.routeMin ?? null, cap: c.cap, maxLbs: c.maxLbs ?? null, driverMin: c.driverMin ?? null, maxMin: c.maxMin ?? null } : null,
      // Only a route both sides ran has a comparable mileage; a parked truck's miles are not "saved"
      // — its stops were driven by other trucks.
      deltaMi: d && c ? Math.round((c.miles - d.miles) * 10) / 10 : null,
      flags: cmp.flags,
      red: cmp.flags.filter((f) => f.level === 'red').length,
      amber: cmp.flags.filter((f) => f.level === 'amber').length,
    };
  });
}

const CHANGE_RANK = { parked: 0, unmapped: 0, traded: 1, filled: 1, reordered: 2, same: 3, empty: 4 };

/**
 * The order to walk the routes in. 'triage' (the default): anything red, then amber, then the routes
 * Claude traded the most stops on, then re-ordered only, then the ones it left as they were.
 * 'route' by name, 'miles' biggest saving first, 'traded' most stops in + out first.
 */
export function sortRoutes(rows, by = 'triage') {
  const name = (a, b) => String(a.route).localeCompare(String(b.route)) || String(a.driver).localeCompare(String(b.driver));
  const r = rows.slice();
  if (by === 'route') return r.sort(name);
  const dm = (x) => (x.deltaMi === null ? Infinity : x.deltaMi);
  if (by === 'miles') return r.sort((a, b) => dm(a) - dm(b) || name(a, b));
  if (by === 'traded') return r.sort((a, b) => (b.inn + b.out) - (a.inn + a.out) || name(a, b));
  return r.sort((a, b) => b.red - a.red || b.amber - a.amber || (CHANGE_RANK[a.change] ?? 9) - (CHANGE_RANK[b.change] ?? 9)
    || (b.inn + b.out) - (a.inn + a.out) || dm(a) - dm(b) || name(a, b));
}

/** The box around one truck's stops under both plans — what the maps zoom to when a route is opened. */
export function focusBounds(m, loadId) {
  const byId = byIdOf(m);
  const ids = [...(m?.plans?.driven?.[loadId] || []), ...(m?.plans?.claude?.[loadId] || [])];
  const pts = ids.map((id) => byId.get(Number(id))).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!pts.length) return null;
  return {
    north: Math.max(...pts.map((p) => p.lat)), south: Math.min(...pts.map((p) => p.lat)),
    east: Math.max(...pts.map((p) => p.lng)), west: Math.min(...pts.map((p) => p.lng)),
  };
}

/**
 * The colours for an opened route: the route itself in the first colour, then the trucks it traded
 * with most, as many as there are colours. Returns { next, left } — `left` partners got no colour.
 */
export function focusPicks(cmp) {
  const next = new Map([[cmp.load.id, 0]]);
  let slot = 1;
  for (const p of cmp.partners) { if (slot >= MAX_SELECTED) break; next.set(p.loadId, slot++); }
  return { next, left: Math.max(0, cmp.partners.length - (MAX_SELECTED - 1)) };
}

export function fmtInt(n) { const v = numOrNull(n); return v === null ? '—' : Math.round(v).toLocaleString('en-US'); }
/** Minutes as h:mm. */
export function fmtHm(min) {
  const v = numOrNull(min);
  if (v === null) return '—';
  const t = Math.round(v);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
