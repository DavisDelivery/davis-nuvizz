// ReportScreen.jsx — the admin's account of a shift.
//
// Two readers, one screen:
//
//   the logistics manager  opens it at 6am and wants to know, in five seconds,
//                          whether the night went well and who is stuck
//   the data analyst       wants the same rows as CSV, at a grain they can group
//
// So the layout goes headline -> exceptions -> people -> trucks. Exceptions come
// BEFORE the roster on purpose: a truck that was handed out and never opened is
// the single most expensive thing on this screen, and it must not be something
// you scroll to find.
//
// ── SHOWING WHAT DID NOT HAPPEN ──────────────────────────────────────────────
//
// The hardest thing to render honestly is an absence. "Assigned, never started"
// and "loaded without the app" have no rows of their own in any data store —
// they are the gap between the board and the worklog. They are given their own
// blocks and their own colour so they read as findings rather than as empty
// tables.
//
// ── DURATIONS THAT ARE NOT MEASUREMENTS ──────────────────────────────────────
//
// A duration inferred from scan timestamps cannot see the time before the first
// successful scan, so it is a FLOOR. Those rows are marked "~". Averaging floors
// with real measurements understates the work, so the per-person summary also
// says how many of that person's trucks were actually measured.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Download, AlertTriangle, Clock, Package, Users } from 'lucide-react';

import * as api from './lib/api.js';
import { shiftDayString, shiftLabel, addDays, fmtMinutes, fmtClock } from './lib/shift.js';

function Stat({ icon: Icon, label, value, tone = 'slate' }) {
  const tones = {
    slate: 'text-slate-900',
    rose: 'text-rose-700',
    amber: 'text-amber-700',
    emerald: 'text-emerald-700',
  };
  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-200 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500">
        {Icon ? <Icon className="w-3.5 h-3.5" /> : null}
        {label}
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
    </div>
  );
}

function Section({ title, hint, children }) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

export default function ReportScreen({ session }) {
  const [shiftDay, setShiftDay] = useState(shiftDayString());
  const [days, setDays] = useState(1);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.workReport(session.token, { shiftDay, days });
      setData(res);
    } catch (e) {
      setError(e.message || 'Could not load the report');
    }
    setBusy(false);
  }, [session.token, shiftDay, days]);

  useEffect(() => {
    load();
  }, [load]);

  const reports = data?.reports ?? [];

  // Across the whole range, so a week view answers "how did the week go" without
  // the reader adding up five nights in their head.
  const totals = useMemo(() => {
    const t = { loads: 0, started: 0, complete: 0, pieces: 0, notStarted: 0, offApp: 0, minutes: 0, measured: 0, rows: 0 };
    for (const r of reports) {
      t.loads += r.totals.loads;
      t.started += r.totals.loadsStarted;
      t.complete += r.totals.loadsComplete;
      t.pieces += r.totals.pieces;
      t.notStarted += r.totals.assignedNotStarted;
      t.offApp += r.totals.workedWithoutApp;
      for (const row of r.rows) {
        if (row.minutes != null) {
          t.minutes += row.minutes;
          t.rows += 1;
        }
        if (row.timing === 'events') t.measured += 1;
      }
    }
    return t;
  }, [reports]);

  const csvHref = api.workReportCsvUrl({ shiftDay, days });

  return (
    <div className="space-y-4">
      {/* ── Which shift ─────────────────────────────────────────────────── */}
      <div className="rounded-xl bg-white ring-1 ring-slate-200 px-3 py-2 space-y-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg ring-1 ring-slate-300 px-2 py-1 text-sm"
            onClick={() => setShiftDay(addDays(shiftDay, -1))}
          >
            ‹ Earlier
          </button>
          <div className="flex-1 text-center">
            <div className="text-sm font-semibold text-slate-900">{shiftLabel(shiftDay)}</div>
            <div className="text-[11px] text-slate-500">shift day {shiftDay}</div>
          </div>
          <button
            type="button"
            className="rounded-lg ring-1 ring-slate-300 px-2 py-1 text-sm"
            onClick={() => setShiftDay(addDays(shiftDay, 1))}
          >
            Later ›
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs">
          {[1, 5, 7, 14].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setDays(n)}
              className={`rounded-lg px-2 py-1 ring-1 ${
                days === n ? 'bg-[#1e5b92] text-white ring-[#1e5b92]' : 'bg-white ring-slate-300 text-slate-600'
              }`}
            >
              {n === 1 ? 'This shift' : `${n} shifts`}
            </button>
          ))}
          <div className="flex-1" />
          <button type="button" onClick={load} className="rounded-lg ring-1 ring-slate-300 px-2 py-1" disabled={busy}>
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
          <a href={csvHref} className="rounded-lg ring-1 ring-slate-300 px-2 py-1 inline-flex items-center gap-1">
            <Download className="w-3.5 h-3.5" /> CSV
          </a>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-800">{error}</div>
      ) : null}

      {/* ── Headline ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        <Stat icon={Package} label="Loads worked" value={`${totals.started}/${totals.loads || '—'}`} />
        <Stat icon={Package} label="Pieces loaded" value={totals.pieces} />
        <Stat
          icon={Clock}
          label="Avg per load"
          value={totals.rows ? fmtMinutes(totals.minutes / totals.rows) : '—'}
        />
        <Stat
          icon={AlertTriangle}
          label="Never started"
          value={totals.notStarted}
          tone={totals.notStarted > 0 ? 'rose' : 'emerald'}
        />
      </div>

      {totals.rows > 0 && totals.measured < totals.rows ? (
        <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 px-3 py-2 text-xs text-slate-600">
          {totals.measured} of {totals.rows} durations were measured start-to-finish. The rest are marked{' '}
          <span className="font-mono">~</span> — inferred from scan times, so they are a floor and the real work took
          longer.
        </div>
      ) : null}

      {reports.map((rep) => (
        <div key={rep.shiftDay} className="space-y-3">
          {days > 1 ? (
            <div className="pt-2 border-t border-slate-200">
              <div className="text-sm font-semibold text-slate-900">{rep.label}</div>
              {!rep.scheduled ? (
                <div className="text-[11px] text-amber-700">Outside the normal Sun–Thu night shift pattern.</div>
              ) : null}
            </div>
          ) : null}

          {/* ── Exceptions first. This is the point of the screen. ───────── */}
          {rep.notStarted.length ? (
            <Section
              title={`Assigned but never started (${rep.notStarted.length})`}
              hint="Handed out to someone and never opened in the app. Nothing was recorded against these trucks."
            >
              <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 divide-y divide-rose-100">
                {rep.notStarted.map((n) => (
                  <div key={n.loadNbr} className="px-3 py-2 flex items-center gap-2 text-sm">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                    <span className="font-medium text-rose-900">{n.loadNbr}</span>
                    <span className="flex-1 text-rose-800 text-xs">
                      assigned to {n.assignedTo.join(', ') || 'nobody'}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          ) : null}

          {rep.offApp.length ? (
            <Section
              title={`Loaded without the app (${rep.offApp.length})`}
              hint="On the board, not assigned, and no work recorded. If the freight went out, it went out unscanned."
            >
              <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 divide-y divide-amber-100">
                {rep.offApp.slice(0, 25).map((o) => (
                  <div key={o.loadNbr} className="px-3 py-2 text-sm flex gap-2">
                    <span className="font-medium text-amber-900">{o.loadNbr}</span>
                    <span className="text-amber-800 text-xs flex-1">{o.reason}</span>
                  </div>
                ))}
                {rep.offApp.length > 25 ? (
                  <div className="px-3 py-2 text-xs text-amber-800">
                    +{rep.offApp.length - 25} more — use the CSV for the full list.
                  </div>
                ) : null}
              </div>
            </Section>
          ) : null}

          {/* ── People ──────────────────────────────────────────────────── */}
          <Section
            title={`People (${rep.workers.length})`}
            hint="Pieces per hour is the fair comparison — minutes per load just reflects which trucks they were given."
          >
            {rep.workers.length ? (
              <div className="rounded-xl bg-white ring-1 ring-slate-200 divide-y divide-slate-100">
                {rep.workers.map((w) => (
                  <div key={w.worker} className="px-3 py-2 space-y-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium text-slate-900 flex-1 truncate">{w.workerName || w.worker}</span>
                      <span className="text-[11px] uppercase tracking-wide text-slate-500">{w.role}</span>
                      <span className="font-mono text-sm tabular-nums">{w.loads} loads</span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-xs text-slate-600">
                      <div>
                        <div className="text-[10px] uppercase text-slate-400">Pieces</div>
                        <div className="tabular-nums">{w.pieces}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-slate-400">Per hour</div>
                        <div className="tabular-nums">{w.piecesPerHour ?? '—'}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-slate-400">Avg/load</div>
                        <div className="tabular-nums">
                          {w.measuredLoads < w.loads ? '~' : ''}
                          {fmtMinutes(w.avgMinutesPerLoad)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-slate-400">On shift</div>
                        <div className="tabular-nums">{fmtMinutes(w.spanMinutes)}</div>
                      </div>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {fmtClock(w.firstStart)} → {fmtClock(w.lastFinish)}
                      {w.spanMinutes != null && w.workingMinutes < w.spanMinutes ? (
                        <span> · {fmtMinutes(w.spanMinutes - w.workingMinutes)} between trucks</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl bg-white ring-1 ring-slate-200 px-3 py-4 text-sm text-slate-500 text-center">
                Nobody used the app on this shift.
              </div>
            )}
          </Section>

          {/* ── Trucks ──────────────────────────────────────────────────── */}
          <Section title={`Trucks (${rep.rows.length})`} hint="In the order they were started.">
            <div className="rounded-xl bg-white ring-1 ring-slate-200 divide-y divide-slate-100">
              {rep.rows.map((r) => (
                <div key={`${r.worker}-${r.loadNbr}`} className="px-3 py-2 space-y-0.5">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-slate-900">{r.loadNbr}</span>
                    {r.routeName ? <span className="text-xs text-slate-500">{r.routeName}</span> : null}
                    <span className="flex-1" />
                    <span
                      className={`text-[11px] px-1.5 py-0.5 rounded ${
                        r.status === 'complete'
                          ? 'bg-emerald-50 text-emerald-700'
                          : r.status === 'short'
                            ? 'bg-rose-50 text-rose-700'
                            : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {r.status === 'short' ? `short ${r.short}` : r.status.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="text-xs text-slate-600">
                    {r.workerName || r.worker} · {fmtClock(r.startedAt)} → {fmtClock(r.finishedAt)} ·{' '}
                    <span className="tabular-nums">
                      {r.timing === 'derived' ? '~' : ''}
                      {fmtMinutes(r.minutes)}
                    </span>
                    {' · '}
                    <span className="tabular-nums">
                      {r.pieces}/{r.expectedPieces || '?'} pcs
                    </span>
                    {r.piecesPerHour != null ? <span> · {r.piecesPerHour}/hr</span> : null}
                  </div>
                </div>
              ))}
              {!rep.rows.length ? (
                <div className="px-3 py-4 text-sm text-slate-500 text-center">No trucks worked on this shift.</div>
              ) : null}
            </div>
          </Section>
        </div>
      ))}

      {busy && !data ? <div className="text-center text-sm text-slate-500 py-6">Loading…</div> : null}
    </div>
  );
}
