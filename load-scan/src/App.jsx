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
import { evaluateScan, loadProgress, stopProgress, ogGapHint, OUTCOME, normalizePro } from './lib/scan-logic.js';
import { useSortable, SortableTh } from './lib/useSortable.jsx';

// Bumped by hand on every change. load-scan versions independently of dispatch-map.
const APP_VERSION = '0.3.0';

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

function LoadPicker({ manifest, onPick, onManual, onRefresh, busy }) {
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
      <div className="text-sm text-slate-600">{fmtDate(manifest?.date)} · pick your load</div>
      {loads.map((l) => (
        <button
          key={l.loadNbr}
          type="button"
          onClick={() => onPick(l.loadNbr)}
          className="w-full text-left rounded-xl bg-white ring-1 ring-slate-200 px-4 py-3 hover:bg-slate-50 flex items-center gap-3"
        >
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-900 truncate">{l.loadNbr}</div>
            <div className="text-xs text-slate-500">
              {l.stopCount} stops · {l.expectedPieces} pieces
            </div>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-400" />
        </button>
      ))}
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

function StopRow({ stop, progress }) {
  const gaps = progress.complete ? null : ogGapHint(progress.ogs);
  const tone = progress.complete
    ? 'bg-emerald-50 ring-emerald-200'
    : progress.scanned > 0
      ? 'bg-amber-50 ring-amber-200'
      : 'bg-white ring-slate-200';
  return (
    <div className={`rounded-xl px-3 py-2 ring-1 ${tone}`}>
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-slate-500 w-6 shrink-0">{stop.loadStopSeq ?? stop.routeSeq ?? '—'}</span>
        <span className="font-medium text-slate-900 truncate flex-1">{stop.businessName || stop.stopNbr}</span>
        <span className="font-mono text-sm">
          {progress.scanned}/{progress.expected}
        </span>
      </div>
      <div className="mt-0.5 pl-8 text-xs text-slate-500 flex flex-wrap gap-x-2">
        <span>{stop.city}{stop.state ? `, ${stop.state}` : ''}</span>
        <span>PRO {stop.pros.join(', ')}</span>
        <span>{stop.skids} skids · {stop.loose} loose</span>
        {stop.appointmentRequired ? <span className="text-amber-700 font-medium">APPT</span> : null}
      </div>
      {gaps ? (
        <div className="mt-1 pl-8 text-xs text-slate-500">
          Possible gap at {gaps.join(', ')} — a piece may still be on the dock.
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
          {progress.scanned} of {progress.expected} pieces scanned
        </div>

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

function ScanScreen({ session, manifest, activeLoad, onSwitchLoad, onSignOut }) {
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
  const [pending, setPending] = useState(0);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [manualPro, setManualPro] = useState('');
  const [manualOg, setManualOg] = useState('');

  const load = useMemo(
    () => (manifest?.loads || []).find((l) => l.loadNbr === activeLoad) || null,
    [manifest, activeLoad],
  );
  const stops = load?.stops || [];
  const otherLoads = useMemo(
    () => (manifest?.loads || []).filter((l) => l.loadNbr !== activeLoad)
      .map((l) => ({ loadNbr: l.loadNbr, driverName: l.stops?.[0]?.raw?.driverName || null, stops: l.stops })),
    [manifest, activeLoad],
  );
  const progress = useMemo(() => loadProgress(stops, scans), [stops, scans]);
  const scannedOgs = useMemo(() => new Set(scans.map((s) => String(s.og).toUpperCase())), [scans]);

  // Rehydrate this load's scans from the local queue — the UI's source of truth.
  const refreshLocal = useCallback(async () => {
    if (!activeLoad) return;
    const rows = await store.queuedFor(activeLoad);
    setScans(rows.map((r) => ({ og: r.og, pro: r.pro, scannedAt: r.scannedAt, stopNbr: r.stopNbr, engine: r.engine })));
    setPending(rows.filter((r) => !r.syncedAt).length);
  }, [activeLoad]);

  useEffect(() => {
    refreshLocal();
  }, [refreshLocal]);

  // Record a piece: local first, ALWAYS, then try the network.
  const record = useCallback(
    async (pair, engineName) => {
      const evaluated = evaluateScan(pair, stops, scannedOgs, otherLoads);
      if (evaluated.outcome === OUTCOME.SILENT) return; // no prompt, no button, no decision
      setResult(evaluated);
      setPartial({ pro: null, og: null });

      if (evaluated.outcome === OUTCOME.RED) {
        // A red piece is NOT recorded against this load — it is not on it.
        if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
        return;
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
      await refreshLocal();
      flushQueue();
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
        scans: rows.map(({ og, pro, scannedAt, stopNbr, engine: eng }) => ({ og, pro, scannedAt, stopNbr, engine: eng })),
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
        close: true,
        reconciliation: { resolvedBy, note },
      });
      setClosing(false);
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
        subtitle={`${fmtDate(manifest?.date)} · ${session.displayName || session.driverNumber}`}
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

        {/* Camera */}
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
            <ClipboardList className="w-4 h-4" /> {stops.length} stops
          </div>
          {stops.map((s) => (
            <StopRow key={s.stopNbr} stop={s} progress={stopProgress(s, scans)} />
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <BigButton tone="ghost" onClick={onSwitchLoad}>Switch load</BigButton>
          <BigButton onClick={() => setClosing(true)} disabled={!load}>Close load</BigButton>
        </div>

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
    </div>
  );
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

function DispatcherScreen({ session, onSignOut }) {
  const [drivers, setDrivers] = useState([]);
  const [unmatched, setUnmatched] = useState([]);
  const [ambiguous, setAmbiguous] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);

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

  const { sorted, sortKey, sortDir, toggle } = useSortable(drivers, 'driverNumber', 'asc');

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
              <div key={`${u.date}__${u.driverNumber}`} className="rounded-xl bg-amber-50 ring-1 ring-amber-200 px-3 py-2 text-sm">
                <div className="font-medium">
                  {u.displayName || u.driverNumber} · {fmtDate(u.date)}
                </div>
                <div className="text-xs text-slate-600 mt-1">
                  Seeded: {(u.seededAliases || []).join(', ') || 'none'}
                </div>
                <div className="text-xs text-slate-600">
                  On the board: {(u.boardAliases || []).slice(0, 12).join(', ')}
                  {(u.boardAliases || []).length > 12 ? ' …' : ''}
                </div>
                <button
                  type="button"
                  className="mt-2 text-xs underline"
                  onClick={() => act({ action: 'resolve-unmatched', id: `${u.date}__${u.driverNumber}` })}
                >
                  Mark reviewed
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <SortableTh label="Driver #" k="driverNumber" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <SortableTh label="Name" k="displayName" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <SortableTh label="Aliases" k="aliasCount" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
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
                  <td className="px-2 py-2">
                    {d.active ? <span className="text-emerald-700">yes</span> : <span className="text-rose-700">no</span>}
                    {d.lockedUntil ? <div className="text-[10px] text-amber-700">locked</div> : null}
                  </td>
                  <td className="px-2 py-2 text-xs">{d.lastLoginAt ? fmtDateTime(d.lastLoginAt) : '—'}</td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    <button type="button" className="text-xs underline mr-2" onClick={() => setEditing(d)}>edit</button>
                    <button
                      type="button"
                      className="text-xs underline mr-2"
                      disabled={busy}
                      onClick={() => act({ action: 'set-active', driverNumber: d.driverNumber, active: !d.active })}
                    >
                      {d.active ? 'deactivate' : 'reactivate'}
                    </button>
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

        <DriverEditor
          key={editing?.driverNumber || 'new'}
          driver={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            await act(body);
            setEditing(null);
          }}
          onIssuePin={async (driverNumber, pin) => act({ action: 'issue-pin', driverNumber, pin })}
        />
      </div>
    </div>
  );
}

function DriverEditor({ driver, onSave, onCancel, onIssuePin, busy }) {
  const [driverNumber, setDriverNumber] = useState(driver?.driverNumber || '');
  const [displayName, setDisplayName] = useState(driver?.displayName || '');
  const [aliasText, setAliasText] = useState((driver?.nuvizzAliases || []).join(', '));
  const [pin, setPin] = useState('');

  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-200 p-3 space-y-2">
      <div className="text-sm font-medium text-slate-700">
        {driver ? `Edit ${driver.driverNumber}` : 'Add a driver'}
      </div>
      <input
        value={driverNumber}
        onChange={(e) => setDriverNumber(e.target.value)}
        disabled={!!driver}
        placeholder="Driver number"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
      />
      <input
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="Display name"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
      <label className="block">
        <span className="text-xs text-slate-600">
          NuVizz aliases, comma separated — every spelling that shows up for this person
        </span>
        <input
          value={aliasText}
          onChange={(e) => setAliasText(e.target.value)}
          placeholder="BRAD, BRAD GOODROE"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
        />
      </label>
      <div className="flex gap-2">
        <BigButton
          tone="ghost"
          disabled={busy || !driverNumber}
          onClick={() =>
            onSave({
              action: 'upsert',
              driverNumber: driverNumber.trim(),
              displayName,
              nuvizzAliases: aliasText.split(',').map((s) => s.trim()).filter(Boolean),
            })
          }
        >
          Save
        </BigButton>
        {driver ? <BigButton tone="ghost" onClick={onCancel}>Cancel</BigButton> : null}
      </div>
      {driver ? (
        <div className="pt-1 flex gap-2 items-center">
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            inputMode="numeric"
            placeholder="Temp PIN"
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={busy || !/^\d{4,6}$/.test(pin)}
            onClick={async () => {
              await onIssuePin(driver.driverNumber, pin);
              setPin('');
            }}
            className="rounded-lg bg-[#1e5b92] text-white px-3 py-2 text-sm disabled:opacity-50"
          >
            Issue
          </button>
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
        if (loads.length === 1) setActiveLoad(loads[0].loadNbr);
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
        onSwitchLoad={() => setActiveLoad(null)}
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
            onPick={setActiveLoad}
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
