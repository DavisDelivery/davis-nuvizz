// RouteCompare.jsx — ROUTE BY ROUTE: DISPATCH'S VERSION OF A TRUCK'S DAY AGAINST CLAUDE'S.
//
// Chad, 2026-09-25: "a way to pull up one route and see the differences on a route by route basis.
// And I need to see the routes, the stop counts on them, the skid counts on them, the weights, the
// loose pieces, everything."
//
// Three pieces, two views each (phone and desktop are separate layouts, per the house rule):
//   • RoutesTable / RouteCards — every route of the day, dispatch's numbers → Claude's, in the order
//     worth walking (anything flagged first, then the most-traded), each one tap from its detail.
//   • RoutePanel — one route opened: both versions' numbers side by side, what Claude took off (and
//     where it went), what it put on (and whose truck it came off — one tap to that route), and both
//     stop lists in order with each stop's freight, the leg from the previous stop and the elapsed
//     time since leaving Buford. ◀ ▶ walks the routes in the table's order.
//
// It reads only what the backtest STORED (backtest-map-core.js: routeCompare / routeRows). The
// numbers are the scorecard's own; nothing here re-measures, and what the data cannot say (clock
// times, receiving hours) is said plainly instead of invented.
import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, X, Search, ArrowRight, ArrowLeft, AlertTriangle, Info } from 'lucide-react';
import { SELECT_COLORS, MUTED, ORDER_WORD, NEAR, fmtInt, fmtHm, numOrNull } from './backtest-map-core.js';

// Missing is never zero: numOrNull turns null / undefined / '' into "no number", so it prints '—'.
const one = (v) => { const n = numOrNull(v); return n === null ? '—' : Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1); };
const signed = (v, f = one) => { const n = numOrNull(v); return n === null ? '' : `${n > 0 ? '+' : n < 0 ? '−' : '±'}${f(Math.abs(n))}`; };
const pct = (a, b) => { const x = numOrNull(a), y = numOrNull(b); return x !== null && y > 0 ? `${Math.round((x / y) * 100)}%` : '—'; };
const CHANGE_TEXT = { parked: 'parked', traded: 'traded', filled: 'filled', reordered: 'order only', same: 'unchanged', empty: 'no mapped stops', unmapped: 'not mapped' };
// How dispatch's order on a truck was known — "as driven" only when delivery times said so.
const yourOrder = (L) => (L?.orderSource && L.orderSource !== 'driven' ? `in ${ORDER_WORD[L.orderSource] || L.orderSource}` : 'as driven');
const SORTS = [['triage', 'Needs a look first'], ['route', 'Route name'], ['miles', 'Most miles saved'], ['traded', 'Most stops traded']];

function Dot({ id, sel, onToggle, label }) {
  const slot = sel.get(id);
  const on = slot !== undefined;
  return (
    <button onClick={(e) => { e.stopPropagation(); onToggle(id); }} aria-pressed={on} aria-label={`${on ? 'Clear' : 'Colour'} ${label} on the maps`}
      title={on ? 'Colour on the maps — tap to clear' : 'Colour this truck on the maps'}
      className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center shrink-0 rounded-lg hover:bg-slate-100">
      <span className="inline-block w-3.5 h-3.5 rounded-full border border-white" style={{ background: on ? SELECT_COLORS[slot] : MUTED, opacity: on ? 1 : 0.5, boxShadow: '0 0 0 1px rgba(0,0,0,0.15)' }} />
    </button>
  );
}

function Pair({ a, b, f = one, good = 'down' }) {
  const na = numOrNull(a), nb = numOrNull(b);
  const diff = na !== null && nb !== null && na !== nb;
  const better = diff && (good === 'down' ? nb < na : nb > na);
  return (
    <span className="tabular-nums whitespace-nowrap">
      {a == null ? '—' : f(a)} → <b className={diff ? (good === 'none' ? 'text-slate-900' : better ? 'text-emerald-700' : 'text-rose-700') : 'text-slate-500'}>{b == null ? '—' : f(b)}</b>
    </span>
  );
}

function FlagChips({ flags, small = false }) {
  if (!flags?.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f.key} className={`inline-flex items-center gap-1 rounded-md px-1.5 ${small ? 'text-[10px]' : 'text-[11px]'} ${f.level === 'red' ? 'bg-rose-50 text-rose-800 border border-rose-200' : f.level === 'amber' ? 'bg-amber-50 text-amber-900 border border-amber-200' : 'bg-slate-50 text-slate-600 border border-slate-200'}`}>
          {f.level === 'info' ? <Info size={10} /> : <AlertTriangle size={10} />}{f.text}
        </span>
      ))}
    </div>
  );
}

function ChangeChip({ row }) {
  const t = row.change === 'traded' ? `+${row.inn} −${row.out}` : CHANGE_TEXT[row.change] || row.change;
  const tone = row.change === 'parked' ? 'bg-amber-50 text-amber-900 border-amber-200' : row.change === 'traded' || row.change === 'filled' ? 'bg-indigo-50 text-indigo-800 border-indigo-200' : 'bg-slate-50 text-slate-600 border-slate-200';
  return <span className={`inline-block rounded-md border px-1.5 text-[11px] whitespace-nowrap tabular-nums ${tone}`}>{t}</span>;
}

function RoutesHeader({ count, total, q, setQ, sortBy, setSortBy, phone }) {
  return (
    <div className={phone ? 'space-y-2' : 'flex flex-wrap items-center gap-2 justify-between'}>
      <div className="text-sm font-semibold text-slate-800">Routes ({count === total ? total : `${count} of ${total}`}) — your dispatch → Claude</div>
      <div className={phone ? 'space-y-2' : 'flex flex-wrap items-center gap-2'}>
        <label className="flex items-center gap-2 rounded-lg border bg-white px-2 min-h-[44px]">
          <Search size={13} className="text-slate-400 shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a route or driver" aria-label="Find a route or driver" className="w-full text-xs outline-none bg-transparent min-h-[40px]" />
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <span className="shrink-0">Order</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Order the routes" className="rounded-lg border bg-white px-2 min-h-[44px] text-xs w-full">
            {SORTS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

/** Desktop: every route in one table, dispatch's number → Claude's in each cell. */
export function RoutesTable({ rows, total, sel, onToggle, onOpen, focus, q, setQ, sortBy, setSortBy, serviceMin = 15 }) {
  const shown = rows;
  return (
    <section className="space-y-2" aria-label="Routes">
      <RoutesHeader count={rows.length} total={total} q={q} setQ={setQ} sortBy={sortBy} setSortBy={setSortBy} />
      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500 text-left border-b">
              <th className="py-1.5 pl-1 font-medium w-[44px]"><span className="sr-only">Colour</span></th>
              <th className="py-1.5 pr-3 font-medium">Route · driver</th>
              <th className="py-1.5 pr-3 font-medium">Change</th>
              <th className="py-1.5 pr-3 font-medium text-right">Orders</th>
              <th className="py-1.5 pr-3 font-medium text-right">Skids</th>
              <th className="py-1.5 pr-3 font-medium text-right">Loose</th>
              <th className="py-1.5 pr-3 font-medium text-right">Spots (cap)</th>
              <th className="py-1.5 pr-3 font-medium text-right">Weight lb</th>
              <th className="py-1.5 pr-3 font-medium text-right">Miles (est.)</th>
              <th className="py-1.5 pr-3 font-medium text-right">Route time</th>
              <th className="py-1.5 pr-2 font-medium hidden xl:table-cell">Flags</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} onClick={() => onOpen(r.id)} className={`border-t border-slate-100 cursor-pointer align-middle ${focus === r.id ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
                <td className="pl-1"><Dot id={r.id} sel={sel} onToggle={onToggle} label={r.route} /></td>
                <td className="py-1 pr-3">
                  <button onClick={(e) => { e.stopPropagation(); onOpen(r.id); }} className="text-left min-h-[44px]">
                    <span className="font-semibold text-slate-800 block">{r.route}</span>
                    <span className="text-[11px] text-slate-500 block">{r.driver} · {r.cls === 'tractor' ? 'tractor' : 'box'}{r.orderSource && r.orderSource !== 'driven' ? ` · ${ORDER_WORD[r.orderSource] || r.orderSource}` : ''}</span>
                  </button>
                  <div className="xl:hidden max-w-[260px] pb-1"><FlagChips flags={r.flags.filter((f) => f.level !== 'info')} small /></div>
                </td>
                <td className="pr-3"><ChangeChip row={r} /></td>
                <td className="pr-3 text-right"><Pair a={r.d.orders} b={r.c?.orders ?? 0} good="none" /></td>
                <td className="pr-3 text-right"><Pair a={r.d.skids} b={r.c?.skids ?? 0} good="none" /></td>
                <td className="pr-3 text-right"><Pair a={r.d.loose} b={r.c?.loose ?? 0} good="none" /></td>
                <td className="pr-3 text-right"><Pair a={r.d.spots} b={r.c?.spots ?? 0} good="none" /> <span className="text-slate-400">({one(r.c?.cap ?? r.d.cap)})</span></td>
                <td className="pr-3 text-right"><Pair a={r.d.lbs} b={r.c?.lbs ?? 0} f={fmtInt} good="none" /></td>
                <td className="pr-3 text-right"><Pair a={r.d.miles} b={r.c?.miles ?? null} good="none" /></td>
                <td className="pr-3 text-right"><Pair a={r.d.routeMin} b={r.c?.routeMin ?? null} f={fmtHm} good="none" /></td>
                <td className="pr-2 py-1 max-w-[280px] hidden xl:table-cell"><FlagChips flags={r.flags.filter((f) => f.level !== 'info')} small /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">Each cell is your dispatch → Claude for that truck. Tap a route to open it; the dot colours that truck on the maps. An order is one stop number (the scorecard’s “stops”). Miles and route time (drive + {serviceMin} min an order, Buford to the last stop — the drive home is not counted) are the engine’s estimate, the same yardstick for both. One route’s miles fall when its stops move to another truck, so they are not coloured as a saving — the day’s totals above are the verdict.</p>
    </section>
  );
}

/** Phone: one card per route, the same numbers stacked; a tap opens it. */
export function RouteCards({ rows, total, sel, onToggle, onOpen, focus, q, setQ, sortBy, setSortBy, serviceMin = 15 }) {
  const shown = rows;
  return (
    <section className="space-y-2" aria-label="Routes">
      <RoutesHeader count={rows.length} total={total} q={q} setQ={setQ} sortBy={sortBy} setSortBy={setSortBy} phone />
      {shown.map((r) => (
        <div key={r.id} className={`rounded-lg border ${focus === r.id ? 'border-indigo-300 bg-indigo-50' : 'bg-white'} flex items-start`}>
          <Dot id={r.id} sel={sel} onToggle={onToggle} label={r.route} />
          <button onClick={() => onOpen(r.id)} className="flex-1 min-w-0 text-left py-2 pr-2 min-h-[44px] space-y-1">
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0"><span className="text-xs font-semibold text-slate-800">{r.route}</span> <span className="text-[11px] text-slate-500">{r.driver} · {r.cls === 'tractor' ? 'tractor' : 'box'}</span></span>
              <ChangeChip row={r} />
            </span>
            <span className="block text-[11px] text-slate-600"><Pair a={r.d.orders} b={r.c?.orders ?? 0} good="none" /> orders · <Pair a={r.d.skids} b={r.c?.skids ?? 0} good="none" /> skids · <Pair a={r.d.loose} b={r.c?.loose ?? 0} good="none" /> loose</span>
            <span className="block text-[11px] text-slate-600"><Pair a={r.d.spots} b={r.c?.spots ?? 0} good="none" /> spots (cap {one(r.c?.cap ?? r.d.cap)}) · <Pair a={r.d.lbs} b={r.c?.lbs ?? 0} f={fmtInt} good="none" /> lb</span>
            <span className="block text-[11px] text-slate-600"><Pair a={r.d.miles} b={r.c?.miles ?? null} good="none" /> mi (est.) · <Pair a={r.d.routeMin} b={r.c?.routeMin ?? null} f={fmtHm} good="none" /> route time</span>
            <FlagChips flags={r.flags.filter((f) => f.level !== 'info')} small />
          </button>
        </div>
      ))}
      <p className="text-[11px] text-slate-500">Each line is your dispatch → Claude for that truck. The dot colours it on the map. An order is one stop number; route time is drive + {serviceMin} min an order, Buford to the last stop.</p>
    </section>
  );
}

function StatRows({ cmp, phone }) {
  const d = cmp.metrics.driven, c = cmp.metrics.claude, rs = cmp.metrics.reseq;
  const fd = cmp.freight.driven, fc = cmp.freight.claude;
  const L = cmp.load;
  const diff = (a, b, f = one) => { const x = numOrNull(a), y = numOrNull(b); return x === null || y === null ? '' : signed(y - x, f); };
  const rows = [
    ['Orders (addresses)', `${fd.orders} (${fd.addresses})`, `${fc.orders} (${fc.addresses})`, diff(fd.orders, fc.orders)],
    ['Skids', one(fd.skids), one(fc.skids), diff(fd.skids, fc.skids)],
    ['Loose pieces', fmtInt(fd.loose), fmtInt(fc.loose), diff(fd.loose, fc.loose, fmtInt)],
    ['Skid spots / cap', d ? `${one(d.spots)} / ${one(d.cap)} (${pct(d.spots, d.cap)})` : '—', c ? `${one(c.spots)} / ${one(c.cap)} (${pct(c.spots, c.cap)})` : 'parked', diff(d?.spots, c?.spots)],
    ['Weight / limit', d ? `${fmtInt(d.weight)} / ${d.maxLbs ? fmtInt(d.maxLbs) : '—'} lb` : '—', c ? `${fmtInt(c.weight)} / ${c.maxLbs ? fmtInt(c.maxLbs) : '—'} lb` : 'parked', diff(d?.weight, c?.weight, fmtInt)],
    ['Road miles (est.)', d ? one(d.miles) : '—', c ? one(c.miles) : '—', diff(d?.miles, c?.miles)],
    ['Drive time (est.)', d ? fmtHm(d.driveMin) : '—', c ? fmtHm(c.driveMin) : '—', diff(d?.driveMin, c?.driveMin, fmtHm)],
    [`Route time (drive + ${cmp.serviceMin} min an order)`, d?.routeMin != null ? fmtHm(d.routeMin) : '—', c?.routeMin != null ? fmtHm(c.routeMin) : '—', diff(d?.routeMin, c?.routeMin, fmtHm)],
    ['Driver’s day / limit (all their loads)', d?.driverMin != null ? `${fmtHm(d.driverMin)} / ${fmtHm(d.maxMin)}` : '—', c?.driverMin != null ? `${fmtHm(c.driverMin)} / ${fmtHm(c.maxMin)}` : '—', diff(d?.driverMin, c?.driverMin, fmtHm)],
    ['Buford → first stop', d?.legs?.[0] ? `${one(d.legs[0].mi)} mi` : '—', c?.legs?.[0] ? `${one(c.legs[0].mi)} mi` : '—', ''],
    ['Last stop → Buford (not counted)', d?.homeMi != null ? `${one(d.homeMi)} mi` : '—', c?.homeMi != null ? `${one(c.homeMi)} mi` : '—', ''],
  ];
  const notes = [L.capNote && `Cap: ${L.capNote}.`, L.lbsNote && `Weight limit: ${L.lbsNote}.`, L.maxMinNote && `Day limit: ${L.maxMinNote}.`].filter(Boolean);
  return (
    <div className="space-y-1">
      <table className="w-full text-xs">
        <thead><tr className="text-slate-500 text-left">
          <th className="py-1 pr-2 font-medium" />
          <th className="py-1 pr-2 font-medium text-right">{phone ? 'Yours' : `Yours — ${yourOrder(L)}`}</th>
          <th className="py-1 pr-2 font-medium text-right text-indigo-700">Claude</th>
          {!phone && <th className="py-1 font-medium text-right">Change</th>}
        </tr></thead>
        <tbody>
          {rows.map(([label, a, b, ch]) => (
            <tr key={label} className="border-t border-slate-100">
              <td className="py-1 pr-2 text-slate-600">{label}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{a}</td>
              <td className="py-1 pr-2 text-right tabular-nums font-semibold text-indigo-800">{b}</td>
              {!phone && <td className="py-1 text-right tabular-nums text-slate-600">{ch}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {rs && d && <p className="text-[11px] text-slate-600">Your same stops in the engine’s order: {one(rs.miles)} mi, {rs.miles < d.miles ? `${one(d.miles - rs.miles)} mi shorter than yours` : rs.miles > d.miles ? `${one(rs.miles - d.miles)} mi longer than yours` : 'the same as yours'} — that part is stop order alone.{c && cmp.change !== 'reordered' && cmp.change !== 'same' ? ' Claude’s version carries a different set of stops, so its miles here are not a saving on their own — the stops it took off are driven by other trucks; the day’s totals are the verdict.' : ''}</p>}
      <p className="text-[11px] text-slate-500">Routes are measured open: Buford to the last stop. The drive home is not in the miles, drive time, route time or driver’s day, for either side.</p>
      {notes.map((n) => <p key={n} className="text-[11px] text-slate-500">{n}</p>)}
      {(fd.noCount > 0 || fc.noCount > 0) && <p className="text-[11px] text-slate-500">{fd.noCount} of your orders and {fc.noCount} of Claude’s carry no skids and no loose pieces in the stored day — none recorded or recorded as 0, the day cannot tell which — so they take no room in these numbers, and skid spots may read low.</p>}
    </div>
  );
}

function TradeList({ title, groups, sel, onOpen, dir }) {
  if (!groups.length) return null;
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold text-slate-700">{title}</div>
      {groups.map((g) => {
        const slot = g.ref ? sel.get(g.ref.loadId) : undefined;
        return (
          <div key={g.key} className="rounded-lg border bg-white px-2 py-1 text-[11px] flex items-start gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full mt-1 shrink-0" style={{ background: slot !== undefined ? SELECT_COLORS[slot] : MUTED, opacity: slot !== undefined ? 1 : 0.5 }} />
            <span className="flex-1 min-w-0">
              <span className="font-semibold text-slate-800">{g.label}</span> <span className="text-slate-500">({g.items.length})</span>
              <span className="block text-slate-600">{g.items.map((x) => `${x.stop.name || x.stop.n} #${x.stop.n}${x.status.reason ? ` — ${x.status.reason}` : ''}`).join(' · ')}</span>
            </span>
            {g.ref && <button onClick={() => onOpen(g.ref.loadId)} className="rounded-lg border bg-white px-2 min-h-[44px] text-indigo-700 font-semibold shrink-0 inline-flex items-center gap-1">{dir === 'to' ? <ArrowRight size={12} /> : <ArrowLeft size={12} />} Open</button>}
          </div>
        );
      })}
    </div>
  );
}

const groupBy = (items, refOf, labelOf) => {
  const m = new Map();
  for (const x of items) {
    const ref = refOf(x);
    const key = ref ? ref.loadId : `_${x.status.kind}`;
    if (!m.has(key)) m.set(key, { key, ref, label: labelOf(x, ref), items: [] });
    m.get(key).items.push(x);
  }
  return [...m.values()].sort((a, b) => b.items.length - a.items.length);
};

function StopList({ title, items, side, sel, onOpen }) {
  const statusText = (x) => {
    const s = x.status;
    // otherSeq is the stop's place on the OTHER side: Claude's on your list, yours on Claude's.
    if (s.kind === 'kept') return { t: side === 'claude' ? `kept · your #${s.otherSeq}` : `kept · Claude’s #${s.otherSeq}`, ref: null };
    if (s.kind === 'moved') return { t: `→ ${s.to.route}`, ref: s.to };
    if (s.kind === 'added') return { t: s.from ? `← ${s.from.route}` : 'added', ref: s.from };
    if (s.kind === 'unplanned') return { t: 'left unplanned', ref: null };
    if (s.kind === 'missing') return { t: 'on no truck of Claude’s', ref: null };
    return { t: '—', ref: null };
  };
  return (
    <div className="min-w-0 space-y-1">
      <div className={`text-xs font-semibold ${side === 'claude' ? 'text-indigo-800' : 'text-slate-800'}`}>{title} ({items.length})</div>
      {!items.length && <p className="text-[11px] text-slate-500">No stops on this truck.</p>}
      {items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-[11px]">
            <thead><tr className="text-slate-500 text-left border-b">
              <th className="py-1 pl-2 pr-1 font-medium">#</th>
              <th className="py-1 pr-2 font-medium">Stop</th>
              <th className="py-1 pr-2 font-medium text-right">Skids</th>
              <th className="py-1 pr-2 font-medium text-right">Loose</th>
              <th className="py-1 pr-2 font-medium text-right">lb</th>
              <th className="py-1 pr-2 font-medium text-right">Leg mi</th>
              <th className="py-1 pr-2 font-medium text-right">Elapsed</th>
              <th className="py-1 pr-2 font-medium">{side === 'claude' ? 'Came from' : 'Went to'}</th>
            </tr></thead>
            <tbody>
              {items.map((x) => {
                const st = statusText(x);
                const slot = st.ref ? sel.get(st.ref.loadId) : undefined;
                return (
                  <tr key={x.stop.id} className={`border-t border-slate-100 align-top ${x.status.kind === 'kept' ? '' : side === 'claude' ? 'bg-indigo-50/40' : 'bg-amber-50/40'}`}>
                    <td className="py-1 pl-2 pr-1 tabular-nums font-semibold text-slate-700">{x.seq}</td>
                    <td className="py-1 pr-2 min-w-[140px]"><span className="text-slate-800">{x.stop.name || x.stop.n}</span><span className="block text-slate-500">{x.stop.city || ''} · #{x.stop.n}{x.stop.noTractor ? ' · no-tractor' : ''}</span></td>
                    <td className="py-1 pr-2 text-right tabular-nums">{one(x.stop.skids)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmtInt(x.stop.loose)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmtInt(x.stop.lbs)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{x.leg ? one(x.leg.mi) : '—'}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{x.elapsedMin != null ? fmtHm(x.elapsedMin) : '—'}</td>
                    <td className="py-1 pr-2">
                      {st.ref
                        ? <button onClick={() => onOpen(st.ref.loadId)} className="inline-flex items-center gap-1 text-indigo-700 font-semibold min-h-[44px] text-left"><span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: slot !== undefined ? SELECT_COLORS[slot] : MUTED }} />{st.t}</button>
                        : <span className={x.status.kind === 'unplanned' || x.status.kind === 'missing' ? 'text-rose-700 font-semibold' : 'text-slate-500'}>{st.t}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One route, opened: both versions' numbers, the trade, and both stop lists. */
export function RoutePanel({ cmp, phone, sel, onOpen, onClose, prevId, nextId, position, total, colourNote }) {
  const [side, setSide] = useState('claude');
  if (!cmp) return null;
  const L = cmp.load;
  const took = groupBy(cmp.removed, (x) => (x.status.kind === 'moved' ? x.status.to : null), (x, ref) => (ref ? `→ ${ref.route} · ${ref.driver}` : 'Left unplanned by Claude'));
  const gave = groupBy(cmp.added, (x) => x.status.from, (x, ref) => (ref ? `← ${ref.route} · ${ref.driver}` : 'Added'));
  const movedN = cmp.removed.filter((x) => x.status.kind === 'moved').length;
  const unN = cmp.removed.filter((x) => x.status.kind === 'unplanned').length;
  const summary = cmp.change === 'parked' ? `Claude parked this truck: ${movedN} of your ${cmp.freight.driven.orders} orders ride other trucks${unN ? ` and ${unN} ${unN === 1 ? 'is' : 'are'} left unplanned` : ''}.`
    : cmp.change === 'unmapped' ? 'None of your stops on this truck had a map point, so the comparison cannot see your version of it.'
      : cmp.change === 'empty' ? 'Neither version has a mapped stop on this truck.'
    : cmp.change === 'same' ? 'Claude left this route exactly as you ran it.'
      : cmp.change === 'reordered' ? 'Same stops as yours — Claude only changed the order.'
        : `Claude kept ${cmp.kept} of your ${cmp.freight.driven.orders} orders, took off ${cmp.removed.length} and put on ${cmp.added.length}${cmp.partners.length ? `, trading with ${cmp.partners.length} truck${cmp.partners.length === 1 ? '' : 's'}` : ''}.`;
  const nav = (
    <div className="flex items-center gap-1 shrink-0">
      <button onClick={() => prevId && onOpen(prevId)} disabled={!prevId} aria-label="Previous route" className="rounded-lg border bg-white min-h-[44px] min-w-[44px] inline-flex items-center justify-center disabled:opacity-40"><ChevronLeft size={16} /></button>
      <span className="text-[11px] text-slate-500 tabular-nums px-1 whitespace-nowrap">{position ? `${position} of ${total}` : 'not in the list shown'}</span>
      <button onClick={() => nextId && onOpen(nextId)} disabled={!nextId} aria-label="Next route" className="rounded-lg border bg-white min-h-[44px] min-w-[44px] inline-flex items-center justify-center disabled:opacity-40"><ChevronRight size={16} /></button>
      <button onClick={onClose} aria-label="Close the route" className="rounded-lg border bg-white min-h-[44px] min-w-[44px] inline-flex items-center justify-center"><X size={14} /></button>
    </div>
  );
  const lists = phone ? (
    <div className="space-y-2">
      <div className="flex gap-2">
        {[['driven', `Yours (${cmp.dispatch.length})`], ['claude', `Claude’s (${cmp.claude.length})`]].map(([k, t]) => (
          <button key={k} onClick={() => setSide(k)} aria-pressed={side === k} className={`rounded-lg px-3 text-xs font-semibold min-h-[44px] border ${side === k ? 'bg-indigo-700 text-white border-indigo-700' : 'bg-white text-slate-700'}`}>{t}</button>
        ))}
      </div>
      {side === 'driven'
        ? <StopList title={`Your stops, ${yourOrder(L)}`} items={cmp.dispatch} side="driven" sel={sel} onOpen={onOpen} />
        : <StopList title="Claude’s stops, in order" items={cmp.claude} side="claude" sel={sel} onOpen={onOpen} />}
    </div>
  ) : (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
      <StopList title={`Your stops, ${yourOrder(L)}`} items={cmp.dispatch} side="driven" sel={sel} onOpen={onOpen} />
      <StopList title="Claude’s stops, in order" items={cmp.claude} side="claude" sel={sel} onOpen={onOpen} />
    </div>
  );
  return (
    <section tabIndex={-1} className="rounded-xl border-2 border-indigo-300 bg-indigo-50/30 p-3 space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" aria-label={`Route ${L.route}`}>
      <div className={phone ? 'space-y-2' : 'flex items-start justify-between gap-3'}>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">{L.route} <span className="font-normal text-slate-600">· {L.driver} · {L.cls === 'tractor' ? 'tractor' : 'box truck'}</span></div>
          <div className="text-xs text-slate-700">{summary}</div>
        </div>
        {nav}
      </div>
      <FlagChips flags={cmp.flags} />
      {colourNote && <p className="text-[11px] text-slate-500" role="status">{colourNote}</p>}
      <StatRows cmp={cmp} phone={phone} />
      {L.why && <p className="text-xs text-slate-700"><span className="font-semibold text-indigo-800">Claude’s reason:</span> “{L.why}”</p>}
      <div className={phone ? 'space-y-2' : 'grid grid-cols-1 lg:grid-cols-2 gap-3 items-start'}>
        <TradeList title={`Claude took off (${cmp.removed.length})`} groups={took} sel={sel} onOpen={onOpen} dir="to" />
        <TradeList title={`Claude put on (${cmp.added.length})`} groups={gave} sel={sel} onOpen={onOpen} dir="from" />
      </div>
      {lists}
      <p className="text-[11px] text-slate-500">Leg miles and times are the engine’s estimate (straight line × road factor), the same yardstick as the scorecard. Elapsed is drive time plus {cmp.serviceMin} min an order since leaving Buford — not a clock time: the backtest has no start time and does not check receiving hours. Skids, loose pieces and weight are as recorded on the day. “Near a limit” means {Math.round(NEAR * 100)}% or more.</p>
    </section>
  );
}
