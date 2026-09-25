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
