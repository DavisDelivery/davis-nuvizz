// AttemptsCard.jsx
//
// Drop-in card for the Davis driver scorecard (davis-driver-scorecard.netlify.app).
// Render it RIGHT BELOW the "Mis Deliveries" section. It reads the per-day attempts
// list produced by the NuVizz dispatch app's evening attempt scan and shows, for
// each attempted delivery, WHO had it when it was attempted (the original driver
// from that morning's routed-plan snapshot) — even though the order is now unplanned
// and no longer shows a driver in NuVizz.
//
// Data source (CORS-enabled, no NuVizz traffic — reads Firestore):
//   GET {apiBase}/.netlify/functions/nuvizz-attempts?date=YYYY-MM-DD[&driver=NAME]
//   → { ok, date, generated, manifest, count, attempts[] }
//
// This component lives in the dispatch repo (davis-nuvizz) ONLY as the canonical
// copy + reference; copy it into the scorecard repo's components folder to use it.
// It has no dependencies beyond React (icons are inline SVG), so it works whatever
// the scorecard's icon/UI setup is. Styling is plain Tailwind utility classes to
// match the existing scorecard cards; adjust classNames to taste.

import { useEffect, useState, useCallback } from 'react';

// The dispatch app that owns the attempts feed. Override via the `apiBase` prop if
// the functions are served from a different site or a custom domain.
const DEFAULT_API_BASE = 'https://dd-dispatch-map.netlify.app';

// Local YYYY-MM-DD (the feed keys days by America/New_York date).
function todayStr() {
  const d = new Date();
  const tz = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return tz;
}

function StatusPill({ attempt }) {
  const unplanned = attempt.currentlyUnplanned;
  const cls = unplanned
    ? 'bg-amber-100 text-amber-800 ring-amber-200'
    : 'bg-slate-100 text-slate-700 ring-slate-200';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}>
      {unplanned ? 'Unplanned' : (attempt.currentStatus || '—')}
    </span>
  );
}

/**
 * @param {object}  props
 * @param {string} [props.apiBase]  Base URL of the dispatch app serving the feed.
 * @param {string} [props.date]     YYYY-MM-DD; defaults to today (ET). Make it a
 *                                  controlled prop to share a date picker with the
 *                                  rest of the scorecard, or leave it for the card's
 *                                  own built-in picker.
 * @param {string} [props.driver]   Optional driver filter (userName or name substring)
 *                                  — pass this on a single-driver scorecard so the
 *                                  card shows only that driver's attempts.
 */
export default function AttemptsCard({ apiBase = DEFAULT_API_BASE, date: dateProp, driver }) {
  const [date, setDate] = useState(dateProp || todayStr());
  const [state, setState] = useState({ loading: true, error: null, attempts: [], manifest: null });

  useEffect(() => { if (dateProp) setDate(dateProp); }, [dateProp]);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const url = new URL(`${apiBase}/.netlify/functions/nuvizz-attempts`);
      url.searchParams.set('date', date);
      if (driver) url.searchParams.set('driver', driver);
      const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'feed error');
      setState({ loading: false, error: null, attempts: json.attempts || [], manifest: json.manifest || null });
    } catch (e) {
      setState({ loading: false, error: e.message || 'failed to load', attempts: [], manifest: null });
    }
  }, [apiBase, date, driver]);

  useEffect(() => { load(); }, [load]);

  const { loading, error, attempts, manifest } = state;
  const counts = manifest?.counts;

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-rose-500" aria-hidden="true">
            <path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" />
          </svg>
          <h2 className="text-base font-semibold text-slate-800">Attempts</h2>
          {typeof counts?.attempts === 'number' && (
            <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700">
              {counts.attempts}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Built-in date picker — remove if the scorecard already controls `date`. */}
          {!dateProp && (
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-700"
            />
          )}
          <button
            onClick={load}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50"
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="px-4 py-3">
        <p className="mb-3 text-xs text-slate-500">
          Who had each delivery the morning it was attempted. The order is now unplanned in
          NuVizz (no driver), so attribution comes from that day&apos;s 8:30am routed snapshot.
        </p>

        {loading && <div className="py-6 text-center text-sm text-slate-400">Loading attempts…</div>}

        {!loading && error && (
          <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
            Couldn&apos;t load attempts: {error}
          </div>
        )}

        {!loading && !error && attempts.length === 0 && (
          <div className="py-6 text-center text-sm text-slate-400">
            No attempts recorded for {date}.
          </div>
        )}

        {!loading && !error && attempts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-4 font-medium">Original driver</th>
                  <th className="py-2 pr-4 font-medium">Customer</th>
                  <th className="py-2 pr-4 font-medium">Shipment</th>
                  <th className="py-2 pr-4 font-medium">Stop&nbsp;#</th>
                  <th className="py-2 pr-4 font-medium">Route</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.stopNbr} className="border-b border-slate-50 last:border-0">
                    <td className="py-2 pr-4 font-medium text-slate-800">
                      {a.originalDriverName || a.originalDriverUserName || (
                        <span className="text-amber-600">Unknown</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-slate-600">
                      <div>{a.businessName || '—'}</div>
                      {(a.city || a.state) && (
                        <div className="text-xs text-slate-400">{[a.city, a.state].filter(Boolean).join(', ')}</div>
                      )}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-rose-700">{a.shipmentNbr || '—'}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-500">{a.stopNbr}</td>
                    <td className="py-2 pr-4 text-slate-600">{a.routeName || '—'}</td>
                    <td className="py-2 pr-4"><StatusPill attempt={a} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && counts && (
          <div className="mt-3 text-xs text-slate-400">
            {counts.attempts} attempt{counts.attempts === 1 ? '' : 's'}
            {typeof counts.unmatched === 'number' && counts.unmatched > 0 && (
              <span className="text-amber-600"> · {counts.unmatched} without a morning driver</span>
            )}
            {manifest?.planMissing && <span className="text-amber-600"> · morning snapshot missing</span>}
          </div>
        )}
      </div>
    </section>
  );
}
