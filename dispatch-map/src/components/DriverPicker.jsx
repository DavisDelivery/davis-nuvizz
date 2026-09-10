// components/DriverPicker.jsx
//
// THE DRIVER CONTROL IS A SEARCH BAR AND A DROPDOWN — Chad: "i want this to be a search bar as
// well as a drop down." Davis runs ~59 drivers, so the native <select> it replaces was a
// 59-item scroll to reach FRYE, and on a phone an OS wheel with no way to type at all.
//
// AND a dropdown, not instead of: the list is one tap away with an empty box, because a
// dispatcher who does not remember a name still needs to browse for it. Typing only ever
// narrows what is already on screen.
//
// THE LIST OPENS IN FLOW, NOT AS AN ABSOLUTE OVERLAY, and that is deliberate. This control
// sits in the route-card footer — inside a scrolling flex column with a shrink-0 footer — so
// an absolutely-positioned menu would be clipped by the card, and CLAUDE.md's phone rule is
// explicit that overlay furniture pinned at measured offsets is how this app put the draw
// buttons on top of the status card. In flow, the card simply grows and what is below it
// moves; the list caps its own height and scrolls. One behaviour on both views, and nothing
// for the overlap guard to find.
import { useEffect, useMemo, useRef, useState } from 'react';
import { filterDrivers, driverLabel, driverById, nextHighlight } from '../lib/driver-filter.js';

export default function DriverPicker({
  roster = [],
  value = '',
  onChange,
  disabled = false,
  placeholder = 'Assign driver…',
  emptyLabel = 'No driver',
  ariaLabel = 'Assign driver',
  compact = false,
  id,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(-1);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const reactId = useRef(`drvpick-${Math.random().toString(36).slice(2, 9)}`).current;
  const baseId = id || reactId;

  const selected = useMemo(() => driverById(roster, value), [roster, value]);
  const matches = useMemo(() => filterDrivers(roster, query), [roster, query]);

  // Close when the pointer goes anywhere else. A driver assignment left half-open over the
  // map is the kind of thing that gets clicked through by accident.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  // Keep the highlighted row visible while arrowing through 59 names.
  useEffect(() => {
    if (!open || hi < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${hi}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const commit = (d) => {
    // d === null is the deliberate "no driver" row, which is what UN-assigning is. It must
    // stay reachable: a route assigned by mistake has to be clearable without a page reload.
    onChange?.(d ? String(d.driverId) : '');
    setQuery('');
    setHi(-1);
    setOpen(false);
  };

  const openList = () => {
    if (disabled) return;
    setQuery('');
    setHi(-1);
    setOpen(true);
  };

  const onKeyDown = (e) => {
    if (disabled) return;
    if (e.key === 'Escape') { setOpen(false); setQuery(''); setHi(-1); return; }
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { openList(); e.preventDefault(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setHi((h) => nextHighlight(h, e.key === 'ArrowDown' ? 1 : -1, matches.length));
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter with nothing highlighted takes the ONLY match — typing "frye" and pressing
      // Enter should assign Frye — but never guesses when the search is still ambiguous.
      if (hi >= 0 && hi < matches.length) commit(matches[hi]);
      else if (matches.length === 1) commit(matches[0]);
    }
  };

  const pad = compact ? 'px-1 py-1 text-[11px]' : 'px-2 py-1.5 text-sm';
  const rowPad = compact ? 'px-2 py-1.5 text-[11px]' : 'px-2 py-2 text-sm';

  return (
    <div ref={wrapRef} className="relative flex-1 min-w-0">
      <input
        ref={inputRef}
        id={baseId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${baseId}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && hi >= 0 ? `${baseId}-opt-${hi}` : undefined}
        aria-label={ariaLabel}
        autoComplete="off"
        disabled={disabled}
        // CLOSED, the box shows WHO IS ASSIGNED, not a search term — the control has to answer
        // "who is on this truck?" at a glance, which is what it is looked at for most of the day.
        value={open ? query : driverLabel(selected)}
        placeholder={disabled ? placeholder : (selected ? driverLabel(selected) : placeholder)}
        onChange={(e) => { setQuery(e.target.value); setHi(-1); if (!open) setOpen(true); }}
        onFocus={openList}
        onKeyDown={onKeyDown}
        className={`tap-target-y w-full min-w-0 border rounded bg-white ${pad} ${disabled ? 'text-slate-400' : ''}`}
      />
      {open && (
        <div
          ref={listRef}
          id={`${baseId}-list`}
          role="listbox"
          aria-label={ariaLabel}
          className="mt-0.5 max-h-[40vh] overflow-y-auto border border-slate-300 rounded bg-white shadow-sm"
        >
          <button
            type="button"
            role="option"
            aria-selected={!selected}
            data-idx="-1"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commit(null)}
            className={`tap-target-y w-full text-left ${rowPad} text-slate-500 italic hover:bg-slate-100 border-b border-slate-100`}
          >
            {emptyLabel}
          </button>
          {matches.map((d, i) => {
            const isSel = selected && String(selected.driverId) === String(d.driverId);
            return (
              <button
                key={String(d.driverId)}
                type="button"
                role="option"
                id={`${baseId}-opt-${i}`}
                data-idx={i}
                aria-selected={!!isSel}
                onMouseDown={(e) => e.preventDefault()}   // keep focus so blur can't beat the click
                onClick={() => commit(d)}
                onMouseEnter={() => setHi(i)}
                className={`tap-target-y w-full text-left ${rowPad} ${i === hi ? 'bg-blue-50' : 'hover:bg-slate-50'} ${isSel ? 'font-semibold text-blue-700' : 'text-slate-800'}`}
              >
                {driverLabel(d)}
              </button>
            );
          })}
          {matches.length === 0 && (
            // Says the QUERY back. "No driver matches 'fyre'" is a typo a dispatcher can see;
            // a bare "no results" leaves them wondering whether the roster failed to load.
            <div className={`${rowPad} text-slate-500`}>No driver matches “{query}”</div>
          )}
        </div>
      )}
    </div>
  );
}
