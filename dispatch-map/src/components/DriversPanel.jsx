// DriversPanel.jsx — driver login administration for the dock scanner.
//
// Every call goes through /.netlify/functions/loadscan-admin, a server-side proxy
// on this site that forwards to the load-scan credential endpoints. Nothing about
// the credential store is duplicated here: PIN hashing, lockout and alias
// resolution all stay in load-scan.
//
// dispatch-map has no login of its own, so this panel signs in against load-scan
// with a dispatcher number and PIN. That token is what authorizes every action —
// without it the proxy refuses, which is what stops a publicly reachable page from
// being an open credential-issuing hole.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { X, RefreshCw, KeyRound, Plus, Trash2, AlertTriangle, Search } from 'lucide-react';
import { useSortable, SortableTh } from '../lib/useSortable.jsx';

const PROXY = '/.netlify/functions/loadscan-admin';
const TOKEN_KEY = 'dispatchmap.loadscanAdmin.v1';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** House format: "Jul 29, 2026". Never ISO, never bare numeric. */
function fmtDate(v) {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function fmtDateTime(v) {
  const d = fmtDate(v);
  if (!d) return '';
  const t = new Date(String(v));
  if (Number.isNaN(t.getTime())) return d;
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(t);
  return `${d} ${s.replace(/\s?AM$/i, 'a').replace(/\s?PM$/i, 'p')}`;
}

async function callProxy(target, { method = 'GET', token, body, query = {} } = {}) {
  const qs = new URLSearchParams({ target, ...query });
  const res = await fetch(`${PROXY}?${qs}`, {
    method,
    cache: 'no-store',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new Error(`loadscan-admin returned ${type || 'no content-type'} (HTTP ${res.status})`);
  }
  const json = await res.json();
  if (!res.ok || json?.ok === false) {
    const err = new Error(json?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ── Sign-in ──────────────────────────────────────────────────────────────────

function SignIn({ onToken }) {
  const [driverNumber, setDriverNumber] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await callProxy('driver-login', { method: 'POST', body: { driverNumber: driverNumber.trim(), pin } });
      if (r.role !== 'dispatcher') {
        setErr('That login is a driver, not a dispatcher.');
        return;
      }
      onToken(r.token, r.displayName);
    } catch (e2) {
      setErr(e2.message === 'invalid_credentials' ? 'Number or PIN is not right.' : e2.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="p-4 space-y-3 max-w-xs">
      <p className="text-sm text-slate-600">Sign in with your dispatcher login for the dock scanner.</p>
      <input
        value={driverNumber}
        onChange={(e) => setDriverNumber(e.target.value)}
        placeholder="Dispatcher number"
        inputMode="numeric"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <input
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        placeholder="PIN"
        type="password"
        inputMode="numeric"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      {err ? <div className="text-sm text-rose-700">{err}</div> : null}
      <button
        type="submit"
        disabled={busy || !driverNumber || !pin}
        className="w-full rounded-lg bg-[#1e5b92] text-white px-3 py-2 text-sm disabled:opacity-50"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

// ── Alias editor ─────────────────────────────────────────────────────────────

function AliasEditor({ aliases, onChange }) {
  const [draft, setDraft] = useState('');
  const add = (v) => {
    const norm = String(v || '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (norm && !aliases.includes(norm)) onChange([...aliases, norm]);
    setDraft('');
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {aliases.length === 0 ? (
          <span className="text-xs text-rose-600">
            none — this driver will be UNRESOLVED and cannot see a load
          </span>
        ) : null}
        {aliases.map((a) => (
          <span key={a} className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-xs font-mono">
            {a}
            <button type="button" onClick={() => onChange(aliases.filter((x) => x !== a))} aria-label={`Remove ${a}`}>
              <Trash2 size={11} className="text-slate-500 hover:text-rose-600" />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder="Add a NuVizz spelling"
          className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs font-mono"
        />
        <button type="button" onClick={() => add(draft)} className="rounded border border-slate-300 px-2 py-1 text-xs">
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

export default function DriversPanel({ onClose }) {
  const [token, setToken] = useState(() => {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  });
  const [who, setWho] = useState('');
  const [drivers, setDrivers] = useState([]);
  const [ambiguous, setAmbiguous] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [report, setReport] = useState(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // { driverNumber, displayName, nuvizzAliases, isNew }
  const [pinFor, setPinFor] = useState(null);
  const [pinValue, setPinValue] = useState('');

  const saveToken = (t, name) => {
    try {
      sessionStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* session-only storage is a nicety, not a requirement */
    }
    setToken(t);
    setWho(name || '');
  };

  const reload = useCallback(async () => {
    if (!token) return;
    setErr('');
    try {
      const [a, b] = await Promise.all([
        callProxy('driver-admin', { token, query: { action: 'list' } }),
        callProxy('driver-admin', { token, query: { action: 'unmatched' } }),
      ]);
      setDrivers((a.drivers || []).map((d) => ({ ...d, aliasCount: (d.nuvizzAliases || []).length })));
      setAmbiguous(a.ambiguousAliases || []);
      setUnmatched(b.unmatched || []);
    } catch (e) {
      if (e.status === 401) {
        setToken('');
        return;
      }
      setErr(e.message);
    }
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function act(body) {
    setBusy(true);
    setErr('');
    try {
      await callProxy('driver-admin', { method: 'POST', token, body });
      await reload();
      return true;
    } catch (e) {
      setErr(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function pullReport(days = 14) {
    setReportBusy(true);
    setErr('');
    try {
      setReport(await callProxy('driver-alias-report', { token, query: { days: String(days) } }));
    } catch (e) {
      setErr(e.message);
    } finally {
      setReportBusy(false);
    }
  }

  const { sorted, sortKey, sortDir, toggle } = useSortable(drivers, 'driverNumber', 'asc');

  // Unclaimed aliases, for click-to-claim while an editor is open.
  const unclaimed = useMemo(
    () => (report?.rows || []).filter((r) => r.needsMapping),
    [report],
  );

  if (!token) {
    return (
      <Shell onClose={onClose} title="Dock scanner drivers">
        <SignIn onToken={saveToken} />
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose} title="Dock scanner drivers" subtitle={who ? `signed in as ${who}` : ''}>
      <div className="p-3 space-y-4 overflow-y-auto">
        {err ? <div className="rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-sm text-rose-800">{err}</div> : null}

        {ambiguous.length ? (
          <div className="rounded-lg bg-amber-50 ring-1 ring-amber-300 px-3 py-2 text-sm">
            <div className="font-medium flex items-center gap-1 text-amber-900">
              <AlertTriangle size={14} /> Alias claimed by more than one driver
            </div>
            {ambiguous.map((a) => (
              <div key={a.alias} className="text-xs text-amber-900">
                <span className="font-mono">{a.alias}</span> → {a.driverNumbers.join(', ')} · both will be UNRESOLVED
              </div>
            ))}
          </div>
        ) : null}

        {/* Drivers */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-sm font-semibold text-slate-700">{drivers.length} logins</div>
            <div className="flex gap-2">
              <button type="button" onClick={reload} className="text-xs underline inline-flex items-center gap-1">
                <RefreshCw size={11} /> refresh
              </button>
              <button
                type="button"
                onClick={() => setEditing({ driverNumber: '', displayName: '', nuvizzAliases: [], isNew: true })}
                className="text-xs underline"
              >
                add driver
              </button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200">
            <table className="min-w-full text-sm bg-white">
              <thead className="bg-slate-50">
                <tr>
                  <SortableTh label="Driver #" k="driverNumber" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Name" k="displayName" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Aliases" k="aliasCount" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Role" k="role" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Active" k="active" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Last login" k="lastLoginAt" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                  <th className="px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => (
                  <tr key={d.driverNumber} className="border-t border-slate-100 align-top">
                    <td className="px-2 py-2 font-mono">{d.driverNumber}</td>
                    <td className="px-2 py-2">{d.displayName || '—'}</td>
                    <td className="px-2 py-2 text-xs font-mono">
                      {d.nuvizzAliases.join(', ') || <span className="text-rose-600 font-sans">none</span>}
                    </td>
                    <td className="px-2 py-2 text-xs">{d.role}</td>
                    <td className="px-2 py-2 text-xs">
                      {d.active ? <span className="text-emerald-700">yes</span> : <span className="text-rose-700">no</span>}
                      {d.lockedUntil ? <div className="text-amber-700">locked</div> : null}
                      {!d.hasPin ? <div className="text-slate-400">no PIN</div> : null}
                      {d.mustChangePin ? <div className="text-slate-400">temp PIN</div> : null}
                    </td>
                    <td className="px-2 py-2 text-xs">{d.lastLoginAt ? fmtDateTime(d.lastLoginAt) : '—'}</td>
                    <td className="px-2 py-2 text-right text-xs whitespace-nowrap space-x-2">
                      <button type="button" className="underline" onClick={() => setEditing({ ...d, isNew: false })}>edit</button>
                      <button type="button" className="underline" onClick={() => { setPinFor(d.driverNumber); setPinValue(''); }}>
                        PIN
                      </button>
                      <button
                        type="button"
                        className="underline"
                        disabled={busy}
                        onClick={() => act({ action: 'set-active', driverNumber: d.driverNumber, active: !d.active })}
                      >
                        {d.active ? 'deactivate' : 'reactivate'}
                      </button>
                      {d.lockedUntil ? (
                        <button
                          type="button"
                          className="underline"
                          disabled={busy}
                          onClick={() => act({ action: 'clear-lockout', driverNumber: d.driverNumber })}
                        >
                          unlock
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Temp PIN */}
        {pinFor ? (
          <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2 space-y-2">
            <div className="text-sm font-medium flex items-center gap-1">
              <KeyRound size={13} /> Temporary PIN for {pinFor}
            </div>
            <p className="text-xs text-slate-600">
              4 to 6 digits. The driver is forced to change it at first sign-in.
            </p>
            <div className="flex gap-2">
              <input
                value={pinValue}
                onChange={(e) => setPinValue(e.target.value)}
                inputMode="numeric"
                className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
              />
              <button
                type="button"
                disabled={busy || !/^\d{4,6}$/.test(pinValue)}
                onClick={async () => {
                  if (await act({ action: 'issue-pin', driverNumber: pinFor, pin: pinValue })) {
                    setPinFor(null);
                    setPinValue('');
                  }
                }}
                className="rounded bg-[#1e5b92] text-white px-3 py-1 text-sm disabled:opacity-50"
              >
                Issue
              </button>
              <button type="button" onClick={() => setPinFor(null)} className="text-xs underline">cancel</button>
            </div>
          </div>
        ) : null}

        {/* Editor */}
        {editing ? (
          <div className="rounded-lg bg-white ring-1 ring-slate-300 px-3 py-3 space-y-2">
            <div className="text-sm font-semibold">
              {editing.isNew ? 'Add a driver login' : `Edit ${editing.driverNumber}`}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={editing.driverNumber}
                onChange={(e) => setEditing({ ...editing, driverNumber: e.target.value })}
                disabled={!editing.isNew}
                placeholder="Driver number"
                className="rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50"
              />
              <input
                value={editing.displayName}
                onChange={(e) => setEditing({ ...editing, displayName: e.target.value })}
                placeholder="Display name"
                className="rounded border border-slate-300 px-2 py-1 text-sm"
              />
            </div>
            <div>
              <div className="text-xs text-slate-600 mb-1">
                NuVizz aliases — every spelling that appears for this person
              </div>
              <AliasEditor
                aliases={editing.nuvizzAliases || []}
                onChange={(nuvizzAliases) => setEditing({ ...editing, nuvizzAliases })}
              />
            </div>

            {unclaimed.length ? (
              <div>
                <div className="text-xs text-slate-600 mb-1">
                  Unclaimed on the board — click to add rather than typing
                </div>
                <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                  {unclaimed.map((r) => (
                    <button
                      key={r.alias}
                      type="button"
                      onClick={() =>
                        setEditing({
                          ...editing,
                          nuvizzAliases: [...new Set([...(editing.nuvizzAliases || []), r.alias])],
                        })
                      }
                      className="rounded bg-sky-50 ring-1 ring-sky-200 px-2 py-0.5 text-xs font-mono hover:bg-sky-100"
                      title={`${r.stops} stops · ${r.looksLike} · last seen ${fmtDate(r.lastSeen)}`}
                    >
                      + {r.alias}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={busy || !String(editing.driverNumber).trim()}
                onClick={async () => {
                  const okDone = await act({
                    action: 'upsert',
                    driverNumber: String(editing.driverNumber).trim(),
                    displayName: editing.displayName,
                    nuvizzAliases: editing.nuvizzAliases || [],
                  });
                  if (okDone) setEditing(null);
                }}
                className="rounded bg-[#1e5b92] text-white px-3 py-1 text-sm disabled:opacity-50"
              >
                Save
              </button>
              <button type="button" onClick={() => setEditing(null)} className="text-xs underline">cancel</button>
            </div>
          </div>
        ) : null}

        {/* Unmatched review queue */}
        {unmatched.length ? (
          <div>
            <div className="text-sm font-semibold text-slate-700 mb-1">
              Sign-ins that could not be matched ({unmatched.length})
            </div>
            <div className="space-y-2">
              {unmatched.map((u) => {
                const id = `${u.date}__${u.driverNumber}`;
                return (
                  <div key={id} className="rounded-lg bg-amber-50 ring-1 ring-amber-200 px-3 py-2 text-xs">
                    <div className="font-medium text-sm">
                      {u.displayName || u.driverNumber} · {fmtDate(u.date)}
                    </div>
                    <div className="text-slate-700 mt-1">
                      Their aliases: <span className="font-mono">{(u.seededAliases || []).join(', ') || 'none'}</span>
                    </div>
                    <div className="text-slate-700">
                      On the board that day:{' '}
                      <span className="font-mono">{(u.boardAliases || []).slice(0, 14).join(', ')}</span>
                      {(u.boardAliases || []).length > 14 ? ' …' : ''}
                    </div>
                    <button type="button" className="mt-1 underline" disabled={busy}
                      onClick={() => act({ action: 'resolve-unmatched', id })}>
                      mark reviewed
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Alias report */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-sm font-semibold text-slate-700">NuVizz aliases on the board</div>
            <div className="flex gap-2 text-xs">
              {[14, 30].map((d) => (
                <button key={d} type="button" onClick={() => pullReport(d)} disabled={reportBusy} className="underline">
                  {reportBusy ? '…' : `last ${d} days`}
                </button>
              ))}
            </div>
          </div>
          {!report ? (
            <p className="text-xs text-slate-500 inline-flex items-center gap-1">
              <Search size={11} /> Pull the report to see which NuVizz names are not yet mapped to a driver login.
            </p>
          ) : (
            <>
              <div className="text-xs text-slate-600 mb-1">
                {report.distinctAliases} distinct · {report.needsMapping} unmapped · read{' '}
                {report.window?.daysRead?.length || 0} days from {fmtDate(report.window?.anchor)}
              </div>
              <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200 max-h-72 overflow-y-auto">
                <AliasReportTable rows={report.rows || []} />
              </div>
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}

function AliasReportTable({ rows }) {
  const { sorted, sortKey, sortDir, toggle } = useSortable(rows, 'stops', 'desc');
  return (
    <table className="min-w-full text-sm bg-white">
      <thead className="bg-slate-50 sticky top-0">
        <tr>
          <SortableTh label="Alias" k="alias" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <SortableTh label="Looks like" k="looksLike" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <SortableTh label="Stops" k="stops" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <SortableTh label="Last seen" k="lastSeen" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
          <SortableTh label="Mapped to" k="needsMapping" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.alias} className={`border-t border-slate-100 ${r.needsMapping ? 'bg-amber-50/60' : ''}`}>
            <td className="px-2 py-1 font-mono">{r.alias}</td>
            <td className="px-2 py-1 text-xs text-slate-600">{String(r.looksLike).replace(/_/g, ' ')}</td>
            <td className="px-2 py-1 tabular-nums">{r.stops}</td>
            <td className="px-2 py-1 text-xs">{fmtDate(r.lastSeen)}</td>
            <td className="px-2 py-1 text-xs">
              {r.needsMapping ? <span className="text-amber-800">not mapped</span> : r.claimedBy.join(', ')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Shell({ title, subtitle, children, onClose }) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[92vh] flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-900">{title}</div>
            {subtitle ? <div className="text-xs text-slate-500">{subtitle}</div> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1">
            <X size={18} className="text-slate-500" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
