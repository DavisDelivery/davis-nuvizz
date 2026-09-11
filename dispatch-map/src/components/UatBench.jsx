// src/components/UatBench.jsx — the UAT test bench, on screen.
//
// Chad, 2026-09-10: "we need to use firestore to see what data/orders are put into system
// daily so we are not running scans. Then we can design a way to test using that information
// so we need to test something we will write just the orders we need to test whatever
// scenario we are testing into the uat." Asked how he wanted to pick, he chose a checkbox
// list of production's day; asked about teardown, he chose clear on request.
//
// So: production's Firestore is the CATALOGUE and this screen is how you shop it. Tick the
// orders a scenario needs, see exactly what would be sent, send it, run the test on the UAT
// board, and strike the set when you are done. The server (netlify/functions/uat-seed.mts)
// holds every gate; this screen decides nothing and can spend nothing by accident.
//
// ── WHY YOU CANNOT REACH THIS FROM PRODUCTION ───────────────────────────────
//
// The screen is mounted only on a UAT host (isUatHost, src/lib/mirror-site.js) — keyed on the
// hostname because that is the one fact about a deploy nobody can forget to set, and the
// direction it fails in is safe: a production host never shows it. The endpoint refuses
// independently on FIRESTORE_DATABASE, so this is the courtesy check and not the safety one.
//
// ── THE THREE THINGS THIS SCREEN IS CAREFUL ABOUT ───────────────────────────
//
//  1. PREVIEW IS FREE AND SAYS SO. Every button that costs NuVizz calls says how many before
//     you press it. A bench whose cost is invisible gets used carelessly on the one tenant
//     where careless is cheap — until somebody points it at the wrong one.
//  2. NOTHING IS CLAIMED THAT WAS NOT OBSERVED. The seed result renders what the server
//     actually reported: created, failed, skipped, and the warnings per order. An order the
//     server refused is shown as refused, with its reason, not folded into a count.
//  3. CLEAR IS DESTRUCTIVE AND ASKS. It cancels real orders in the UAT tenant, and after a
//     route test it has to unplan them first. The confirm names the number and what happens.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Beaker, Check, RefreshCw, Trash2, Eye, AlertTriangle, Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/api.js';
// Pure core, thin edges: every judgement about a row lives in the lib and is tested there.
import { rowSubtitle, windowLabel, matchesQuery, benchToday, BENCH_MAX } from '../lib/uat-bench-view.js';

const FN = '/.netlify/functions/uat-seed';

export default function UatBench() {
  const [date, setDate] = useState(benchToday);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);          // 'preview' | 'seed' | 'clear'
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [onlyUnplanned, setOnlyUnplanned] = useState(false);
  const [label, setLabel] = useState('');
  const [result, setResult] = useState(null);

  const call = useCallback(async (body, method = 'POST') => {
    const res = method === 'GET'
      ? await apiFetch(`${FN}?op=catalogue&date=${encodeURIComponent(body.date)}`, { cache: 'no-store' })
      : await apiFetch(FN, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let j;
    try { j = await res.json(); } catch { j = { ok: false, error: `bad response (${res.status})` }; }
    return j;
  }, []);

  const loadCatalogue = useCallback(async (d) => {
    setLoading(true); setErr(null);
    try {
      const j = await call({ date: d }, 'GET');
      if (!j?.ok) { setErr(j?.error || 'could not read production\'s day'); setCat(null); }
      else { setCat(j); setPicked(new Set()); }
    } finally { setLoading(false); }
  }, [call]);

  useEffect(() => { loadCatalogue(date); }, [date, loadCatalogue]);

  const rows = useMemo(() => {
    const all = Array.isArray(cat?.rows) ? cat.rows : [];
    return all
      .filter((r) => matchesQuery(r, query))
      .filter((r) => (onlyUnplanned ? (r?.isUnplanned === true || r?.isPlanned === false) : true))
      .sort((a, b) => String(a?.city || '').localeCompare(String(b?.city || '')) || String(a?.businessName || '').localeCompare(String(b?.businessName || '')));
  }, [cat, query, onlyUnplanned]);

  const toggle = (nbr) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(nbr)) next.delete(nbr); else next.add(nbr);
    return next;
  });

  const run = async (op) => {
    setBusy(op); setErr(null);
    try {
      const body = op === 'clear'
        ? { op: 'clear' }
        : { op, date, stopNbrs: [...picked], label: label.trim() || null };
      const j = await call(body);
      setResult({ op, ...j });
      if (!j?.ok && j?.error) setErr(j.error);
      if (op === 'seed' || op === 'clear') await loadCatalogue(date);
    } finally { setBusy(null); }
  };

  const onClear = () => {
    const n = cat?.seeded?.count ?? 0;
    if (!n) { setErr('the bench has nothing seeded'); return; }
    // Destructive, and it asks — naming the number and what actually happens, because after a
    // route test these orders are ON a load and the clear has to unplan them first.
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Cancel ${n} seeded test order${n === 1 ? '' : 's'} in the UAT tenant?\n\nAny that are on a route are unplanned first. Production is not touched.`)) return;
    run('clear');
  };

  const nPicked = picked.size;
  const overCap = nPicked > BENCH_MAX;
  const seededCount = cat?.seeded?.count ?? 0;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50">
      <div className="max-w-5xl mx-auto px-4 py-4 space-y-3" style={{ paddingBlock: '1rem' }}>

        <header className="flex items-start gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <Beaker size={18} className="text-amber-600 shrink-0" />
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-slate-900 leading-tight">UAT test bench</h1>
              <p className="text-xs text-slate-500">
                Production&apos;s day, read from Firestore. Tick what a scenario needs; only those are created in the UAT tenant.
                <strong className="text-slate-700"> Nothing here calls production.</strong>
              </p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <input
              type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="border rounded px-2 py-1 text-sm min-h-[38px]"
              aria-label="Production board day to pick from"
            />
            <button
              onClick={() => loadCatalogue(date)} disabled={loading}
              className="inline-flex items-center gap-1 border rounded px-2 py-1 text-sm min-h-[38px] bg-white hover:bg-slate-50 disabled:opacity-50"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
            </button>
          </div>
        </header>

        {/* WHERE THE WRITES GO. Named on screen because the one failure this bench can have
            that matters is pointing at the wrong tenant — and a number on a screen is the
            only way anyone would notice before it happened. */}
        {cat?.bench && (
          <div className="text-[11px] text-slate-600 bg-white border rounded px-3 py-2 flex flex-wrap gap-x-4 gap-y-1">
            <span>NuVizz: <strong className="font-mono">{cat.bench.nuvizzBase || '(not configured)'}</strong></span>
            <span>tenant: <strong className="font-mono">{cat.bench.companyCode || '—'}</strong></span>
            <span>board db: <strong className="font-mono">{cat.bench.mirror}</strong></span>
          </div>
        )}

        {err && (
          <div className="text-sm bg-red-50 border border-red-200 text-red-800 rounded px-3 py-2 flex items-start gap-2">
            <AlertTriangle size={15} className="shrink-0 mt-0.5" /><span className="min-w-0 break-words">{err}</span>
          </div>
        )}
        {cat?.note && !err && (
          <div className="text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded px-3 py-2">{cat.note}</div>
        )}

        {/* ── the picker ─────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by customer, city, zip, order #…"
            className="border rounded px-2 py-1 text-sm flex-1 min-w-[180px] min-h-[38px]"
          />
          <label className="text-xs inline-flex items-center gap-1.5 text-slate-600 min-h-[38px]">
            <input type="checkbox" checked={onlyUnplanned} onChange={(e) => setOnlyUnplanned(e.target.checked)} />
            un-planned only
          </label>
          <span className="text-xs text-slate-500">
            {rows.length} of {cat?.dayTotal ?? 0} shown · {cat?.unplannedTotal ?? 0} un-planned
          </span>
        </div>

        {/* DESKTOP: a table, because picking 14 of 800 is a scanning job and rows scan best.
            PHONE: stacked cards below — two views, not one layout with patches. */}
        <div className="hidden md:block bg-white border rounded overflow-hidden">
          <div className="max-h-[46vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-slate-600 text-xs sticky top-0">
                <tr>
                  <th className="w-8 px-2 py-1.5" />
                  <th className="text-left px-2 py-1.5">Customer</th>
                  <th className="text-left px-2 py-1.5">Where</th>
                  <th className="text-left px-2 py-1.5">Window</th>
                  <th className="text-left px-2 py-1.5">In production</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const nbr = String(r.stopNbr);
                  const on = picked.has(nbr);
                  return (
                    <tr key={nbr} className={`border-t cursor-pointer ${on ? 'bg-amber-50' : 'hover:bg-slate-50'}`} onClick={() => toggle(nbr)}>
                      <td className="px-2 py-1.5 text-center"><input type="checkbox" checked={on} readOnly tabIndex={-1} /></td>
                      <td className="px-2 py-1.5"><div className="font-medium text-slate-800">{r.businessName || '—'}</div><div className="text-[11px] text-slate-400 font-mono">{nbr}</div></td>
                      <td className="px-2 py-1.5 text-slate-600">{[r.addr1, r.city].filter(Boolean).join(', ')}</td>
                      <td className={`px-2 py-1.5 ${windowLabel(r) === 'no window' ? 'text-slate-400 italic' : 'text-slate-700'}`}>{windowLabel(r)}</td>
                      <td className="px-2 py-1.5 text-[11px]">
                        {r.isPlanned ? <span className="text-slate-600">on {r.routeName || r.loadNbr || 'a load'}</span> : <span className="text-emerald-700">un-planned</span>}
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && !loading && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400 text-sm">Nothing matches.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="md:hidden space-y-1.5">
          {rows.map((r) => {
            const nbr = String(r.stopNbr);
            const on = picked.has(nbr);
            return (
              <button
                key={nbr} onClick={() => toggle(nbr)}
                className={`w-full text-left border rounded px-3 py-2 min-h-[56px] flex items-start gap-2 ${on ? 'bg-amber-50 border-amber-300' : 'bg-white'}`}
              >
                <span className={`mt-0.5 w-4 h-4 rounded border shrink-0 inline-flex items-center justify-center ${on ? 'bg-amber-500 border-amber-500 text-white' : 'border-slate-300'}`}>
                  {on && <Check size={11} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-slate-800 text-sm truncate">{r.businessName || '—'}</span>
                  <span className="block text-[11px] text-slate-500 break-words">{rowSubtitle(r)}</span>
                  <span className="block text-[11px] mt-0.5">
                    <span className={windowLabel(r) === 'no window' ? 'text-slate-400 italic' : 'text-slate-700'}>{windowLabel(r)}</span>
                    <span className="text-slate-300"> · </span>
                    {r.isPlanned ? <span className="text-slate-500">on {r.routeName || 'a load'}</span> : <span className="text-emerald-700">un-planned</span>}
                  </span>
                </span>
              </button>
            );
          })}
          {!rows.length && !loading && <div className="text-center text-slate-400 text-sm py-6">Nothing matches.</div>}
        </div>

        {/* ── the actions, each saying what it costs ─────────────────────── */}
        <div className="bg-white border rounded p-3 space-y-2 sticky bottom-0">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="What is this testing? (rides on each copy)"
              className="border rounded px-2 py-1 text-sm flex-1 min-w-[160px] min-h-[38px]"
            />
            <span className={`text-sm font-semibold ${overCap ? 'text-red-700' : 'text-slate-700'}`}>{nPicked} picked</span>
          </div>
          {overCap && (
            <p className="text-xs text-red-700">
              The bench seeds at most {BENCH_MAX} at a time — each one is a NuVizz call and the function has ~10s to finish.
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => run('preview')} disabled={!nPicked || !!busy}
              className="inline-flex items-center gap-1.5 border rounded px-3 py-2 min-h-[44px] text-sm bg-white hover:bg-slate-50 disabled:opacity-40"
            >
              {busy === 'preview' ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
              Preview — <span className="text-emerald-700 font-medium">0 calls</span>
            </button>
            <button
              onClick={() => run('seed')} disabled={!nPicked || overCap || !!busy}
              className="inline-flex items-center gap-1.5 rounded px-3 py-2 min-h-[44px] text-sm bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-40"
            >
              {busy === 'seed' ? <Loader2 size={14} className="animate-spin" /> : <Beaker size={14} />}
              Seed into UAT — {nPicked} call{nPicked === 1 ? '' : 's'}
            </button>
            <button
              onClick={onClear} disabled={!seededCount || !!busy}
              className="inline-flex items-center gap-1.5 border border-red-300 text-red-700 rounded px-3 py-2 min-h-[44px] text-sm bg-white hover:bg-red-50 disabled:opacity-40 ml-auto"
            >
              {busy === 'clear' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Clear the bench ({seededCount})
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            Preview and the order list cost nothing — they read Firestore. Only Seed and Clear reach NuVizz, and only the UAT tenant.
          </p>
        </div>

        {result && <BenchResult result={result} />}
      </div>
    </div>
  );
}

/** What the server actually reported. Never a summary that outruns it: an order the server
 *  refused is shown as refused, with its reason, rather than folded into a count. */
function BenchResult({ result }) {
  const { op } = result;
  const created = result.created || [];
  const failed = result.failed || [];
  const skipped = result.skipped || [];
  const warnings = result.warnings || [];
  const stuck = result.stuck || [];
  const payloads = result.payloads || [];
  return (
    <div className="bg-white border rounded p-3 space-y-2 text-sm">
      <div className="font-semibold text-slate-800">
        {op === 'preview' && `Preview — ${result.willCreate ?? payloads.length} order(s) would be created, 0 NuVizz calls spent`}
        {op === 'seed' && `Seeded ${result.seeded ?? 0}${result.failed ? `, ${result.failed} failed` : ''} · ${result.callsUsed ?? 0} UAT call(s) · board now holds ${result.boardRows ?? 0}`}
        {op === 'clear' && `Cancelled ${result.cancelled ?? 0}${result.unplannedFirst ? ` (${result.unplannedFirst} unplanned first)` : ''}${result.alreadyGone ? ` · ${result.alreadyGone} already gone` : ''} · ${result.callsUsed ?? 0} UAT call(s)`}
      </div>

      {!!warnings.length && (
        <ul className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 space-y-1">
          {warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
        </ul>
      )}
      {!!skipped.length && (
        <ul className="text-xs text-slate-600 space-y-0.5">
          {skipped.map((s, i) => <li key={i}><span className="font-mono">{s.stopNbr}</span> — not seeded: {s.why}</li>)}
        </ul>
      )}
      {!!failed.length && (
        <ul className="text-xs text-red-700 space-y-0.5">
          {failed.map((f, i) => <li key={i}><span className="font-mono">{f.uatStopNbr || f.prodStopNbr}</span> — {f.error}</li>)}
        </ul>
      )}
      {!!stuck.length && (
        <ul className="text-xs text-red-700 space-y-0.5">
          {stuck.map((s, i) => <li key={i}><span className="font-mono">{s.stopNbr}</span> — {s.error}</li>)}
        </ul>
      )}
      {!!created.length && (
        <ul className="text-xs text-emerald-800 space-y-0.5">
          {created.map((c, i) => <li key={i}><span className="font-mono">{c.uatStopNbr}</span> ← {c.prodStopNbr}{c.updated ? ' (updated an existing copy)' : ''}</li>)}
        </ul>
      )}
      {op === 'preview' && !!payloads.length && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-600">The exact JSON that would be sent ({payloads.length})</summary>
          <pre className="mt-1 bg-slate-900 text-slate-100 rounded p-2 overflow-x-auto max-h-72 text-[10px] leading-snug">{JSON.stringify(payloads, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
