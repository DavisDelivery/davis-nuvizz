import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PackageCheck, ScanLine, CheckCircle2, XCircle, AlertTriangle, RefreshCw, CloudOff,
  LogOut, Users, ClipboardList, Camera, KeyRound, ChevronRight,
} from 'lucide-react';

import { fmtDate, fmtDateTime, etToday } from './lib/fmt.js';
import { loadSession, saveSession, clearSession, daysRemaining } from './lib/session.js';
import * as api from './lib/api.js';
import * as store from './lib/offline.js';
import { startScanner } from './lib/scanner.js';
import { evaluateScan, loadProgress, stopProgress, ogGapHint, OUTCOME, normalizePro, createPairBuffer, loadOrder, loadGroupCount, deliverySeq, sequenceFingerprint } from './lib/scan-logic.js';
import { createWedgeAccumulator, WEDGE_PAIR_WINDOW_MS } from './lib/wedge.js';
import { initAudio, playVerdict } from './lib/feedback.js';
import { useSortable, SortableTh } from './lib/useSortable.jsx';
import { partitionBoardRows, filterCredentials } from './lib/roster.js';

// Bumped by hand on every change. load-scan versions independently of dispatch-map.
const APP_VERSION = '0.11.0';

const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
const BUILD_CONTEXT = typeof __BUILD_CONTEXT__ !== 'undefined' ? __BUILD_CONTEXT__ : 'dev';

// ── Shell ────────────────────────────────────────────────────────────────────

function Header({ title, subtitle, right }) {
  return (
    <div className="bg-[#1e5b92] px-4 py-3 text-white flex items-center gap-3 sticky top-0 z-20">
      <PackageCheck className="w-6 h-6 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h1 className="text-base font-semibold leading-tight truncate">{title}</h1>
        {subtitle ? <p className="text-xs text-white/70 leading-tight truncate">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}

function Banner({ kind, children }) {
  const tone = {
    info: 'bg-slate-50 ring-slate-200 text-slate-700',
    warn: 'bg-amber-50 ring-amber-300 text-amber-900',
    error: 'bg-rose-50 ring-rose-300 text-rose-900',
    good: 'bg-emerald-50 ring-emerald-300 text-emerald-900',
  }[kind || 'info'];
  return <div className={`rounded-xl px-3 py-2 text-sm ring-1 ${tone}`}>{children}</div>;
}

const BigButton = ({ children, onClick, disabled, tone = 'primary', type = 'button' }) => {
  const cls = {
    primary: 'bg-[#1e5b92] hover:bg-[#194b78] active:bg-[#153f64] text-white',
    ghost: 'bg-white ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50',
    danger: 'bg-rose-600 hover:bg-rose-700 text-white',
  }[tone];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      // 48px min target: gloves, 5am, one hand.
      className={`w-full rounded-xl px-4 py-3 text-base font-medium transition-colors disabled:opacity-50 ${cls}`}
    >
      {children}
    </button>
  );
};

// ── Login ────────────────────────────────────────────────────────────────────

function LoginScreen({ onLoggedIn }) {
  const [driverNumber, setDriverNumber] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e?.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await api.login(driverNumber.trim(), pin);
      onLoggedIn({
        token: r.token,
        driverNumber: r.driverNumber,
        displayName: r.displayName,
        role: r.role,
        mustChangePin: r.mustChangePin,
      });
    } catch (e2) {
      setErr(
        e2?.status === 423
          ? `Too many wrong PINs. Locked until ${fmtDateTime(e2.body?.lockedUntil)}. See dispatch.`
          : e2?.body?.error === 'inactive'
            ? 'This driver number is not active. See dispatch.'
            : e2?.offline
              ? 'No connection — the first sign-in needs signal. Try inside the building.'
              : 'That sign-in is not right. Use your driver number, or your name as it shows on the board, plus your PIN.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="p-4 space-y-4 max-w-sm mx-auto">
      <Banner kind="info">Sign in once. You stay signed in for 90 days, even with no signal.</Banner>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Driver number or name</span>
        <input
          value={driverNumber}
          onChange={(e) => setDriverNumber(e.target.value)}
          autoComplete="username"
          autoCapitalize="characters"
          className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-3 text-lg tracking-wide"
          placeholder="e.g. 4471 or MICHAEL FRYE"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">PIN</span>
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-3 text-lg tracking-widest"
          placeholder="••••"
        />
      </label>
      {err ? <Banner kind="error">{err}</Banner> : null}
      <BigButton type="submit" disabled={busy || !driverNumber || !pin}>
        {busy ? 'Signing in…' : 'Sign in'}
      </BigButton>
    </form>
  );
}

function ChangePinScreen({ session, onDone }) {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e?.preventDefault();
    setErr('');
    if (!/^\d{4,6}$/.test(newPin)) return setErr('New PIN must be 4 to 6 digits.');
    if (newPin !== again) return setErr('The two new PINs do not match.');
    if (newPin === currentPin) return setErr('Pick a PIN different from the temporary one.');
    setBusy(true);
    try {
      await api.changePin(session.token, currentPin, newPin);
      onDone();
    } catch (e2) {
      setErr(e2?.message || 'Could not change the PIN.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="p-4 space-y-4 max-w-sm mx-auto">
      <Banner kind="warn">
        <div className="flex gap-2">
          <KeyRound className="w-4 h-4 mt-0.5 shrink-0" />
          <span>You are on a temporary PIN. Choose your own before loading.</span>
        </div>
      </Banner>
      {[
        ['Temporary PIN', currentPin, setCurrentPin],
        ['New PIN', newPin, setNewPin],
        ['New PIN again', again, setAgain],
      ].map(([label, val, set]) => (
        <label key={label} className="block">
          <span className="text-sm font-medium text-slate-700">{label}</span>
          <input
            value={val}
            onChange={(e) => set(e.target.value)}
            type="password"
            inputMode="numeric"
            className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-3 text-lg tracking-widest"
          />
        </label>
      ))}
      {err ? <Banner kind="error">{err}</Banner> : null}
      <BigButton type="submit" disabled={busy}>{busy ? 'Saving…' : 'Set my PIN'}</BigButton>
    </form>
  );
}

// ── Load selection ───────────────────────────────────────────────────────────

function LoadPicker({ manifest, onPick, onManual, onRefresh, busy, loader }) {
  const [manual, setManual] = useState('');
  const loads = manifest?.loads || [];

  if (manifest?.unresolved) {
    return (
      <div className="p-4 space-y-4 max-w-sm mx-auto">
        <Banner kind="warn">
          <div className="font-medium">Could not confirm your load</div>
          <div className="mt-1">Enter your load number from the paperwork.</div>
        </Banner>
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          className="w-full rounded-xl border border-slate-300 px-4 py-3 text-lg"
          placeholder="Load number"
        />
        <BigButton onClick={() => onManual(manual.trim())} disabled={!manual.trim() || busy}>
          Load this manifest
        </BigButton>
        <p className="text-xs text-slate-500">
          Dispatch has been notified so your name can be linked to your loads. This entry is recorded.
        </p>
        <BigButton tone="ghost" onClick={onRefresh}>Try again</BigButton>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3 max-w-sm mx-auto">
      <div className="text-sm text-slate-600">
        {fmtDate(manifest?.date)} · {loader ? `pick the truck you are loading — ${loads.length} on the dock` : 'pick your load'}
      </div>
      {loads.map((l) => (
        <button
          key={l.loadNbr}
          type="button"
          disabled={busy}
          onClick={() => onPick(l.loadNbr)}
          className="w-full text-left rounded-xl bg-white ring-1 ring-slate-200 px-4 py-3 hover:bg-slate-50 disabled:opacity-50 flex items-center gap-3"
        >
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-900 truncate">{l.loadNbr}</div>
            {/* Whose truck: a dock identifies a trailer by its driver, not its load number. */}
            {l.driverName ? <div className="text-sm text-slate-700 truncate">{l.driverName}</div> : null}
            <div className="text-xs text-slate-500">
              {l.stopCount} stops · {l.expectedPieces} pieces
              {l.routeName ? ` · ${l.routeName}` : ''}
            </div>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-400" />
        </button>
      ))}
      {loader && !loads.length ? <Banner kind="warn">No loads on the board for today yet.</Banner> : null}
      <div className="pt-2">
        <input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          className="w-full rounded-xl border border-slate-300 px-4 py-2 text-sm"
          placeholder="Or type another load number"
        />
        {manual.trim() ? (
          <div className="mt-2">
            <BigButton tone="ghost" onClick={() => onManual(manual.trim())}>Use {manual.trim()}</BigButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Scan screen ──────────────────────────────────────────────────────────────

function OutcomeCard({ result, partial }) {
  if (!result) {
    const need = partial?.pro ? 'OG barcode (upper)' : partial?.og ? 'PRO barcode (lower)' : null;
    return (
      <Banner kind="info">
        {need ? (
          <span className="font-medium">Hold steady — need the {need}</span>
        ) : (
          <span>Point at a label. Both barcodes.</span>
        )}
      </Banner>
    );
  }
  if (result.outcome === OUTCOME.GREEN) {
    return (
      <div className="rounded-xl bg-emerald-50 ring-1 ring-emerald-300 px-3 py-3">
        <div className="flex items-center gap-2 text-emerald-900 font-semibold">
          <CheckCircle2 className="w-5 h-5" /> ON THIS TRUCK
        </div>
        <div className="mt-1 text-sm text-emerald-900">
          {result.stop?.businessName} · PRO {result.pro}
        </div>
        <div className="text-xs font-mono text-emerald-800">{result.og}</div>
      </div>
    );
  }
  if (result.outcome === OUTCOME.AMBER) {
    return (
      <div className="rounded-xl bg-amber-50 ring-1 ring-amber-400 px-3 py-3">
        <div className="flex items-center gap-2 text-amber-900 font-bold">
          <AlertTriangle className="w-5 h-5" /> APPOINTMENT REQUIRED — CONFIRM BOOKED
        </div>
        <div className="mt-1 text-sm text-amber-900">
          {result.stop?.businessName} · PRO {result.pro}
        </div>
        {result.instructions ? (
          <div className="mt-1 text-xs text-amber-900 whitespace-pre-wrap break-words">{result.instructions}</div>
        ) : null}
        <div className="text-xs font-mono text-amber-800 mt-1">{result.og}</div>
      </div>
    );
  }
  if (result.outcome === OUTCOME.RED) {
    return (
      <div className="rounded-xl bg-rose-50 ring-1 ring-rose-400 px-3 py-3">
        <div className="flex items-center gap-2 text-rose-900 font-bold">
          <XCircle className="w-5 h-5" /> NOT ON THIS LOAD
        </div>
        <div className="mt-1 text-sm text-rose-900">PRO {result.pro}</div>
        {result.owner ? (
          <div className="text-sm text-rose-900">
            Belongs to load <span className="font-semibold">{result.owner.loadNbr}</span>
            {result.owner.driverName ? ` · ${result.owner.driverName}` : ''}
          </div>
        ) : (
          <div className="text-sm text-rose-900">Not on any load we can see today.</div>
        )}
        <div className="text-xs font-mono text-rose-800 mt-1">{result.og}</div>
      </div>
    );
  }
  return null; // SILENT — deliberately nothing
}

/**
 * Full-screen verdict for gun mode. The beep already said what happened; this
 * is the glanceable confirmation. Green/amber/dup clear themselves; RED stays
 * up until the operator taps it — wrong freight must be acknowledged, not
 * scrolled past.
 */
function VerdictFlash({ verdict, onClear }) {
  if (!verdict) return null;
  const { kind, evaluated } = verdict;
  const base = 'fixed inset-0 z-40 flex flex-col items-center justify-center text-center p-6 select-none';

  if (kind === 'red') {
    return (
      <button type="button" onClick={onClear} className={`${base} w-full bg-rose-600 text-white`}>
        <XCircle className="w-24 h-24 mb-4" aria-hidden="true" />
        <div className="text-4xl font-black leading-tight">WRONG FREIGHT</div>
        <div className="mt-2 text-2xl font-bold">TAKE IT OFF</div>
        <div className="mt-4 text-lg">PRO {evaluated?.pro}</div>
        {evaluated?.owner ? (
          <div className="text-lg">
            Belongs to {evaluated.owner.loadNbr}
            {evaluated.owner.driverName ? ` · ${evaluated.owner.driverName}` : ''}
          </div>
        ) : (
          <div className="text-lg">Not on any load we can see today.</div>
        )}
        <div className="mt-8 text-sm uppercase tracking-widest opacity-80">Tap anywhere to clear</div>
      </button>
    );
  }

  const tone = {
    green: ['bg-emerald-500 text-white', 'ON THIS TRUCK'],
    amber: ['bg-amber-400 text-amber-950', 'APPT — CONFIRM BOOKED'],
    dup: ['bg-slate-700 text-white', 'ALREADY SCANNED'],
  }[kind] || ['bg-emerald-500 text-white', 'ON THIS TRUCK'];

  return (
    <div className={`${base} ${tone[0]} pointer-events-none`}>
      {kind === 'green' ? <CheckCircle2 className="w-24 h-24 mb-4" aria-hidden="true" /> : null}
      {kind === 'amber' ? <AlertTriangle className="w-24 h-24 mb-4" aria-hidden="true" /> : null}
      <div className="text-4xl font-black leading-tight">{tone[1]}</div>
      {evaluated?.stop?.businessName ? <div className="mt-2 text-xl">{evaluated.stop.businessName}</div> : null}
    </div>
  );
}

function StopRow({ stop, progress, onHandConfirm, groupCount, trailerEnd, sharesPosition }) {
  // Two-step by construction: the confirm button does not exist until "Cannot
  // scan this" is tapped, and it re-arms after every render of a fresh row. A
  // single stray tap can never book freight onto the truck.
  const [arming, setArming] = useState(false);
  const gaps = progress.complete ? null : ogGapHint(progress.ogs);
  const tone = progress.handConfirmed
    ? 'bg-sky-50 ring-sky-300'
    : progress.complete
      ? 'bg-emerald-50 ring-emerald-200'
      : progress.scanned > 0
        ? 'bg-amber-50 ring-amber-200'
        : 'bg-white ring-slate-200';
  return (
    <div className={`rounded-xl px-3 py-2 ring-1 ${tone}`}>
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-slate-700 w-6 shrink-0 tabular-nums">{stop.loadSeq ?? '—'}</span>
        <span className="font-medium text-slate-900 truncate flex-1">{stop.businessName || stop.stopNbr}</span>
        <span className="font-mono text-sm">
          {progress.scanned}/{progress.expected}
        </span>
      </div>
      {/* Both numbers, always. A loader should never do this arithmetic on a
          dock at 5am, and "load 1" vs "stop 13" is exactly the mix-up that puts
          freight at the wrong end of the trailer. */}
      <div className="mt-0.5 pl-8 text-xs">
        <span className="text-slate-700 font-medium">
          Load {stop.loadSeq ?? '—'} of {groupCount}
        </span>
        <span className="text-slate-500"> · Delivery stop {deliverySeq(stop) ?? '—'}</span>
        {trailerEnd ? <span className="text-sky-800 font-medium"> · {trailerEnd}</span> : null}
        {sharesPosition ? <span className="text-slate-500"> · same address as the stop beside it</span> : null}
      </div>
      <div className="mt-0.5 pl-8 text-xs text-slate-500 flex flex-wrap gap-x-2">
        <span>{stop.city}{stop.state ? `, ${stop.state}` : ''}</span>
        <span>PRO {stop.pros.join(', ')}</span>
        <span>{stop.skids} skids · {stop.loose} loose</span>
        {stop.countIsEstimated ? <span title="No piece total on this order — count computed from skids + loose">count from parts</span> : null}
        {stop.appointmentRequired ? <span className="text-amber-700 font-medium">APPT</span> : null}
      </div>
      {gaps ? (
        <div className="mt-1 pl-8 text-xs text-slate-500">
          Possible gap at {gaps.join(', ')} — a piece may still be on the dock.
        </div>
      ) : null}

      {/* Hand-confirm: only for freight the scanner physically cannot read, and
          only while the stop is still short. Never an alternative to scanning. */}
      {stop.scannable === false && !progress.handConfirmed && progress.short > 0 ? (
        <div className="mt-2 pl-8">
          {!arming ? (
            <button
              type="button"
              onClick={() => setArming(true)}
              className="text-xs rounded-lg ring-1 ring-sky-300 bg-sky-50 text-sky-900 px-3 py-2"
            >
              No barcode we can read — confirm by hand
            </button>
          ) : (
            <div className="rounded-lg ring-1 ring-sky-300 bg-sky-50 px-3 py-2 space-y-2">
              <div className="text-xs text-sky-900">
                Confirming <span className="font-semibold">{progress.short} piece(s)</span> for{' '}
                {stop.businessName || stop.stopNbr} without scanning. Count them on the truck first — this is
                recorded as your word, not a scan.
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setArming(false)}
                  className="flex-1 text-xs rounded-lg ring-1 ring-slate-300 bg-white px-3 py-2"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setArming(false);
                    onHandConfirm?.(stop, progress.short);
                  }}
                  className="flex-1 text-xs rounded-lg bg-sky-700 text-white px-3 py-2 font-medium"
                >
                  Yes — all {progress.short} are loaded
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {progress.handConfirmed ? (
        <div className="mt-1 pl-8 text-xs text-sky-800">
          {progress.confirmedPieces} piece(s) confirmed by hand — no readable barcode
        </div>
      ) : null}
    </div>
  );
}

function CloseoutSheet({ load, progress, onCancel, onConfirm, busy }) {
  const [resolvedBy, setResolvedBy] = useState('');
  const [note, setNote] = useState('');
  const clean = progress.clean;

  return (
    <div className="fixed inset-0 bg-black/50 z-30 flex items-end">
      <div className="bg-white w-full rounded-t-2xl p-4 space-y-3 max-h-[85vh] overflow-y-auto">
        <div className="text-lg font-semibold">Close load {load.loadNbr}</div>
        <div className="text-sm text-slate-600">
          {progress.scanned} of {progress.expected} pieces accounted for
        </div>
        {progress.confirmedPieces > 0 ? (
          <Banner kind="info">
            {progress.scannedPieces} scanned · <span className="font-medium">{progress.confirmedPieces} confirmed by
            hand</span> on {progress.handConfirmedStops.length} stop(s) with no readable barcode. Both are recorded,
            and dispatch can tell them apart.
          </Banner>
        ) : null}

        {clean ? (
          <Banner kind="good">Every stop reconciles. Safe to close.</Banner>
        ) : (
          <>
            <Banner kind="error">
              <div className="font-semibold">
                {progress.short > 0 ? `${progress.short} piece(s) missing` : ''}
                {progress.short > 0 && progress.over > 0 ? ' · ' : ''}
                {progress.over > 0 ? `${progress.over} extra piece(s)` : ''}
              </div>
              <div className="mt-1">This load cannot close until you say what happened.</div>
            </Banner>
            <div className="space-y-1">
              {progress.stopsWithGap.map((p) => (
                <div key={p.stopNbr} className="text-sm text-slate-700 flex justify-between">
                  <span className="truncate">{p.stopNbr}</span>
                  <span className="font-mono">
                    {p.scanned}/{p.expected}
                  </span>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              {[
                ['short', 'Short — pieces left on the dock'],
                ['over', 'Over — extra pieces loaded'],
                ['miscount', 'Miscount — paperwork is wrong'],
              ].map(([val, label]) => (
                <label key={val} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="resolution"
                    value={val}
                    checked={resolvedBy === val}
                    onChange={() => setResolvedBy(val)}
                    className="w-5 h-5"
                  />
                  {label}
                </label>
              ))}
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Anything dispatch should know"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
            />
          </>
        )}

        <div className="flex gap-2 pt-1">
          <BigButton tone="ghost" onClick={onCancel}>Back</BigButton>
          <BigButton
            onClick={() => onConfirm({ resolvedBy: clean ? 'clean' : resolvedBy, note })}
            disabled={busy || (!clean && !resolvedBy)}
          >
            {busy ? 'Closing…' : 'Close load'}
          </BigButton>
        </div>
      </div>
    </div>
  );
}

function ScanScreen({ session, manifest, activeLoad, onSwitchLoad, onSignOut, loader }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const stopRef = useRef(null);

  const [camOn, setCamOn] = useState(false);
  const [engine, setEngine] = useState('');
  const [status, setStatus] = useState('');
  const [camErr, setCamErr] = useState('');
  const [result, setResult] = useState(null);
  const [partial, setPartial] = useState({ pro: null, og: null });
  const [scans, setScans] = useState([]);
  const [handConfirms, setHandConfirms] = useState([]);
  const [pending, setPending] = useState(0);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [manualPro, setManualPro] = useState('');
  const [manualOg, setManualOg] = useState('');

  // ── Scanner gun (keyboard wedge) ───────────────────────────────────────────
  const [gunMode, setGunMode] = useState(false);
  const [verdict, setVerdict] = useState(null); // { kind, evaluated, sticky }
  const gunModeRef = useRef(false);
  const verdictRef = useRef(null);
  const wedgeInputRef = useRef(null);
  const wedgePairRef = useRef(null);
  const wedgeAccRef = useRef(null);
  const onWedgeScanRef = useRef(() => {});

  const load = useMemo(
    () => (manifest?.loads || []).find((l) => l.loadNbr === activeLoad) || null,
    [manifest, activeLoad],
  );
  const stops = load?.stops || [];
  const loadDriverName = load?.stops?.[0]?.raw?.driverName || load?.driverName || '';
  const otherLoads = useMemo(
    () => (manifest?.loads || []).filter((l) => l.loadNbr !== activeLoad)
      .map((l) => ({ loadNbr: l.loadNbr, driverName: l.stops?.[0]?.raw?.driverName || null, stops: l.stops })),
    [manifest, activeLoad],
  );
  const progress = useMemo(() => loadProgress(stops, scans, handConfirms), [stops, scans, handConfirms]);

  // ── Resequence guard ───────────────────────────────────────────────────────
  //
  // The trailer physically encodes ONE route order. If dispatch resequences
  // after loading began, silently redrawing the screen with new positions would
  // hide freight that is already in the wrong place. So we keep showing the
  // order the truck was loaded against and say loudly that it changed.
  const [loadedSeq, setLoadedSeq] = useState(null);
  const resequenced = !!loadedSeq && loadedSeq.fingerprint !== sequenceFingerprint(stops);

  const displayStops = useMemo(() => {
    if (!resequenced) return stops;
    const byStop = loadedSeq.loadSeqByStop || {};
    return stops.map((s) => ({ ...s, loadSeq: byStop[s.stopNbr] ?? s.loadSeq }));
  }, [stops, resequenced, loadedSeq]);

  const loadingOrder = useMemo(() => loadOrder(displayStops), [displayStops]);
  const groupCount = useMemo(() => loadGroupCount(displayStops), [displayStops]);

  useEffect(() => {
    if (!activeLoad) { setLoadedSeq(null); return; }
    let alive = true;
    store.getLoadedSequence(activeLoad).then((v) => { if (alive) setLoadedSeq(v); });
    return () => { alive = false; };
  }, [activeLoad, scans.length, handConfirms.length]);
  const scannedOgs = useMemo(() => new Set(scans.map((s) => String(s.og).toUpperCase())), [scans]);

  // Rehydrate this load's scans from the local queue — the UI's source of truth.
  const refreshLocal = useCallback(async () => {
    if (!activeLoad) return;
    const rows = await store.queuedFor(activeLoad);
    setScans(
      rows.filter((r) => r.kind !== 'hand')
        .map((r) => ({ og: r.og, pro: r.pro, scannedAt: r.scannedAt, stopNbr: r.stopNbr, engine: r.engine })),
    );
    setHandConfirms(
      rows.filter((r) => r.kind === 'hand')
        .map((r) => ({ stopNbr: r.stopNbr, pieces: r.pieces, confirmedAt: r.confirmedAt, reason: r.reason })),
    );
    setPending(rows.filter((r) => !r.syncedAt).length);
  }, [activeLoad]);

  useEffect(() => {
    refreshLocal();
  }, [refreshLocal]);

  // Record a piece: local first, ALWAYS, then try the network. Returns the
  // evaluation so a caller that owns its own feedback (the wedge path) can act
  // on the verdict — including SILENT, which the camera path ignores.
  // Written on the FIRST piece recorded, then never again: this is the route
  // order the physical trailer reflects. See offline.stampLoadedSequence.
  const stampSequence = useCallback(async () => {
    if (!activeLoad || !stops.length) return;
    const loadSeqByStop = {};
    for (const s of stops) loadSeqByStop[s.stopNbr] = s.loadSeq ?? null;
    await store.stampLoadedSequence(activeLoad, sequenceFingerprint(stops), loadSeqByStop);
  }, [activeLoad, stops]);

  const record = useCallback(
    async (pair, engineName) => {
      const evaluated = evaluateScan(pair, stops, scannedOgs, otherLoads);
      if (evaluated.outcome === OUTCOME.SILENT) return evaluated; // no prompt, no button, no decision
      setResult(evaluated);
      setPartial({ pro: null, og: null });

      if (evaluated.outcome === OUTCOME.RED) {
        // A red piece is NOT recorded against this load — it is not on it.
        if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
        return evaluated;
      }
      if (navigator.vibrate) navigator.vibrate(40);

      const scan = {
        og: evaluated.og,
        pro: evaluated.pro,
        scannedAt: new Date().toISOString(),
        stopNbr: evaluated.stop?.stopNbr || '',
        engine: engineName || 'manual',
      };
      await store.enqueueScan(activeLoad, manifest.date, scan);
      await stampSequence();
      await refreshLocal();
      flushQueue();
      return evaluated;
    },
    [stops, scannedOgs, otherLoads, activeLoad, manifest, refreshLocal],
  );

  // Best-effort upload. Never blocks the UI; failure just leaves the queue alone.
  const flushQueue = useCallback(async () => {
    if (!activeLoad || !navigator.onLine) return;
    try {
      const rows = (await store.queuedFor(activeLoad)).filter((r) => !r.syncedAt);
      if (!rows.length) return;
      await api.pushScans(session.token, {
        loadNbr: activeLoad,
        date: manifest.date,
        expectedPieces: progress.expected,
        sequenceFingerprint: sequenceFingerprint(stops),
        scans: rows.filter((r) => r.kind !== 'hand')
          .map(({ og, pro, scannedAt, stopNbr, engine: eng }) => ({ og, pro, scannedAt, stopNbr, engine: eng })),
        handConfirms: rows.filter((r) => r.kind === 'hand')
          .map(({ stopNbr, pieces, confirmedAt, reason }) => ({ stopNbr, pieces, confirmedAt, reason })),
      });
      await store.markSynced(rows.map((r) => r.key));
      await refreshLocal();
    } catch {
      /* offline or server hiccup — the queue is the durable copy, try again later */
    }
  }, [activeLoad, session, manifest, progress.expected, refreshLocal]);

  useEffect(() => {
    const onOnline = () => flushQueue();
    window.addEventListener('online', onOnline);
    const t = setInterval(flushQueue, 30_000);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(t);
    };
  }, [flushQueue]);

  async function toggleCam() {
    if (camOn) {
      stopRef.current?.();
      stopRef.current = null;
      setCamOn(false);
      setEngine('');
      return;
    }
    setCamErr('');
    try {
      const { stop, engine: eng } = await startScanner({
        videoEl: videoRef.current,
        containerEl: containerRef.current,
        onPair: (p) => record(p, p.engine),
        onPartial: setPartial,
        onStatus: setStatus,
      });
      stopRef.current = stop;
      setEngine(eng);
      setCamOn(true);
    } catch (e) {
      setCamErr(e?.message || 'Camera would not start. Type the barcodes below.');
    }
  }

  useEffect(() => () => stopRef.current?.(), []);

  // The wedge path owns its own feedback: sounds and a full-screen flash
  // instead of a card nobody reads with gloves on. Kept behind a ref so the
  // once-created accumulator always calls the latest closure.
  onWedgeScanRef.current = async (raw) => {
    if (verdictRef.current?.sticky) {
      // A red screen must be acknowledged before scanning on — replay the buzz
      // so the operator knows the gun is not the thing that is stuck.
      playVerdict('red');
      return;
    }
    const pair = wedgePairRef.current.push([raw]);
    setPartial(wedgePairRef.current.state());
    if (!pair) return;
    const evaluated = await record(pair, 'wedge');
    if (!evaluated) return;
    const kind =
      evaluated.outcome === OUTCOME.SILENT ? 'dup'
        : evaluated.outcome === OUTCOME.RED ? 'red'
          : evaluated.outcome === OUTCOME.AMBER ? 'amber'
            : 'green';
    playVerdict(kind);
    setVerdict({ kind, evaluated, sticky: kind === 'red' });
  };

  if (!wedgePairRef.current) wedgePairRef.current = createPairBuffer({ windowMs: WEDGE_PAIR_WINDOW_MS });
  if (!wedgeAccRef.current) wedgeAccRef.current = createWedgeAccumulator({ onScan: (v) => onWedgeScanRef.current(v) });

  useEffect(() => {
    gunModeRef.current = gunMode;
    if (gunMode) {
      wedgeInputRef.current?.focus();
    } else {
      wedgeAccRef.current?.reset();
      wedgePairRef.current?.reset();
      setPartial({ pro: null, og: null });
    }
  }, [gunMode]);

  // Green/amber/dup flashes clear themselves; red stays until acknowledged.
  useEffect(() => {
    verdictRef.current = verdict;
    if (!verdict || verdict.sticky) return undefined;
    const t = setTimeout(() => setVerdict(null), verdict.kind === 'green' ? 650 : 1200);
    return () => clearTimeout(t);
  }, [verdict]);

  function toggleGun() {
    initAudio(); // must happen inside a user gesture, once, or the beeps stay muted
    if (!gunMode && camOn) toggleCam(); // one capture path at a time
    setGunMode((v) => !v);
  }

  // Local first, exactly like a scan: the dock has no signal and a confirmation
  // that only exists in a pending request is one a dropped connection deletes.
  const handConfirm = useCallback(
    async (stop, pieces) => {
      await store.enqueueHandConfirm(activeLoad, manifest.date, {
        stopNbr: stop.stopNbr,
        pieces,
        confirmedAt: new Date().toISOString(),
        reason: 'not_scannable',
      });
      if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
      await stampSequence();
      await refreshLocal();
      flushQueue();
    },
    [activeLoad, manifest, refreshLocal, flushQueue, stampSequence],
  );

  async function addManual() {
    const pro = normalizePro(manualPro);
    const og = manualOg.trim().toUpperCase();
    if (!/^\d{7}$/.test(pro) || !/^OG\d{10}$/.test(og)) {
      setFlash('Need a 7-digit PRO and an OG number with 10 digits.');
      return;
    }
    setFlash('');
    await record({ pro, og }, 'manual');
    setManualPro('');
    setManualOg('');
  }

  async function confirmClose({ resolvedBy, note }) {
    setBusy(true);
    try {
      await flushQueue();
      await api.pushScans(session.token, {
        loadNbr: activeLoad,
        date: manifest.date,
        expectedPieces: progress.expected,
        scans: [],
        handConfirms: [],
        close: true,
        reconciliation: { resolvedBy, note },
      });
      setClosing(false);
      setClosed(true);
      setFlash(`Load ${activeLoad} closed.`);
    } catch (e) {
      setFlash(e?.offline ? 'No signal — close the load once you have signal.' : e?.message || 'Could not close.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pb-28">
      <Header
        title={load ? load.loadNbr : 'No load'}
        subtitle={
          loader
            // A loader needs whose truck this is, not who they are — they know
            // that. Their own name moves to the sign-out side of the question.
            ? `${loadDriverName || 'unassigned'} · loading as ${session.displayName || session.driverNumber}`
            : `${fmtDate(manifest?.date)} · ${session.displayName || session.driverNumber}`
        }
        right={
          <button type="button" onClick={onSignOut} className="p-2 -mr-2" aria-label="Sign out">
            <LogOut className="w-5 h-5" />
          </button>
        }
      />

      <div className="p-3 space-y-3">
        <div className="flex items-center gap-3 text-sm">
          <div className="font-mono text-2xl font-bold text-slate-900">
            {progress.scanned}
            <span className="text-slate-400">/{progress.expected}</span>
          </div>
          <div className="text-slate-500">pieces</div>
          <div className="flex-1" />
          {pending > 0 ? (
            <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
              <CloudOff className="w-4 h-4" /> {pending} not uploaded
            </span>
          ) : (
            <span className="text-emerald-700 text-xs">all uploaded</span>
          )}
        </div>

        {/* Scanner gun — keystrokes in, same matching logic as the camera. */}
        <BigButton tone={gunMode ? 'primary' : 'ghost'} onClick={toggleGun}>
          <span className="inline-flex items-center justify-center gap-2">
            <ScanLine className="w-5 h-5" />
            {gunMode ? 'Scanner gun ON — tap for camera' : 'Use scanner gun'}
          </span>
        </BigButton>

        {gunMode ? (
          <div
            className="relative rounded-xl bg-slate-900 text-white px-4 py-6"
            onClick={() => wedgeInputRef.current?.focus()}
          >
            <div className="flex items-center gap-3">
              <ScanLine className="w-8 h-8 shrink-0" />
              <div className="min-w-0">
                <div className="font-semibold text-lg">Gun ready</div>
                <div className="text-sm text-white/70">
                  {partial?.pro
                    ? 'PRO captured — now the OG barcode (upper)'
                    : partial?.og
                      ? 'OG captured — now the PRO barcode (lower)'
                      : 'Scan both barcodes on the label, either order'}
                </div>
              </div>
            </div>
            {/* The wedge target: invisible, focused, keyboard-only. inputMode
                none keeps the tablet's soft keyboard down. */}
            <input
              ref={wedgeInputRef}
              value=""
              onChange={() => {}}
              onKeyDown={(e) => {
                if (wedgeAccRef.current?.key(e.key)) e.preventDefault();
              }}
              onBlur={(e) => {
                // A tap on a real field is deliberate; losing focus to the body
                // is not — take it back so the next trigger pull still lands.
                const t = e.relatedTarget;
                if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
                setTimeout(() => {
                  if (gunModeRef.current) wedgeInputRef.current?.focus();
                }, 60);
              }}
              inputMode="none"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Scanner gun input"
              className="absolute w-px h-px opacity-0"
            />
          </div>
        ) : (
          <div className="relative rounded-xl overflow-hidden bg-slate-900 aspect-[3/4]">
            <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" playsInline muted />
            <div ref={containerRef} className="absolute inset-0" />
            {!camOn ? (
              <button
                type="button"
                onClick={toggleCam}
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/90"
              >
                <Camera className="w-10 h-10" />
                <span className="text-sm">Tap to scan</span>
              </button>
            ) : (
              <>
                {/* Scan window matching the Quagga inset so both engines frame alike. */}
                <div className="absolute inset-x-[5%] inset-y-[15%] ring-2 ring-white/70 rounded-lg pointer-events-none" />
                <button
                  type="button"
                  onClick={toggleCam}
                  className="absolute bottom-2 right-2 rounded-lg bg-black/60 text-white text-xs px-3 py-2"
                >
                  Stop
                </button>
                <div className="absolute top-2 left-2 rounded bg-black/50 text-white/80 text-[10px] px-2 py-1">
                  {engine}{status ? ` · ${status}` : ''}
                </div>
              </>
            )}
          </div>
        )}

        {camErr ? <Banner kind="error">{camErr}</Banner> : null}
        <OutcomeCard result={result} partial={partial} />
        {flash ? <Banner kind="info">{flash}</Banner> : null}

        {/* Manual entry — the degraded path when the camera will not cooperate. */}
        <details className="rounded-xl bg-white ring-1 ring-slate-200 px-3 py-2">
          <summary className="text-sm text-slate-600 cursor-pointer">Type it instead</summary>
          <div className="mt-2 space-y-2">
            <input
              value={manualPro}
              onChange={(e) => setManualPro(e.target.value)}
              inputMode="numeric"
              placeholder="PRO (7 digits)"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              value={manualOg}
              onChange={(e) => setManualOg(e.target.value)}
              placeholder="OG number"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
            />
            <BigButton tone="ghost" onClick={addManual}>Add piece</BigButton>
          </div>
        </details>

        {/* Stops */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <ClipboardList className="w-4 h-4" /> {stops.length} stops · loading order
          </div>
          <div className="text-xs text-slate-500">
            Top of the list goes on first, at the nose. Work down toward the doors.
          </div>
          {resequenced ? (
            <Banner kind="error">
              <span className="font-semibold">The route was resequenced after loading started.</span> The freight
              already on this trailer follows the ORIGINAL order, which is what is shown below — it has not been
              renumbered. Check with dispatch before loading anything else.
            </Banner>
          ) : null}
          {loadingOrder.map((s, i) => (
            <StopRow
              key={s.stopNbr}
              stop={s}
              progress={stopProgress(s, scans, handConfirms)}
              onHandConfirm={handConfirm}
              groupCount={groupCount}
              trailerEnd={
                s.loadSeq != null && s.loadSeq === 1
                  ? 'nose of the trailer'
                  : s.loadSeq != null && s.loadSeq === groupCount
                    ? 'at the doors'
                    : null
              }
              sharesPosition={
                s.loadSeq != null &&
                ((loadingOrder[i - 1]?.loadSeq === s.loadSeq) || (loadingOrder[i + 1]?.loadSeq === s.loadSeq))
              }
            />
          ))}
        </div>

        {/* One truck start to finish, several per shift: the way out of a
            closed load is the next truck, not a dead end. */}
        {closed ? (
          <BigButton onClick={onSwitchLoad}>
            {loader ? 'Next truck' : 'Back to my loads'}
          </BigButton>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <BigButton tone="ghost" onClick={onSwitchLoad}>{loader ? 'Different truck' : 'Switch load'}</BigButton>
            <BigButton onClick={() => setClosing(true)} disabled={!load}>Close load</BigButton>
          </div>
        )}

        <div className="text-[10px] text-slate-400 text-center pt-2">
          Load Scan v{APP_VERSION} · {BUILD_COMMIT} · {BUILD_CONTEXT}
          {BUILD_TIME ? ` · ${fmtDate(BUILD_TIME)}` : ''} · session {daysRemaining(session.token)}d left
        </div>
      </div>

      {closing && load ? (
        <CloseoutSheet
          load={load}
          progress={progress}
          onCancel={() => setClosing(false)}
          onConfirm={confirmClose}
          busy={busy}
        />
      ) : null}

      <VerdictFlash verdict={verdict} onClear={() => setVerdict(null)} />
    </div>
  );
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * A centred overlay. The dispatcher screen used to render its editor at the
 * BOTTOM of a fifty-row table, so clicking "edit" populated a form three
 * thousand pixels below the click and the button looked broken. An editor that
 * cannot be off-screen cannot have that bug.
 */
function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    // Stop the table scrolling behind the dialog on touch.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-start sm:items-center justify-center p-3 overflow-y-auto"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-lg my-auto rounded-2xl bg-white shadow-xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 sticky top-0 bg-white rounded-t-2xl">
          <div className="font-semibold text-slate-800 flex-1 truncate">{title}</div>
          <button type="button" onClick={onClose} className="p-1 -mr-1 text-slate-500" aria-label="Close">
            <XCircle className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
      </div>
    </div>
  );
}

/** Destructive actions get a deliberate second click, never a lone one. */
function ConfirmAction({ label, confirmLabel, onConfirm, disabled, tone = 'danger' }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!armed) {
    return (
      <button type="button" className="text-xs underline" disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setArmed(false); onConfirm(); }}
        className={`text-xs rounded px-2 py-0.5 text-white ${tone === 'danger' ? 'bg-rose-600' : 'bg-[#1e5b92]'}`}
      >
        {confirmLabel}
      </button>
      <button type="button" className="text-xs underline text-slate-500" onClick={() => setArmed(false)}>
        cancel
      </button>
    </span>
  );
}

/**
 * Aliases as removable chips plus an add box.
 *
 * They used to be one comma-separated string posted through `upsert`, which
 * REPLACES the whole array. A dispatcher tidying that field could silently drop
 * a spelling, and the only symptom is a driver quietly getting no loads days
 * later. One alias in, one alias out, nothing else touched.
 */
function AliasChips({ aliases, onAdd, onRemove, busy }) {
  const [next, setNext] = useState('');
  const add = () => {
    const v = next.trim();
    if (!v) return;
    setNext('');
    onAdd(v);
  };
  return (
    <div>
      <div className="text-xs text-slate-600">
        NuVizz aliases — every spelling this person shows up as on the board
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {aliases.length ? (
          aliases.map((a) => (
            <span key={a} className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-xs font-mono">
              {a}
              <button
                type="button"
                disabled={busy}
                onClick={() => onRemove(a)}
                className="text-slate-500 hover:text-rose-600"
                aria-label={`Remove alias ${a}`}
              >
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="text-xs text-rose-600">None — this driver matches nothing and will get no loads.</span>
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={next}
          onChange={(e) => setNext(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="Add a spelling from the board"
          className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-mono"
        />
        <button
          type="button"
          disabled={busy || !next.trim()}
          onClick={add}
          className="text-sm rounded-lg bg-[#1e5b92] text-white px-3 py-1.5 disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}

/** Pick an existing credential — searchable, because there are fifty of them. */
function CredentialPicker({ creds, onPick, busy, exclude = [] }) {
  const [q, setQ] = useState('');
  const shown = useMemo(
    () => filterCredentials(creds, q).filter((c) => !exclude.includes(c.driverNumber)).slice(0, 40),
    [creds, q, exclude],
  );
  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by number, name or alias…"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <div className="mt-2 max-h-64 overflow-y-auto rounded-lg ring-1 ring-slate-200 divide-y divide-slate-100">
        {shown.length ? (
          shown.map((c) => (
            <button
              key={c.driverNumber}
              type="button"
              disabled={busy}
              onClick={() => onPick(c)}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-sky-50 disabled:opacity-50"
            >
              <span className="font-mono">{c.driverNumber}</span> · {c.displayName || '—'}
              {c.active === false ? <span className="text-rose-600 text-xs"> · deactivated</span> : null}
              <div className="text-xs text-slate-500 truncate">
                {(c.nuvizzAliases || []).join(', ') || 'no aliases'}
              </div>
            </button>
          ))
        ) : (
          <div className="px-3 py-2 text-sm text-slate-500">No credential matches “{q}”.</div>
        )}
      </div>
    </div>
  );
}

/**
 * One unmatched sign-in, with the means to actually fix it.
 *
 * This driver signed in and got NO loads: none of their seeded aliases matched
 * any name on that day's board. The fix is to attach the right board name to
 * their credential — so every board name is listed here, sorted and searchable,
 * and clicking one assigns it. Truncating the list to a dozen arbitrary names
 * made the panel unreviewable: the name you needed was usually in the part you
 * could not see.
 */
function UnmatchedRow({ u, onAssign, onDismiss }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pending, setPending] = useState(null);

  const board = useMemo(
    () => [...new Set(u.boardAliases || [])].sort((a, b) => a.localeCompare(b)),
    [u.boardAliases],
  );
  const shown = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return needle ? board.filter((n) => n.includes(needle)) : board;
  }, [board, q]);

  return (
    <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 px-3 py-2 text-sm">
      <div className="font-medium">
        {u.displayName || u.driverNumber} · {fmtDate(u.date)}
      </div>
      <div className="text-xs text-slate-600 mt-1">
        Seeded: {(u.seededAliases || []).join(', ') || 'none'} — none of these were on the board that day, so this
        driver got no loads.
      </div>

      {pending ? (
        <div className="mt-2 rounded-lg bg-white ring-1 ring-amber-300 px-3 py-2">
          <div className="text-xs">
            Assign <span className="font-semibold">{pending}</span> to{' '}
            <span className="font-semibold">{u.displayName || u.driverNumber}</span> ({u.driverNumber})?
          </div>
          <div className="flex gap-2 mt-2">
            <button type="button" className="flex-1 text-xs rounded-lg ring-1 ring-slate-300 px-3 py-2" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="flex-1 text-xs rounded-lg bg-[#1e5b92] text-white px-3 py-2 font-medium"
              onClick={() => { const a = pending; setPending(null); onAssign(a); }}
            >
              Assign alias
            </button>
          </div>
        </div>
      ) : (
        <>
          <button type="button" className="mt-2 text-xs underline" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : `Show all ${board.length} names on the board that day`}
          </button>

          {open ? (
            <div className="mt-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter names…"
                className="w-full rounded-lg border border-slate-300 px-2 py-1 text-xs"
              />
              <div className="mt-1 max-h-56 overflow-y-auto rounded-lg bg-white ring-1 ring-slate-200 divide-y divide-slate-100">
                {shown.length ? (
                  shown.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setPending(name)}
                      className="block w-full text-left px-2 py-1.5 text-xs hover:bg-sky-50"
                    >
                      {name}
                    </button>
                  ))
                ) : (
                  <div className="px-2 py-1.5 text-xs text-slate-500">No name on that board matches “{q}”.</div>
                )}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Click the name this driver runs under. It is added to their credential and this row clears.
              </div>
            </div>
          ) : null}

          <div className="mt-2">
            <button type="button" className="text-xs underline text-slate-500" onClick={onDismiss}>
              Dismiss without fixing
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Who is on the board, and which of them the app can actually identify.
 *
 * A driver with loads in NuVizz but no credential claiming their name gets NO
 * loads on the handset and no error anyone sees — the failure is silent until
 * they are standing at the dock. This is the list that makes it visible before
 * then, and every unidentified name here is one click from becoming a driver.
 *
 * Reads the pre-built stop index only. ZERO NuVizz calls.
 */
function BoardToday({ rows, window: win, days, onDays, onAdd, onAttach, busy }) {
  const { identified, unidentified, inactiveOnly, ambiguous: ambiguousRows } = useMemo(
    () => partitionBoardRows(rows),
    [rows],
  );
  const [showAll, setShowAll] = useState(false);

  // Each bucket is a DIFFERENT fix, so they are never merged into one count.
  const Problem = ({ row, kind }) => (
    <div className="flex items-center gap-2 text-sm py-0.5">
      <span className="flex-1 truncate">{row.alias}</span>
      {kind === 'inactive' ? (
        <span className="text-xs text-rose-700 shrink-0">only {row.inactiveClaimedBy.join(', ')} (deactivated)</span>
      ) : kind === 'ambiguous' ? (
        <span className="text-xs text-rose-700 shrink-0">{row.claimedBy.join(', ')}</span>
      ) : null}
      <span className="text-xs text-slate-500 shrink-0">{row.stops} stop(s)</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => onAttach(row.alias)}
        className="text-xs rounded-lg ring-1 ring-slate-300 bg-white px-2 py-1 shrink-0"
      >
        Attach to driver
      </button>
      {kind !== 'ambiguous' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAdd(row.alias)}
          className="text-xs rounded-lg bg-[#1e5b92] text-white px-2 py-1 shrink-0"
        >
          New driver
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-sm font-medium text-slate-700 flex items-center gap-2">
          <Users className="w-4 h-4" /> On the board
        </div>
        <div className="flex gap-1 text-xs">
          {[[1, 'Today'], [7, '7 days'], [14, '14 days']].map(([d, label]) => (
            <button
              key={d}
              type="button"
              disabled={busy}
              onClick={() => onDays(d)}
              className={`rounded-lg px-2 py-1 ring-1 ${days === d ? 'bg-[#1e5b92] text-white ring-[#1e5b92]' : 'bg-white ring-slate-300 text-slate-600'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {!win?.daysRead?.length ? (
        <Banner kind="warn">
          No board was read for this window{win?.anchor ? ` (anchor ${win.anchor})` : ''}. Weekends are skipped, and a
          day with no stop index yet reads as empty. Try a wider window.
        </Banner>
      ) : (
        <div className="text-xs text-slate-500">
          {win.daysRead.length} day(s) read · {rows.length} distinct names ·{' '}
          <span className="text-emerald-700 font-medium">{identified.length} identified</span>
          {unidentified.length + inactiveOnly.length + ambiguousRows.length ? (
            <>
              {' '}· <span className="text-rose-700 font-medium">
                {unidentified.length + inactiveOnly.length + ambiguousRows.length} need attention
              </span>
            </>
          ) : null}
        </div>
      )}

      {ambiguousRows.length ? (
        <div className="rounded-xl bg-rose-50 ring-1 ring-rose-300 px-3 py-2">
          <div className="text-xs font-medium text-rose-900">
            Claimed by more than one active driver — these resolve to NEITHER, so both get nothing. Take the name off
            one of them.
          </div>
          <div className="mt-1">
            {ambiguousRows.map((r) => <Problem key={r.alias} row={r} kind="ambiguous" />)}
          </div>
        </div>
      ) : null}

      {inactiveOnly.length ? (
        <div className="rounded-xl bg-rose-50 ring-1 ring-rose-300 px-3 py-2">
          <div className="text-xs font-medium text-rose-900">
            Claimed only by a DEACTIVATED credential — that account cannot sign in, so these drivers get nothing.
            Reactivate it, or move the name to a live driver.
          </div>
          <div className="mt-1">
            {inactiveOnly.map((r) => <Problem key={r.alias} row={r} kind="inactive" />)}
          </div>
        </div>
      ) : null}

      {unidentified.length ? (
        <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 px-3 py-2">
          <div className="text-xs font-medium text-rose-900">
            These names have loads but no driver set up — they would get nothing on the handset
          </div>
          <div className="mt-1">
            {unidentified.map((r) => <Problem key={r.alias} row={r} kind="none" />)}
          </div>
        </div>
      ) : null}

      {identified.length ? (
        <div className="rounded-xl bg-white ring-1 ring-slate-200 px-3 py-2">
          <button type="button" className="text-xs underline" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Hide' : `Show the ${identified.length} identified`}
          </button>
          {showAll ? (
            <div className="mt-2 space-y-1">
              {identified.map((r) => (
                <div key={r.alias} className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  <span className="flex-1 truncate">{r.alias}</span>
                  <span className="text-xs text-slate-500 shrink-0">→ {r.claimedBy[0]}</span>
                  <span className="text-xs text-slate-400 shrink-0">{r.stops} stop(s)</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DispatcherScreen({ session, onSignOut }) {
  const [drivers, setDrivers] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [ambiguous, setAmbiguous] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  // A board name waiting to become a driver. Separate from `editing` because a
  // NEW driver still needs its number typed — the edit form locks that field.
  const [prefill, setPrefill] = useState(null);
  const [board, setBoard] = useState([]);
  const [boardWindow, setBoardWindow] = useState(null);
  const [boardDays, setBoardDays] = useState(1);
  const [boardNonce, setBoardNonce] = useState(0);
  const [query, setQuery] = useState('');
  // A board name looking for an existing credential to attach itself to.
  const [attaching, setAttaching] = useState(null);
  const [roleDraft, setRoleDraft] = useState(null);

  // Both editors open in a MODAL. Previously the form sat below a fifty-row
  // table, so "edit" set state three thousand pixels off-screen and read as a
  // dead button — the single loudest complaint about this screen.
  const openAdd = useCallback((alias) => {
    setEditing(null);
    setPrefill({ alias, displayName: alias });
  }, []);

  const reload = useCallback(async () => {
    setErr('');
    try {
      const [a, b] = await Promise.all([api.adminList(session.token), api.adminUnmatched(session.token)]);
      // aliasCount exists purely so the Aliases column is sortable — SortableTh
      // sorts on a scalar field, and an array is not one.
      setDrivers((a.drivers || []).map((d) => ({ ...d, aliasCount: (d.nuvizzAliases || []).length })));
      setAmbiguous(a.ambiguousAliases || []);
      setUnmatched(b.unmatched || []);
    } catch (e) {
      setErr(e?.message || 'Could not load the driver list.');
    }
  }, [session]);

  useEffect(() => {
    reload();
  }, [reload]);

  // The board roster is a separate, slower read (it walks the index day by day),
  // so it loads on its own and never holds up the credential list.
  useEffect(() => {
    let alive = true;
    api
      .aliasReport(session.token, boardDays)
      .then((r) => {
        if (!alive) return;
        setBoard(r.rows || []);
        setBoardWindow(r.window || null);
      })
      .catch((e) => alive && setErr(e?.message || 'Could not read the board.'));
    return () => { alive = false; };
  }, [session, boardDays, boardNonce]);

  const shownDrivers = useMemo(() => filterCredentials(drivers, query), [drivers, query]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(shownDrivers, 'driverNumber', 'asc');

  const closeEditor = useCallback(() => { setEditing(null); setPrefill(null); }, []);
  // Both lists must move together: a fix made in the editor has to show up in
  // the board roster too, or the dispatcher cannot tell whether it worked.
  const refreshAll = useCallback(() => setBoardNonce((n) => n + 1), []);

  async function act(body) {
    setBusy(true);
    setErr('');
    try {
      await api.adminPost(session.token, body);
      await reload();
    } catch (e) {
      setErr(e?.message || 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pb-10">
      <Header
        title="Drivers"
        subtitle={`${drivers.length} credentials · ${session.displayName || session.driverNumber}`}
        right={
          <button type="button" onClick={onSignOut} className="p-2 -mr-2" aria-label="Sign out">
            <LogOut className="w-5 h-5" />
          </button>
        }
      />
      <div className="p-3 space-y-4">
        {err ? <Banner kind="error">{err}</Banner> : null}
        {ambiguous.length ? (
          <Banner kind="warn">
            <div className="font-medium">Alias claimed by more than one driver</div>
            {ambiguous.map((a) => (
              <div key={a.alias} className="text-xs">
                {a.alias} → {a.driverNumbers.join(', ')} (these drivers will be UNRESOLVED)
              </div>
            ))}
          </Banner>
        ) : null}

        {unmatched.length ? (
          <div className="space-y-2">
            <div className="text-sm font-medium text-slate-700">Unmatched sign-ins to review</div>
            {unmatched.map((u) => (
              <UnmatchedRow
                key={`${u.date}__${u.driverNumber}`}
                u={u}
                onAssign={(alias) =>
                  act({
                    action: 'add-alias',
                    driverNumber: u.driverNumber,
                    alias,
                    resolveId: `${u.date}__${u.driverNumber}`,
                  })
                }
                onDismiss={() => act({ action: 'resolve-unmatched', id: `${u.date}__${u.driverNumber}` })}
              />
            ))}
          </div>
        ) : null}

        <BoardToday
          rows={board}
          window={boardWindow}
          days={boardDays}
          onDays={setBoardDays}
          onAdd={openAdd}
          onAttach={setAttaching}
          busy={busy}
        />

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-medium text-slate-700">
            {shownDrivers.length === drivers.length
              ? `${drivers.length} credentials`
              : `${shownDrivers.length} of ${drivers.length} credentials`}
          </div>
          <button
            type="button"
            className="text-xs rounded-lg ring-1 ring-slate-300 bg-white px-2 py-1"
            onClick={() => openAdd('')}
          >
            Add a driver
          </button>
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search credentials by number, name or alias…"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />

        <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
          <table className="min-w-full text-sm">
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
                <tr key={d.driverNumber} className="border-t border-slate-100">
                  <td className="px-2 py-2 font-mono">{d.driverNumber}</td>
                  <td className="px-2 py-2">{d.displayName || '—'}</td>
                  <td className="px-2 py-2 text-xs">{d.nuvizzAliases.join(', ') || <span className="text-rose-600">none</span>}</td>
                  {/* Role was a bare <select> that applied on change — one stray
                      scroll over a focused control granted somebody dispatcher
                      rights. It now stages the choice and needs a confirm. */}
                  <td className="px-2 py-2 text-xs">
                    {roleDraft && roleDraft.driverNumber === d.driverNumber ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="font-medium">{roleDraft.role}</span>
                        <button
                          type="button"
                          disabled={busy}
                          className="text-xs rounded bg-[#1e5b92] text-white px-2 py-0.5"
                          onClick={() => {
                            const r = roleDraft;
                            setRoleDraft(null);
                            act({ action: 'set-role', driverNumber: r.driverNumber, role: r.role });
                          }}
                        >
                          apply
                        </button>
                        <button type="button" className="text-xs underline text-slate-500" onClick={() => setRoleDraft(null)}>
                          cancel
                        </button>
                      </span>
                    ) : (
                      <select
                        value={d.role}
                        disabled={busy}
                        onChange={(e) => setRoleDraft({ driverNumber: d.driverNumber, role: e.target.value })}
                        className="rounded border border-slate-300 px-1 py-1 text-xs bg-white"
                        aria-label={`Role for ${d.driverNumber}`}
                      >
                        <option value="driver">driver</option>
                        <option value="loader">loader</option>
                        <option value="dispatcher">dispatcher</option>
                      </select>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {d.active ? <span className="text-emerald-700">yes</span> : <span className="text-rose-700">no</span>}
                    {d.lockedUntil ? <div className="text-[10px] text-amber-700">locked</div> : null}
                  </td>
                  <td className="px-2 py-2 text-xs">{d.lastLoginAt ? fmtDateTime(d.lastLoginAt) : '—'}</td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    <button type="button" className="text-xs underline mr-2" onClick={() => { setPrefill(null); setEditing(d); }}>edit</button>
                    <span className="mr-2">
                      {d.active ? (
                        // Deactivating strands a driver: they cannot sign in and
                        // load-manifest 403s them. Never a single click.
                        <ConfirmAction
                          label="deactivate"
                          confirmLabel="really deactivate"
                          disabled={busy}
                          onConfirm={() => act({ action: 'set-active', driverNumber: d.driverNumber, active: false })}
                        />
                      ) : (
                        <button
                          type="button"
                          className="text-xs underline"
                          disabled={busy}
                          onClick={() => act({ action: 'set-active', driverNumber: d.driverNumber, active: true })}
                        >
                          reactivate
                        </button>
                      )}
                    </span>
                    {d.lockedUntil ? (
                      <button
                        type="button"
                        className="text-xs underline"
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

      {editing || prefill ? (
        <Modal
          title={editing ? `${editing.driverNumber} · ${editing.displayName || 'driver'}` : 'Add a driver'}
          onClose={closeEditor}
        >
          <DriverEditor
            key={editing?.driverNumber || `new:${prefill?.alias || ''}`}
            driver={editing}
            prefill={editing ? null : prefill}
            busy={busy}
            onCancel={closeEditor}
            onSave={async (body) => { await act(body); refreshAll(); closeEditor(); }}
            onAddAlias={async (alias) => {
              await act({ action: 'add-alias', driverNumber: editing.driverNumber, alias });
              refreshAll();
            }}
            onRemoveAlias={async (alias) => {
              await act({ action: 'remove-alias', driverNumber: editing.driverNumber, alias });
              refreshAll();
            }}
            onIssuePin={async (driverNumber, pin, forceChange) =>
              act({ action: 'issue-pin', driverNumber, pin, forceChange: forceChange === true })}
          />
        </Modal>
      ) : null}

      {attaching ? (
        <Modal title={`Attach “${attaching}” to a driver`} onClose={() => setAttaching(null)}>
          <div className="text-sm text-slate-600">
            Pick the credential this person already has. The name is added to their aliases — nothing else on the
            credential changes, and you do not have to retype anything.
          </div>
          <CredentialPicker
            creds={drivers}
            busy={busy}
            onPick={async (c) => {
              const alias = attaching;
              setAttaching(null);
              await act({ action: 'add-alias', driverNumber: c.driverNumber, alias });
              refreshAll();
            }}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function DriverEditor({ driver, prefill, onSave, onCancel, onIssuePin, onAddAlias, onRemoveAlias, busy }) {
  const [driverNumber, setDriverNumber] = useState(driver?.driverNumber || '');
  const [displayName, setDisplayName] = useState(driver?.displayName || prefill?.displayName || '');
  // NEW drivers still stage their aliases locally — there is no credential to
  // attach them to until Save. An EXISTING driver edits them one at a time
  // through add-alias / remove-alias so a slip cannot wipe the set.
  const [newAliases, setNewAliases] = useState(prefill?.alias ? [prefill.alias] : []);
  const [pin, setPin] = useState('');
  const [forceChange, setForceChange] = useState(false);

  return (
    <div className="space-y-3">
      {prefill?.alias ? (
        <div className="text-xs text-slate-600">
          Setting up <span className="font-semibold">{prefill.alias}</span> from the board. Give them the driver number
          off their paperwork, save, then issue a PIN.
        </div>
      ) : null}
      <label className="block">
        <span className="text-xs text-slate-600">Driver number{driver ? '' : ' — from their paperwork'}</span>
        <input
          value={driverNumber}
          onChange={(e) => setDriverNumber(e.target.value)}
          disabled={!!driver}
          placeholder="e.g. 4471"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
        />
      </label>
      <label className="block">
        <span className="text-xs text-slate-600">Display name</span>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Display name"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      <AliasChips
        aliases={driver ? (driver.nuvizzAliases || []) : newAliases}
        busy={busy}
        onAdd={(a) => (driver ? onAddAlias(a) : setNewAliases((v) => [...new Set([...v, a.trim().toUpperCase()])]))}
        onRemove={(a) => (driver ? onRemoveAlias(a) : setNewAliases((v) => v.filter((x) => x !== a)))}
      />
      {driver ? (
        <div className="text-xs text-slate-500">
          Alias changes save immediately. Everything else needs Save.
        </div>
      ) : null}

      <div className="flex gap-2">
        <BigButton
          disabled={busy || !driverNumber.trim()}
          onClick={() =>
            onSave({
              action: 'upsert',
              driverNumber: driverNumber.trim(),
              displayName,
              // For an existing driver send back the set UNCHANGED — the chips
              // already wrote any edits. Deriving it from a text field here is
              // what let a careless keystroke silently delete a spelling.
              nuvizzAliases: driver ? (driver.nuvizzAliases || []) : newAliases,
            })
          }
        >
          Save
        </BigButton>
        <BigButton tone="ghost" onClick={onCancel}>Cancel</BigButton>
      </div>
      {driver ? (
        <div className="pt-1 space-y-2">
          <div className="flex gap-2 items-center">
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              inputMode="numeric"
              placeholder="PIN"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={busy || !/^\d{4,6}$/.test(pin)}
              onClick={async () => {
                await onIssuePin(driver.driverNumber, pin, forceChange);
                setPin('');
                setForceChange(false);
              }}
              className="rounded-lg bg-[#1e5b92] text-white px-3 py-2 text-sm disabled:opacity-50"
            >
              Issue
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={forceChange}
              onChange={(e) => setForceChange(e.target.checked)}
              className="w-4 h-4"
            />
            Driver must replace it at next sign-in (one-off reset). Issued PINs are standing PINs otherwise.
          </label>
        </div>
      ) : null}
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [session, setSession] = useState(() => loadSession());
  const [manifest, setManifest] = useState(null);
  const [activeLoad, setActiveLoad] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const date = etToday();

  const getManifest = useCallback(
    async (opts = {}) => {
      if (!session?.token) return;
      setLoading(true);
      setErr('');
      const key = store.cacheKey(date, session.driverNumber);
      try {
        const r = await api.fetchManifest(session.token, { date, ...opts });
        setManifest(r);
        await store.putCache(key, r);
        const loads = r.loads || [];
        // A lone load opens itself — except in the loader pick-list, where the
        // rows carry no stops and one truck on the dock is still a choice.
        if (loads.length === 1 && !r.summariesOnly) setActiveLoad(loads[0].loadNbr);
      } catch (e) {
        if (e?.status === 401) {
          clearSession();
          setSession(null);
          return;
        }
        // Offline: the cached manifest is the whole point.
        const cached = await store.getCache(key);
        if (cached?.value) {
          setManifest(cached.value);
          const loads = cached.value.loads || [];
          if (loads.length === 1) setActiveLoad(loads[0].loadNbr);
          setErr(`Working from the copy saved ${fmtDateTime(cached.at)}.`);
        } else {
          setErr(e?.offline ? 'No connection and no saved manifest yet.' : e?.message || 'Could not load the manifest.');
        }
      } finally {
        setLoading(false);
      }
    },
    [session, date],
  );

  useEffect(() => {
    if (session?.token && !session.mustChangePin && session.role !== 'dispatcher') getManifest();
  }, [session, getManifest]);

  useEffect(() => {
    store.pruneSynced().catch(() => {});
  }, []);

  function signOut() {
    clearSession();
    setSession(null);
    setManifest(null);
    setActiveLoad(null);
  }

  if (!session) {
    return (
      <div className="min-h-full">
        <Header title="Load Scan" subtitle="Davis Delivery" />
        <LoginScreen
          onLoggedIn={(s) => {
            saveSession(s);
            setSession(s);
          }}
        />
      </div>
    );
  }

  if (session.mustChangePin) {
    return (
      <div className="min-h-full">
        <Header title="Set your PIN" subtitle={session.displayName || session.driverNumber} />
        <ChangePinScreen
          session={session}
          onDone={() => {
            const next = { ...session, mustChangePin: false };
            saveSession(next);
            setSession(next);
          }}
        />
      </div>
    );
  }

  if (session.role === 'dispatcher') {
    return <DispatcherScreen session={session} onSignOut={signOut} />;
  }

  if (activeLoad && manifest) {
    return (
      <ScanScreen
        session={session}
        manifest={manifest}
        activeLoad={activeLoad}
        loader={session.role === 'loader'}
        // The loader's manifest currently holds only the truck they picked, so
        // going back has to re-read the day's pick list for the next one.
        onSwitchLoad={async () => {
          setActiveLoad(null);
          if (session.role === 'loader') await getManifest();
        }}
        onSignOut={signOut}
      />
    );
  }

  return (
    <div className="min-h-full">
      <Header
        title="Your load"
        subtitle={`${fmtDate(date)} · ${session.displayName || session.driverNumber}`}
        right={
          <button type="button" onClick={signOut} className="p-2 -mr-2" aria-label="Sign out">
            <LogOut className="w-5 h-5" />
          </button>
        }
      />
      <div className="p-3 space-y-3">
        {err ? <Banner kind="warn">{err}</Banner> : null}
        {loading ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin" /> Checking today's board…
          </div>
        ) : manifest ? (
          <LoadPicker
            manifest={manifest}
            busy={loading}
            loader={session.role === 'loader'}
            // A summary row has no stops: fetch the chosen load before opening
            // it. Same ?loadNbr path the manual entry already used.
            onPick={async (loadNbr) => {
              if (manifest.summariesOnly) await getManifest({ loadNbr });
              setActiveLoad(loadNbr);
            }}
            onManual={async (loadNbr) => {
              await getManifest({ loadNbr });
              setActiveLoad(loadNbr);
            }}
            onRefresh={() => getManifest()}
          />
        ) : (
          <BigButton onClick={() => getManifest()}>Try again</BigButton>
        )}
        <div className="text-[10px] text-slate-400 text-center pt-4">
          Load Scan v{APP_VERSION} · {BUILD_COMMIT} · {BUILD_CONTEXT}
        </div>
      </div>
    </div>
  );
}
