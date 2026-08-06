// AssignScreen.jsx — handing the night's trucks out.
//
// This happens once, at 8pm, standing up, on a phone, with people waiting. The
// whole interaction is therefore: pick a person, then tap the trucks that are
// theirs. Not a form, not a modal per truck, no save button per row.
//
// ── WHY "PICK PERSON, THEN TAP TRUCKS" ───────────────────────────────────────
//
// The alternative — open each truck and choose a loader — costs one navigation
// per truck, and a shift is twenty-odd trucks. Selecting the person once and
// then running down the list is one tap per truck, which is the actual shape of
// the job: "Ana, you've got these five."
//
// Two people can share a truck, and one person can hold many. Tapping a truck
// already assigned to the selected person removes them from it; it does not
// wipe the other loader.
//
// ── ASSIGNMENT STEERS, IT DOES NOT GATE ──────────────────────────────────────
//
// Nothing here can stop a truck being loaded. A loader with no assignments still
// sees the whole board, and a truck that has to go out at 3am must never be
// un-loadable because nobody handed it out. The assignment exists so the app can
// open on "your trucks" and so the report can say "handed out, never started".

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Check, UserCheck } from 'lucide-react';

import * as api from './lib/api.js';
import { shiftDayString, shiftLabel, addDays } from './lib/shift.js';

export default function AssignScreen({ session, loads = [], people = [] }) {
  const [shiftDay, setShiftDay] = useState(shiftDayString());
  const [assignments, setAssignments] = useState({});
  const [selected, setSelected] = useState(null); // the loader being handed trucks
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.fetchAssignments(session.token, shiftDay);
      setAssignments(res?.assignments ?? {});
    } catch (e) {
      setError(e.message || 'Could not load assignments');
    }
    setBusy(false);
  }, [session.token, shiftDay]);

  useEffect(() => {
    load();
  }, [load]);

  // Anyone who can load: loaders and drivers both do. Dispatchers are excluded
  // from the pick-list because handing a truck to the admin account records the
  // wrong person as having loaded it.
  const crew = useMemo(
    () => people.filter((p) => p.role === 'loader' || p.role === 'driver').filter((p) => p.active !== false),
    [people],
  );

  const countFor = useCallback(
    (driverNumber) =>
      Object.values(assignments).filter((a) => (a.loaders || []).includes(String(driverNumber))).length,
    [assignments],
  );

  async function toggle(loadNbr) {
    if (!selected) {
      setError('Pick who you are assigning to first.');
      return;
    }
    const current = assignments[loadNbr]?.loaders ?? [];
    const me = String(selected.driverNumber);
    const next = current.includes(me) ? current.filter((l) => l !== me) : [...current, me];

    // Optimistic: the dispatcher is tapping down a list and must not wait for a
    // round trip between taps. A failed write is rolled back and surfaced.
    const before = assignments;
    const optimistic = { ...assignments };
    if (next.length) {
      optimistic[loadNbr] = { loadNbr, loaders: next, assignedBy: session.driverNumber, assignedAt: new Date().toISOString() };
    } else {
      delete optimistic[loadNbr];
    }
    setAssignments(optimistic);
    setSaving(loadNbr);

    try {
      const res = await api.setAssignments(session.token, shiftDay, [{ loadNbr, loaders: next }]);
      setAssignments(res?.assignments ?? optimistic);
      setError('');
    } catch (e) {
      setAssignments(before);
      setError(`Could not save ${loadNbr}: ${e.message}`);
    }
    setSaving('');
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-white ring-1 ring-slate-200 px-3 py-2 flex items-center gap-2">
        <button type="button" className="rounded-lg ring-1 ring-slate-300 px-2 py-1 text-sm" onClick={() => setShiftDay(addDays(shiftDay, -1))}>
          ‹
        </button>
        <div className="flex-1 text-center">
          <div className="text-sm font-semibold text-slate-900">{shiftLabel(shiftDay)}</div>
          <div className="text-[11px] text-slate-500">
            {Object.keys(assignments).length} of {loads.length} trucks assigned
          </div>
        </div>
        <button type="button" className="rounded-lg ring-1 ring-slate-300 px-2 py-1 text-sm" onClick={() => setShiftDay(addDays(shiftDay, 1))}>
          ›
        </button>
        <button type="button" onClick={load} className="rounded-lg ring-1 ring-slate-300 px-2 py-1" disabled={busy}>
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error ? (
        <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-800">{error}</div>
      ) : null}

      {/* ── Step 1: who ─────────────────────────────────────────────────── */}
      <div className="space-y-1">
        <div className="text-xs font-semibold text-slate-700">1 · Who are you assigning to?</div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {crew.map((p) => {
            const on = selected?.driverNumber === p.driverNumber;
            const n = countFor(p.driverNumber);
            return (
              <button
                key={p.driverNumber}
                type="button"
                onClick={() => setSelected(on ? null : p)}
                className={`shrink-0 rounded-lg px-3 py-2 text-sm ring-1 ${
                  on ? 'bg-[#1e5b92] text-white ring-[#1e5b92]' : 'bg-white ring-slate-300 text-slate-700'
                }`}
              >
                <div className="font-medium whitespace-nowrap">{p.displayName || p.driverNumber}</div>
                <div className={`text-[11px] ${on ? 'text-white/80' : 'text-slate-500'}`}>
                  {p.role} · {n} truck{n === 1 ? '' : 's'}
                </div>
              </button>
            );
          })}
          {!crew.length ? <div className="text-sm text-slate-500 py-2">No loaders or drivers set up yet.</div> : null}
        </div>
      </div>

      {/* ── Step 2: which trucks ────────────────────────────────────────── */}
      <div className="space-y-1">
        <div className="text-xs font-semibold text-slate-700">
          2 · Tap the trucks {selected ? `for ${selected.displayName || selected.driverNumber}` : ''}
        </div>
        {!selected ? (
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 px-3 py-3 text-sm text-slate-600">
            Pick a person above, then tap their trucks. Tap again to take one back.
          </div>
        ) : null}

        <div className="rounded-xl bg-white ring-1 ring-slate-200 divide-y divide-slate-100 max-h-[28rem] overflow-y-auto">
          {loads.map((l) => {
            const holders = assignments[l.loadNbr]?.loaders ?? [];
            const mine = selected && holders.includes(String(selected.driverNumber));
            const others = holders.filter((h) => !selected || h !== String(selected.driverNumber));
            return (
              <button
                key={l.loadNbr}
                type="button"
                onClick={() => toggle(l.loadNbr)}
                disabled={!selected || saving === l.loadNbr}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 ${mine ? 'bg-emerald-50' : ''} ${
                  !selected ? 'opacity-60' : ''
                }`}
              >
                <div
                  className={`w-5 h-5 rounded shrink-0 ring-1 flex items-center justify-center ${
                    mine ? 'bg-emerald-600 ring-emerald-600' : 'bg-white ring-slate-300'
                  }`}
                >
                  {mine ? <Check className="w-3.5 h-3.5 text-white" /> : null}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-900 truncate">
                    {l.loadNbr}
                    {l.routeName ? <span className="text-xs text-slate-500 ml-1">{l.routeName}</span> : null}
                  </div>
                  <div className="text-xs text-slate-500">
                    {l.stopCount ?? l.stops?.length ?? 0} stops · {l.expectedPieces ?? 0} pieces
                    {others.length ? (
                      <span className="text-[#1e5b92]">
                        {' '}
                        · also {others.map((o) => people.find((p) => String(p.driverNumber) === o)?.displayName || o).join(', ')}
                      </span>
                    ) : null}
                  </div>
                </div>
                {holders.length && !mine ? <UserCheck className="w-4 h-4 text-slate-400 shrink-0" /> : null}
              </button>
            );
          })}
          {!loads.length ? (
            <div className="px-3 py-4 text-sm text-slate-500 text-center">No trucks on the board for this day.</div>
          ) : null}
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Assigning steers the app — a loader opens on their own trucks. It never blocks anyone: an unassigned truck can
        still be loaded by anybody.
      </p>
    </div>
  );
}
