// components/DraftDriverList.jsx
//
// STEP 4 · BY DRIVER — A LIST YOU PICK FROM. Chad: "This should be a list that i select from not
// a type in situation other than type in to find the name or route to select."
//
// Every row is a driver who ran a route in the 30 days before the day (routing-draft GET), with the truck
// class the draft will plan them on and the routes they run most. Tapping a row picks it (up to
// four); the box above only narrows the list — by name, NuVizz code or route — and is never sent
// anywhere. What the Build Panel sends is the picked rows' exact keys.
//
// IN FLOW, NOT AN OVERLAY — the same reasoning as the route card's DriverPicker: the list sits
// inside the scrolling Build Panel, so it caps its own height and scrolls, and what is below it
// moves when it grows. TWO VIEWS: on a phone every row and chip is a full thumb target (44px),
// and the box is 16px text so iOS does not zoom the page when it takes focus; on a desktop the
// rows are compact to match the rest of the panel. The phone list is capped at 30vh: at 45vh it
// was taller than the sheet's visible area on every phone measured, so a finger on the list
// scrolled the list and there was no surface left to drag the sheet by.
import { useMemo, useRef, useState } from 'react';
import { filterDraftDrivers, DRAFT_MAX_DRIVERS, draftDriverClassLabel } from '../lib/draft-driver-list.js';

function shortDay(ymd) {
  if (!ymd) return '';
  try {
    return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  } catch { return ymd; }
}

export default function DraftDriverList({
  drivers = null,          // null until the list has loaded
  loading = false,
  error = null,
  onRetry = null,
  picked = [],
  onToggle,
  disabled = false,
  isMobile = false,
  windowDays = 30,
  dateLabel = '',
}) {
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);
  const list = Array.isArray(drivers) ? drivers : [];
  const shown = useMemo(() => filterDraftDrivers(list, query), [list, query]);
  const byKey = useMemo(() => new Map(list.map((d) => [d.key, d])), [list]);
  const full = picked.length >= DRAFT_MAX_DRIVERS;

  const rowCls = isMobile ? 'min-h-[44px] px-2 py-1.5 text-[14px]' : 'px-1.5 py-1 text-[12px]';
  const chipCls = isMobile ? 'min-h-[44px] px-3 text-[14px]' : 'px-1.5 py-0.5 text-[11px]';

  return (
    <div className="space-y-1.5" data-draft-driver-list={drivers === null ? 'loading' : list.length}>
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Drivers picked for the draft" data-draft-driver-picked={picked.length}>
          {picked.map((k) => {
            const d = byKey.get(k);
            return (
              <button key={k} type="button" disabled={disabled} onClick={() => { onToggle?.(k); if (!isMobile) searchRef.current?.focus(); }}
                title={`Take ${d?.name || k} off the draft`} aria-label={`Remove ${d?.name || k}`}
                className={`inline-flex items-center gap-1 rounded-full bg-slate-800 text-white font-semibold disabled:opacity-50 ${chipCls}`}
                data-draft-driver-chip={k}>
                <span className="truncate max-w-[12rem]">{d?.name || k}</span>
                <span aria-hidden="true">×</span>
              </button>
            );
          })}
        </div>
      )}

      <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)}
        disabled={disabled || drivers === null}
        placeholder="Find a driver or a route…" aria-label="Find a driver or a route"
        className={`w-full border rounded ${isMobile ? 'p-2 text-[16px]' : 'p-1.5 text-[12px]'}`}
        data-draft-driver-search />

      {drivers === null && loading && (
        <div className="text-[11px] text-slate-500" data-draft-driver-state="loading">Loading the drivers…</div>
      )}
      {error && (
        <div className="text-[11px] text-red-600 flex items-center gap-2 flex-wrap" data-draft-driver-state="error">
          <span>Could not load the driver list: {error}</span>
          {onRetry && (
            <button type="button" onClick={onRetry}
              className={`rounded border border-red-300 bg-white font-semibold text-red-700 ${isMobile ? 'min-h-[44px] px-3' : 'px-1.5 py-0.5'}`}>
              Try again
            </button>
          )}
        </div>
      )}
      {drivers !== null && !list.length && !error && (
        <div className="text-[11px] text-slate-500" data-draft-driver-state="empty">
          No driver ran a route in the {windowDays} days before {dateLabel || 'this day'}, so the engine has nobody on its roster to draft.
        </div>
      )}

      {list.length > 0 && (
        <>
          <ul aria-label="Drivers to draft"
            className={`border rounded bg-white divide-y divide-slate-100 overflow-y-auto ${isMobile ? 'max-h-[30vh]' : 'max-h-56'}`}>
            {shown.map((d) => {
              const on = picked.includes(d.key);
              const blocked = !on && full;
              return (
                <li key={d.key}>
                  <button type="button" aria-pressed={on} disabled={disabled || blocked} onClick={() => onToggle?.(d.key)}
                    title={blocked ? `A draft takes up to ${DRAFT_MAX_DRIVERS} drivers — take one off to add ${d.name}`
                      : [d.name, d.userName && d.userName !== d.name ? d.userName : null, d.routes?.length ? `runs ${d.routes.join(' · ')}` : null].filter(Boolean).join(' — ')}
                    className={`w-full text-left flex items-start gap-2 disabled:opacity-40 ${rowCls} ${on ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}
                    data-draft-driver-row={d.key} data-draft-driver-on={on ? '1' : '0'}>
                    <span aria-hidden="true"
                      className={`mt-0.5 shrink-0 inline-flex items-center justify-center rounded border ${isMobile ? 'w-5 h-5' : 'w-3.5 h-3.5'} ${on ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-400 bg-white'}`}>
                      {on ? '✓' : ''}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="font-semibold truncate">{d.name}</span>
                        {d.userName && d.userName !== d.name && <span className="text-slate-400 truncate">{d.userName}</span>}
                        <span className={`ml-auto shrink-0 rounded px-1 text-[10px] font-semibold ${d.truckClass === 'tractor' ? 'bg-sky-100 text-sky-800' : 'bg-slate-100 text-slate-700'}`}>
                          {draftDriverClassLabel(d.truckClass)}
                        </span>
                      </span>
                      <span className="block text-[10px] text-slate-500 truncate">
                        {d.routes?.length ? <>Runs <b className="text-slate-700">{d.routes.join(' · ')}</b> · </> : null}
                        {d.days} day{d.days === 1 ? '' : 's'}{d.lastDate ? `, last ${shortDay(d.lastDate)}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {!shown.length && (
              <li className="px-2 py-2 text-[11px] text-slate-500" data-draft-driver-state="no-match">No driver or route matches “{query}”.</li>
            )}
          </ul>
          <div className="text-[10px] text-slate-500">
            {full
              ? `${DRAFT_MAX_DRIVERS} picked — the most one draft takes.`
              : `${list.length} driver${list.length === 1 ? '' : 's'} ran a route in the ${windowDays} days before ${dateLabel || 'this day'}. Pick up to ${DRAFT_MAX_DRIVERS}.`}
          </div>
        </>
      )}
    </div>
  );
}
