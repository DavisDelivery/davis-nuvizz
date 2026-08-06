import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PackageCheck, ScanLine, CheckCircle2, XCircle, AlertTriangle, RefreshCw, CloudOff,
  LogOut, Users, ClipboardList, Camera, KeyRound, ChevronRight,
} from 'lucide-react';

import { fmtDate, fmtDateTime, etToday } from './lib/fmt.js';
import { shiftDayString } from './lib/shift.js';
import { watchForUpdate, applyUpdate } from './lib/appupdate.js';
import ReportScreen from './ReportScreen.jsx';
import AssignScreen from './AssignScreen.jsx';
import { loadSession, saveSession, clearSession, daysRemaining } from './lib/session.js';
import * as api from './lib/api.js';
import * as store from './lib/offline.js';
import { startScanner } from './lib/scanner.js';
import { evaluateScan, loadProgress, stopProgress, ogGapHint, OUTCOME, normalizePro, createPairBuffer, createScanGate, sortForLoading, splitPickups, renumberPositions, loadOrder, loadGroupCount, deliverySeq, sequenceFingerprint, classifyBarcode } from './lib/scan-logic.js';
import { createWedgeAccumulator, WEDGE_PAIR_WINDOW_MS } from './lib/wedge.js';
import { initAudio, playVerdict } from './lib/feedback.js';
import { useSortable, SortableTh } from './lib/useSortable.jsx';
import { partitionBoardRows, filterCredentials, availableAliases, loginNamesFor } from './lib/roster.js';

// Bumped by hand on every change. load-scan versions independently of dispatch-map.
/**
 * How long the same PRO is ignored after a good read.
 *
 * A pallet sits in frame for a second or more after the decode lands, and the
 * loader is still walking. Every one of those frames is the SAME piece. 3s is
 * long enough to cover the walk-away and short enough that a genuine second
 * piece of the same PRO is not annoying to book.
 */
const SAME_PRO_COOLDOWN_MS = 3000;

const APP_VERSION = '0.26.0';

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
      {/* Version, far right on every screen. Bumped on every merged PR, so
          "which build is that phone on" is answered by looking at it rather
          than by asking the driver to describe what they see. */}
      <span className="text-[11px] font-mono text-white/70 shrink-0 tabular-nums" title={`build ${BUILD_COMMIT}`}>
        v{APP_VERSION}
      </span>
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
              : 'That sign-in is not right. Use your name exactly as it shows on the board, plus your PIN — the last 4 of your cell.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="p-4 space-y-4 max-w-sm mx-auto">
      <Banner kind="info">Sign in once. You stay signed in for 90 days, even with no signal.</Banner>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">Your name, as it shows on the board</span>
        <input
          value={driverNumber}
          onChange={(e) => setDriverNumber(e.target.value)}
          autoComplete="username"
          autoCapitalize="characters"
          className="mt-1 w-full rounded-xl border border-slate-300 px-4 py-3 text-lg tracking-wide"
          placeholder="e.g. MICHAEL FRYE"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700">PIN — last 4 of your cell</span>
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

function LoadPicker({ manifest, onPick, onManual, onRefresh, busy, loader, assigned = [] }) {
  const [manual, setManual] = useState('');
  const all = manifest?.loads || [];

  // Trucks handed to this person come first, under their own heading. A loader
  // with five of twenty trucks should not have to hunt the list for them — but
  // the other fifteen stay visible and pickable, because assignment steers the
  // work and never gates it.
  const mine = new Set((assigned || []).map(String));
  const loads = mine.size
    ? [...all.filter((l) => mine.has(String(l.loadNbr))), ...all.filter((l) => !mine.has(String(l.loadNbr)))]
    : all;

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
      {loads.map((l, i) => (
        <React.Fragment key={l.loadNbr}>
          {mine.size && i === 0 ? (
            <div className="text-xs font-semibold text-[#1e5b92] pt-1">Your trucks</div>
          ) : null}
          {mine.size && i === mine.size ? (
            <div className="text-xs font-semibold text-slate-500 pt-2">Everything else on the dock</div>
          ) : null}
        <button
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
        </React.Fragment>
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

/**
 * Everything known about one order, in the shape of the WMS lookup card.
 *
 * Two ways in — tapping a stop in the list, or Look Up on a typed PRO — because
 * they are the same question: "what is this order and where does it go?".
 *
 * Built ENTIRELY from the cached manifest, so it is instant, works with no
 * signal, and costs ZERO NuVizz calls. The WMS card fetches per lookup; here the
 * consignee, address, stop, pieces, skids/loose, weight and appointment flag are
 * already on the phone. Order contents and seal are the only fields that would
 * need a live vendor call, so they are not shown rather than faked.
 */
/** "2026-08-05T14:30:00" -> "2:30 PM". Anything unparseable is shown as-is. */
function clockTime(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function OrderCard({ stop, progress, groupCount, onClose, onAddPiece }) {
  if (!stop) return null;
  const cityLine = [[stop.city, stop.state].filter(Boolean).join(', '), stop.zip].filter(Boolean).join(' ');
  const addr = [stop.addr1, cityLine].filter(Boolean).join('\n');
  const mapQ = encodeURIComponent([stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', '));
  const window_ = [stop.plannedFrom, stop.plannedTo].filter(Boolean).map(clockTime).join(' - ');

  const Field = ({ label, children, wide }) => (
    <div className={wide ? 'col-span-2' : ''}>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm text-slate-900 whitespace-pre-line">{children || '—'}</div>
    </div>
  );

  return (
    <Modal title={stop.businessName || stop.stopNbr} onClose={onClose}>
      {stop.appointmentRequired ? (
        <Banner kind="warn">
          <span className="font-semibold">APPOINTMENT REQUIRED</span> — do not deliver without one.
        </Banner>
      ) : null}
      {stop.scannable === false ? (
        <Banner kind="info">No barcode this app can read on this freight — confirm it by hand.</Banner>
      ) : null}

      <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2">
        <div className="text-2xl font-semibold tabular-nums">
          {progress.scanned}/{progress.expected}
          <span className="text-sm font-normal text-slate-500"> pieces loaded</span>
        </div>
        {progress.short ? <div className="text-sm text-rose-700 font-medium">{progress.short} still to load</div> : null}
        {progress.complete ? <div className="text-sm text-emerald-700 font-medium">This stop is complete</div> : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="PRO">{stop.pros.join(', ')}</Field>
        <Field label="Stop #">{stop.stopNbr}</Field>
        <Field label="Load position">
          {stop.loadSeq != null ? `Load ${stop.loadSeq} of ${groupCount}` : '—'}
        </Field>
        <Field label="Delivery stop">{deliverySeq(stop) ?? '—'}</Field>
        <Field label="Address" wide>{addr}</Field>
        {window_ ? <Field label="Delivery window" wide>{window_}</Field> : null}
        {stop.contactName || stop.phone ? (
          <Field label="Contact" wide>{[stop.contactName, stop.phone].filter(Boolean).join(' \u00b7 ')}</Field>
        ) : null}
        <Field label="Skids / loose">{stop.skids} / {stop.loose}</Field>
        <Field label="Weight">{stop.weight ? `${stop.weight} lb` : '—'}</Field>
        <Field label="Route / Load">{[stop.routeName, stop.loadNbr].filter(Boolean).join(' · ')}</Field>
        {stop.sealNbr ? <Field label="Seal #">{stop.sealNbr}</Field> : null}
        <Field label="Pieces expected">
          {stop.expectedPieces}
          {stop.countIsEstimated ? ' (from skids + loose)' : ''}
        </Field>
        {stop.instructions ? <Field label="Instructions" wide>{stop.instructions}</Field> : null}
      </div>

      {/* The degraded path, and it belongs HERE rather than beside the search
          box: the count it changes is on screen, so a loader can see 2/3 become
          3/3 instead of typing a number into a field with no context. */}
      {onAddPiece && !progress.complete ? (
        <button
          type="button"
          onClick={onAddPiece}
          className="w-full rounded-lg ring-1 ring-slate-300 bg-white px-3 py-2 text-sm"
        >
          Can't scan it — add a piece by hand
        </button>
      ) : null}

      {mapQ ? (
        <a
          href={`https://maps.google.com/?q=${mapQ}`}
          target="_blank"
          rel="noreferrer"
          className="block text-center text-sm rounded-lg ring-1 ring-slate-300 bg-white px-3 py-2"
        >
          Open in Maps
        </a>
      ) : null}
    </Modal>
  );
}

function OutcomeCard({ result, partial }) {
  if (!result) {
    const need = partial?.pro ? 'OG barcode (upper)' : partial?.og ? 'PRO barcode (lower)' : null;
    return (
      <Banner kind="info">
        {need ? (
          <span className="font-medium">Hold steady — need the {need}</span>
        ) : (
          <span>Point at the PRO barcode.</span>
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
  const base = 'fixed inset-0 z-[60] flex flex-col items-center justify-center text-center p-6 select-none';

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

function StopRow({ stop, progress, onHandConfirm, onOpen, groupCount, trailerEnd, sharesPosition }) {
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
      {/* The whole row opens the order — address, pieces, instructions. A
          loader holding a pallet wants the detail, not just the tally. */}
      <button type="button" onClick={onOpen} className="w-full text-left flex items-baseline gap-2">
        <span className="text-sm font-semibold text-slate-700 w-6 shrink-0 tabular-nums">{stop.loadSeq ?? '—'}</span>
        <span className="font-medium text-slate-900 truncate flex-1">{stop.businessName || stop.stopNbr}</span>
        <span className="font-mono text-sm">
          {progress.scanned}/{progress.expected}
        </span>
        <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
      </button>
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
      {/* The PRO is the number a loader matches against the label in their hand,
          so it is the one thing on this row that must be readable at arm's length
          under a dock light. It was the same small grey text as the city. */}
      <div className="mt-1 pl-8">
        <span className="font-mono text-lg font-bold tracking-wide text-slate-900">
          {stop.pros.join(', ')}
        </span>
      </div>
      <div className="mt-0.5 pl-8 text-xs text-slate-500 flex flex-wrap gap-x-2">
        <span>{stop.city}{stop.state ? `, ${stop.state}` : ''}</span>
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
  // Raw decoder output. The dock has no console: without this, "the scanner
  // doesn't work" cannot be told apart from "it read something and the rules
  // rejected it", and those need opposite fixes.
  const [rawLog, setRawLog] = useState([]);
  // A repeat PRO waiting for a deliberate tap before it books another piece.
  const [dupPending, setDupPending] = useState(null);
  /**
   * The scan gate, and it MUST be a ref.
   *
   * Quagga fires ~20 frames a second. `record` is a useCallback closing over
   * `scans`, so several calls run before React re-renders and every one of them
   * sees the same stale array — each concludes "no prior scan for this PRO" and
   * each books a piece. That is how a 2-skid stop reached 3/2 on the dock: not a
   * scanning fault, a state-timing fault.
   *
   * A ref updates synchronously, so the second frame sees what the first did.
   */
  const gate = useRef(createScanGate({ cooldownMs: SAME_PRO_COOLDOWN_MS }));
  /** Guards against two frames both passing the gate while the first is still awaiting. */
  const recording = useRef(false);
  // The order whose card is open — from a stop tap or a PRO lookup.
  const [openStop, setOpenStop] = useState(null);
  const rawSeen = useRef(0);
  const [manualPro, setManualPro] = useState('');

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

  // Pickups are not loading work. They come off the loading list entirely and
  // get their own short section, so the first thing on the truck is something
  // the loader can actually do.
  const { loading: loadableStops, pickups } = useMemo(() => splitPickups(displayStops), [displayStops]);
  // Renumbered so the positions are contiguous once pickups are out — otherwise
  // the last delivery reads "Load 3 of 2".
  const loadingOrder = useMemo(() => renumberPositions(loadOrder(loadableStops)), [loadableStops]);
  const groupCount = useMemo(() => loadGroupCount(loadingOrder), [loadingOrder]);

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
      // A PRO with no OG. The piece is real, but there is no per-piece id to
      // de-duplicate on, so a label drifting back into view minutes later would
      // silently count twice. The WMS solved this by never auto-logging a
      // repeat: first read logs, every read after that asks for a tap.
      // Three ways a piece arrives, and they get different guards:
      //   scanner   camera frames — needs the cooldown AND the count check
      //   manual    typed by hand — needs the count check, no cooldown
      //   override  a deliberate tap on "Another piece" — bypasses both, because
      //             the loader is asserting the paperwork is wrong
      const isOverride = engineName === 'override';
      const isScanner = engineName !== 'manual' && !isOverride;
      if (isOverride) engineName = 'manual';

      // A stop cannot hold more pieces than the manifest says, however the piece
      // got here — scanned, typed, or replayed. This sits above the OG branch on
      // purpose: an earlier version checked only inside it, and the typed path
      // (which mints its own TYPED- id) walked straight past to 8/2.
      // Only a deliberate override gets through.
      if (!isOverride) {
        const p7 = normalizePro(pair.pro);
        const owner = stops.find((s2) => (s2.pros || []).some((x) => normalizePro(x) === p7));
        if (owner) {
          const done = stopProgress(owner, scans, handConfirms);
          if (done.expected > 0 && done.scanned >= done.expected) {
            setDupPending({ pro: p7, count: done.scanned, full: owner.businessName, expected: done.expected });
            return null;
          }
        }
      }

      if (!pair.og) {
        const pro7 = normalizePro(pair.pro);
        const now = Date.now();

        if (isScanner) {
          // One piece at a time, and one label at a time — both decided
          // synchronously, because React's state is exactly what is behind here.
          if (recording.current) return null;
          if (!gate.current.allow(pro7, now)) return null;
        }

        const already = scans.filter((s2) => normalizePro(s2.pro) === pro7).length;
        if (already > 0 && isScanner) {
          setDupPending({ pro: pro7, count: already });
          return null;
        }

        // A stop can never hold more pieces than the manifest says. Refuse the
        // extra and say which stop, rather than quietly printing 3/2.
        if (isScanner) recording.current = true;
        let n = 1;
        const used = new Set(scans.map((s2) => String(s2.og).toUpperCase()));
        while (used.has(`NOOG-${pro7}-${n}`)) n += 1;
        pair = { ...pair, og: `NOOG-${pro7}-${n}` };
      }
      const evaluated = evaluateScan(pair, stops, scannedOgs, otherLoads);
      recording.current = false;
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
        onPair: async (p) => announce(await record(p, p.engine)),
        onPartial: setPartial,
        onStatus: setStatus,
        onRaw: (values) => {
          rawSeen.current += values.length;
          setRawLog((prev) => [
            ...values.map((v) => ({ v: String(v), kind: classifyBarcode(v).kind })),
            ...prev,
          ].slice(0, 6));
        },
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
    announce(evaluated);
  };

  /**
   * Show the verdict for a recorded piece — full screen, with the sound.
   *
   * This used to live inside the scanner-gun handler alone, so a piece scanned
   * with the CAMERA produced no flash and no beep: the only feedback was a small
   * card changing text further down the screen. On a dock, holding a phone at a
   * pallet, that is invisible — which is why "did that scan?" was being answered
   * by scanning again.
   */
  function announce(evaluated) {
    if (!evaluated) return;
    const kind =
      evaluated.outcome === OUTCOME.SILENT ? 'dup'
        : evaluated.outcome === OUTCOME.RED ? 'red'
          : evaluated.outcome === OUTCOME.AMBER ? 'amber'
            : 'green';
    playVerdict(kind);
    if (navigator.vibrate) navigator.vibrate(kind === 'red' ? [80, 60, 80] : 40);
    setVerdict({ kind, evaluated, sticky: kind === 'red' });
  }

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
    const t = setTimeout(() => setVerdict(null), verdict.kind === 'green' ? 900 : 1400);
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

  /**
   * Add one piece by hand.
   *
   * The OG is OPTIONAL. It used to be required, so a torn, smudged or missing
   * OG barcode left the driver with no way to record the piece at all — the
   * form just refused. A PRO on its own now books one piece against that stop
   * under a synthetic id (TYPED-<pro>-<n>), which cannot collide with a real OG
   * and is stored as typed rather than scanned.
   */
  /** Find the order for a typed PRO and show its card. No network, no vendor calls. */
  function lookUpPro() {
    const pro = normalizePro(manualPro);
    if (!/^\d{7}$/.test(pro)) {
      setFlash('Enter the 7-digit PRO from the label.');
      return;
    }
    const hit = stops.find((s2) => (s2.pros || []).some((p) => normalizePro(p) === pro));
    if (!hit) {
      setFlash(`PRO ${pro} is not on this load.`);
      return;
    }
    setFlash('');
    setOpenStop(hit);
  }

  async function addManual() {
    return addManualFor(manualPro);
  }

  async function addManualFor(proInput) {
    const pro = normalizePro(proInput);
    if (!/^\d{7}$/.test(pro)) {
      setFlash('Enter the 7-digit PRO from the label.');
      return;
    }
    // Next free index for this PRO, so adding three pieces books three.
    const used = new Set(scans.map((s) => String(s.og).toUpperCase()));
    let n = 1;
    while (used.has(`TYPED-${pro}-${n}`)) n += 1;
    const og = `TYPED-${pro}-${n}`;

    setFlash('');
    const evaluated = await record({ pro, og }, 'manual');
    announce(evaluated);
    if (evaluated?.outcome === OUTCOME.RED) setFlash(`PRO ${pro} is not on this load.`);
    setManualPro('');
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
      // Stop the clock. Fire-and-forget for the same reason clockIn is: the
      // load IS closed at this point, and a failed timing write must not tell
      // the driver otherwise. The report falls back to scan times if it misses.
      api
        .postWorkEvents(session.token, [
          {
            kind: 'finish',
            loadNbr: activeLoad,
            at: new Date().toISOString(),
            workerName: session.displayName,
            closedOut: true,
            pieces: progress.scanned,
          },
        ])
        .catch(() => {});

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
          <div className="relative rounded-xl overflow-hidden bg-slate-900 h-[195px]">
            {/* 195px fixed, the same as the WMS cam-wrap. An aspect ratio grows
                with screen width and pushed the stop list off the bottom; a
                fixed height keeps the orders visible on every handset. */}
            {/* Target outline, copied from the WMS scan-reticle. Without it the
                loader has no idea where in the frame the decoder is looking, and
                aims at the middle of a pallet instead of at the label. */}
            <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
              <div className="w-[90%] max-w-[320px] h-[85px] rounded border-2 border-amber-400 shadow-[0_0_0_2000px_rgba(0,0,0,0.2)]" />
            </div>
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
                {/* No inset ring any more. It drew a box at the old 15% Quagga
                    inset and told the driver to aim inside it, while the OG
                    barcode on a close-held label sits above that line. Both
                    engines now read the whole frame, so anything you can see is
                    a candidate — drawing a smaller target would be a lie. */}
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

        {/* Repeat PRO. Never auto-logged: walking a tall pallet drifts the same
            label back into view minutes later, far past any cooldown, so a
            timer cannot tell a second piece from a second look. A tap can. */}
        {dupPending ? (
          <div className="rounded-xl bg-amber-50 ring-1 ring-amber-300 px-3 py-3">
            <div className="text-sm text-amber-900 font-medium">
              {dupPending.full
                ? `${dupPending.full} is already complete — ${dupPending.count} of ${dupPending.expected}`
                : `PRO ${dupPending.pro} already logged ×${dupPending.count}`}
            </div>
            <div className="text-xs text-amber-900 mt-0.5">
              {dupPending.full
                ? 'The manifest says this stop is full. Only add another if the paperwork is wrong.'
                : 'Same label seen again. If this is another piece, tap to add it.'}
            </div>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                className="flex-1 text-sm rounded-lg ring-1 ring-slate-300 bg-white px-3 py-2"
                onClick={() => setDupPending(null)}
              >
                Same piece
              </button>
              <button
                type="button"
                className="flex-1 text-sm rounded-lg bg-[#1e5b92] text-white px-3 py-2 font-medium"
                onClick={() => {
                  const p = dupPending;
                  setDupPending(null);
                  gate.current.clear();
                  record({ pro: p.pro, og: null }, 'override');
                }}
              >
                Another piece
              </button>
            </div>
          </div>
        ) : null}

        {/* What the decoder is ACTUALLY seeing. Silence here means the camera
            is reading nothing (focus, lighting, engine); values here with the
            wrong shape mean it reads fine and the rules are rejecting them.
            Those two need opposite fixes and looked identical before. */}
        {camOn ? (
          <details className="rounded-xl bg-white ring-1 ring-slate-200 px-3 py-2 text-xs">
            <summary className="cursor-pointer text-slate-600">
              Scanner detail — {engine || '…'} · {rawSeen.current} read{rawSeen.current === 1 ? '' : 's'}
            </summary>
            {rawLog.length ? (
              <div className="mt-2 space-y-0.5 font-mono">
                {rawLog.map((r, i) => (
                  <div key={`${r.v}-${i}`} className={r.kind === 'unknown' ? 'text-rose-700' : 'text-emerald-700'}>
                    {r.kind.toUpperCase()} {r.v}
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-2 text-slate-500">
                Nothing decoded yet. If this stays empty while a label fills the frame, the camera is not reading —
                move 20–30cm back, steady, and make sure the label is lit.
              </div>
            )}
            {status ? <div className="mt-2 text-slate-500">{status}</div> : null}
          </details>
        ) : null}

        {/* One row, always visible. It was a dropdown holding four controls —
            a PRO field, an OG field and two buttons — which is three taps and a
            scroll to look up a number you are already holding. The OG field is
            gone entirely: since a PRO alone is a piece, typing an OG bought
            nothing the scanner does not do better.

            Adding a piece by hand moved onto the order card, where the count it
            is about is on screen. */}
        <div className="flex gap-2">
          <input
            value={manualPro}
            onChange={(e) => setManualPro(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') lookUpPro();
            }}
            inputMode="numeric"
            placeholder="PRO number"
            aria-label="PRO number"
            className="flex-1 min-w-0 rounded-xl border border-slate-300 px-3 py-3 text-base font-mono tracking-wide"
          />
          <button
            type="button"
            onClick={lookUpPro}
            className="shrink-0 rounded-xl bg-[#1e5b92] text-white px-5 py-3 text-base font-medium"
          >
            Look up
          </button>
        </div>

        {/* Stops */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <ClipboardList className="w-4 h-4" /> {loadableStops.length} stops · loading order
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
          {sortForLoading(
            loadingOrder.map((s) => ({ stop: s, progress: stopProgress(s, scans, handConfirms) })),
          ).map(({ stop: s, progress: sp }, i) => (
            <StopRow
              key={s.stopNbr}
              stop={s}
              progress={sp}
              onHandConfirm={handConfirm}
              onOpen={() => setOpenStop(s)}
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
                loadingOrder.filter((o) => o.loadSeq === s.loadSeq).length > 1
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

      {/* Pickups. Listed so nobody thinks the app lost a stop, but plainly
          separated: there is nothing to scan and nothing to load. */}
      {pickups.length ? (
        <div className="px-3 pb-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <ClipboardList className="w-4 h-4" /> {pickups.length} pickup{pickups.length === 1 ? '' : 's'} — not loaded
          </div>
          <div className="text-xs text-slate-500">
            Collected on the route, not put on the truck here. They are not counted in the piece total.
          </div>
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 divide-y divide-slate-200">
            {pickups.map((p) => (
              <button
                key={p.stopNbr}
                type="button"
                onClick={() => setOpenStop(p)}
                className="w-full text-left px-3 py-2 flex items-center gap-2"
              >
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 bg-white ring-1 ring-slate-300 rounded px-1.5 py-0.5 shrink-0">
                  Pickup
                </span>
                <span className="flex-1 min-w-0 truncate text-slate-700">{p.businessName || p.stopNbr}</span>
                <span className="text-xs text-slate-500">{p.city}</span>
                <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {openStop ? (
        <OrderCard
          stop={openStop}
          progress={stopProgress(openStop, scans, handConfirms)}
          groupCount={groupCount}
          onAddPiece={() => {
            const pro = openStop.primaryPro || openStop.pros?.[0];
            setOpenStop(null);
            addManualFor(pro);
          }}
          onClose={() => setOpenStop(null)}
        />
      ) : null}

      <VerdictFlash verdict={verdict} onClear={() => setVerdict(null)} />
    </div>
  );
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Exactly what this person can type on the sign-in screen.
 *
 * Sign-in is an EXACT match after normalizing — "ALFRED" does not match the
 * alias "ALFRED MORGAN". A dispatcher had no way to know that, so a driver
 * typing their first name got a flat refusal and nobody could see why. Every
 * usable string is listed; names claimed by two active credentials are called
 * out as dead, because the driver will try one and it will fail.
 *
 * A credential with no PIN cannot sign in at all, and that looked identical to
 * a wrong password. `hasPin` came back from the server all along and was never
 * shown.
 */
function SignsInAs({ cred, creds }) {
  const { works, broken, inactive } = useMemo(() => loginNamesFor(cred, creds), [cred, creds]);

  if (inactive) return <span className="text-slate-500">deactivated — cannot sign in</span>;

  return (
    <div className="space-y-0.5">
      {cred.hasPin === false ? (
        <div className="text-rose-700 font-medium">NO PIN — cannot sign in at all</div>
      ) : null}
      {works.length ? (
        works.map((n) => (
          <div key={n} className="font-mono">
            {n}
          </div>
        ))
      ) : (
        <div className="text-rose-700">nothing works — no usable name</div>
      )}
      {broken.map((b) => (
        <div key={b.name} className="text-rose-700">
          <span className="font-mono line-through">{b.name}</span>{' '}
          {b.signsInAsSomeoneElse ? `signs in as ${b.signsInAsSomeoneElse}` : 'shared, will fail'}
        </div>
      ))}
    </div>
  );
}

/**
 * The day on the dock: every truck, who worked it, and who never opened the app.
 *
 * Built from the BOARD, not from the scan sessions, so a truck nobody touched
 * still has a row — that absence is the thing worth catching, and a view built
 * from activity alone renders it invisible. Same for people: the list comes from
 * the credential roster, so someone who never signed in is visibly missing
 * rather than simply not there.
 */
function DayPanel({ data, date, onDate, busy, onRefresh, session }) {
  const [tab, setTab] = useState('trucks');
  if (!data) {
    return (
      <div className="rounded-xl bg-white ring-1 ring-slate-200 px-3 py-2 text-sm text-slate-500">
        Loading the day…
      </div>
    );
  }
  const t = data.totals || {};
  const loads = data.loads || [];
  const people = data.people || [];

  const TONE = {
    not_started: 'bg-rose-50 ring-rose-300 text-rose-900',
    in_progress: 'bg-amber-50 ring-amber-300 text-amber-900',
    closed_clean: 'bg-emerald-50 ring-emerald-200 text-emerald-900',
    closed_short: 'bg-rose-50 ring-rose-300 text-rose-900',
    closed_over: 'bg-rose-50 ring-rose-300 text-rose-900',
  };
  const LABEL = {
    not_started: 'NOT STARTED',
    in_progress: 'in progress',
    closed_clean: 'closed clean',
    closed_short: 'CLOSED SHORT',
    closed_over: 'CLOSED OVER',
  };

  const Stat = ({ n, label, bad }) => (
    <div className={`rounded-lg px-2 py-1 ring-1 ${bad && n > 0 ? 'bg-rose-50 ring-rose-300' : 'bg-white ring-slate-200'}`}>
      <div className={`text-lg font-semibold tabular-nums ${bad && n > 0 ? 'text-rose-700' : 'text-slate-800'}`}>{n}</div>
      <div className="text-[11px] text-slate-500 leading-tight">{label}</div>
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-sm font-medium text-slate-700 flex items-center gap-2">
          <ClipboardList className="w-4 h-4" /> The day
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => onDate(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
        />
        <button type="button" onClick={onRefresh} disabled={busy} className="text-xs underline text-slate-600">
          refresh
        </button>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1">
        <Stat n={t.loadsOnBoard || 0} label="trucks on board" />
        <Stat n={t.notStarted || 0} label="never started" bad />
        <Stat n={t.inProgress || 0} label="in progress" />
        <Stat n={t.closedShort || 0} label="closed short" bad />
        <Stat n={t.closedClean || 0} label="closed clean" />
        <Stat n={t.peopleUsedApp || 0} label="people used app" />
      </div>
      <div className="text-xs text-slate-500">
        {t.piecesScanned || 0} scanned + {t.piecesConfirmed || 0} hand-confirmed of {t.piecesExpected || 0} expected ·{' '}
        {t.loadersUsedApp || 0} loader(s), {t.driversUsedApp || 0} driver(s)
        {t.resequenced ? <span className="text-rose-700 font-medium"> · {t.resequenced} resequenced mid-load</span> : null}
      </div>

      <div className="flex gap-1 text-xs">
        {[
          ['trucks', `Trucks (${loads.length})`],
          ['people', `People (${people.length})`],
          ['assign', 'Assign'],
          ['report', 'Report'],
        ].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`rounded-lg px-2 py-1 ring-1 ${tab === k ? 'bg-[#1e5b92] text-white ring-[#1e5b92]' : 'bg-white ring-slate-300 text-slate-600'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'assign' ? (
        <AssignScreen session={session} loads={loads} people={people} />
      ) : tab === 'report' ? (
        <ReportScreen session={session} />
      ) : tab === 'trucks' ? (
        <div className="rounded-xl bg-white ring-1 ring-slate-200 divide-y divide-slate-100 max-h-96 overflow-y-auto">
          {loads.length ? (
            loads.map((l) => (
              <div key={l.loadNbr} className="px-3 py-2 text-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-medium">{l.loadNbr}</span>
                  <span className="text-slate-600 truncate flex-1 min-w-0">{l.driverName || '—'}</span>
                  <span className={`text-[11px] rounded px-1.5 py-0.5 ring-1 ${TONE[l.status]}`}>{LABEL[l.status]}</span>
                  <span className="font-mono text-xs tabular-nums">
                    {l.scannedCount}/{l.expectedPieces}
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-2">
                  <span>{l.stopCount} stop(s)</span>
                  {l.confirmedPieces ? <span className="text-sky-700">{l.confirmedPieces} by hand</span> : null}
                  {l.short ? <span className="text-rose-700 font-medium">{l.short} short</span> : null}
                  {l.over ? <span className="text-rose-700 font-medium">{l.over} over</span> : null}
                  {l.sequenceChanged ? <span className="text-rose-700 font-medium">resequenced mid-load</span> : null}
                  {l.workedBy?.length ? (
                    <span>
                      worked by {l.workedBy.map((w) => `${w.displayName} (${w.role}, ${w.pieces})`).join(', ')}
                    </span>
                  ) : (
                    <span className="text-rose-700 font-medium">nobody has touched this truck</span>
                  )}
                  {l.closedAt ? <span>closed {fmtDateTime(l.closedAt)}</span> : null}
                </div>
              </div>
            ))
          ) : (
            <div className="px-3 py-2 text-sm text-slate-500">No loads on the board for this date.</div>
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-white ring-1 ring-slate-200 divide-y divide-slate-100 max-h-96 overflow-y-auto">
          {people.map((p) => (
            <div key={p.driverNumber} className="px-3 py-2 text-sm flex items-center gap-2 flex-wrap">
              {p.usedAppToday ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <XCircle className="w-4 h-4 text-slate-300 shrink-0" />
              )}
              <span className="truncate flex-1 min-w-0">{p.displayName}</span>
              <span className="text-[11px] text-slate-500">{p.role}</span>
              {p.usedAppToday ? (
                <span className="text-xs text-slate-600">
                  {p.pieces} piece(s) · {p.loads.length} truck(s): <span className="font-mono">{p.loads.join(', ')}</span>
                </span>
              ) : (
                <span className="text-xs text-slate-400">
                  no activity{p.lastLoginAt ? ` · last signed in ${fmtDateTime(p.lastLoginAt)}` : ' · never signed in'}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
function AliasChips({ aliases, onAdd, onRemove, busy, available = [] }) {
  const [next, setNext] = useState('');
  const [q, setQ] = useState('');
  const add = () => {
    const v = next.trim();
    if (!v) return;
    setNext('');
    onAdd(v);
  };
  const shown = useMemo(() => {
    const needle = q.trim().toUpperCase();
    const list = needle ? available.filter((a) => a.alias.includes(needle)) : available;
    return list.slice(0, 60);
  }, [available, q]);

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

      {/* Names actually on the board that no live credential holds. A person
          runs under several spellings and a credential only matches the ones it
          has, so offer the real list instead of asking anyone to recall it. */}
      {available.length ? (
        <div className="mt-3 rounded-lg ring-1 ring-slate-200 p-2">
          <div className="text-xs text-slate-600">
            {available.length} name(s) on the board not used by any other driver — tap to add
          </div>
          {available.length > 8 ? (
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter…"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            />
          ) : null}
          <div className="mt-1 max-h-40 overflow-y-auto flex flex-wrap gap-1">
            {shown.length ? (
              shown.map((a) => (
                <button
                  key={a.alias}
                  type="button"
                  disabled={busy}
                  onClick={() => onAdd(a.alias)}
                  className="rounded-lg ring-1 ring-slate-300 bg-white px-2 py-1 text-xs hover:bg-sky-50 disabled:opacity-50"
                  title={a.heldByInactive.length ? `Currently on deactivated ${a.heldByInactive.join(', ')}` : undefined}
                >
                  <span className="font-mono">{a.alias}</span>
                  <span className="text-slate-400"> · {a.stops}</span>
                  {a.heldByInactive.length ? <span className="text-amber-700"> · on a deactivated account</span> : null}
                </button>
              ))
            ) : (
              <span className="text-xs text-slate-500">Nothing on the board matches “{q}”.</span>
            )}
          </div>
        </div>
      ) : null}
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
        placeholder="Search by name or alias…"
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
  const [activity, setActivity] = useState(null);
  const [activityDate, setActivityDate] = useState(etToday());
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

  // The day's activity. Its own read, on its own date, so changing the date does
  // not disturb the board roster or the credential list.
  useEffect(() => {
    let alive = true;
    api
      .scanActivity(session.token, activityDate)
      .then((r) => alive && setActivity(r))
      .catch((e) => alive && setErr(e?.message || 'Could not read the day.'));
    return () => { alive = false; };
  }, [session, activityDate, boardNonce]);

  const shownDrivers = useMemo(() => filterCredentials(drivers, query), [drivers, query]);
  const { sorted, sortKey, sortDir, toggle } = useSortable(shownDrivers, 'displayName', 'asc');

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

        <DayPanel
          session={session}
          data={activity}
          date={activityDate}
          onDate={setActivityDate}
          busy={busy}
          onRefresh={refreshAll}
        />

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
          placeholder="Find a driver by name or alias…"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />

        <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <SortableTh label="Name" k="displayName" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} />
                <th className="px-2 py-1 text-left font-medium">Signs in as</th>
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
                  <td className="px-2 py-2">{d.displayName || '—'}</td>
                  {/* There is no login-name field: sign-in matches the display
                      name AND every alias, and only when exactly one active
                      credential claims it. So show what actually works. */}
                  <td className="px-2 py-2 text-xs">
                    <SignsInAs cred={d} creds={drivers} />
                  </td>
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
            board={board}
            allCreds={drivers}
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

function DriverEditor({ driver, prefill, board, allCreds = [], onSave, onCancel, onIssuePin, onAddAlias, onRemoveAlias, busy }) {
  const [driverNumber, setDriverNumber] = useState(driver?.driverNumber || '');
  const [displayName, setDisplayName] = useState(driver?.displayName || prefill?.displayName || '');
  // NEW drivers still stage their aliases locally — there is no credential to
  // attach them to until Save. An EXISTING driver edits them one at a time
  // through add-alias / remove-alias so a slip cannot wipe the set.
  const [newAliases, setNewAliases] = useState(prefill?.alias ? [prefill.alias] : []);
  const [pin, setPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [forceChange, setForceChange] = useState(false);

  // Show what the PIN will actually be, so a pasted phone number is not a guess.
  const pinPreview = useMemo(() => {
    const d = newPin.replace(/\D/g, '');
    return d.length >= 4 ? d.slice(-4) : '';
  }, [newPin]);

  const held = driver ? (driver.nuvizzAliases || []) : newAliases;
  const availableForThisDriver = useMemo(() => availableAliases(board, held), [board, held]);

  return (
    <div className="space-y-3">
      {prefill?.alias ? (
        <div className="text-xs text-slate-600">
          Setting up <span className="font-semibold">{prefill.alias}</span> from the board. Check the name and PIN,
          add any other spellings they run under, then Save — that is the whole job.
        </div>
      ) : null}
      {/* Davis drivers have no number on their paperwork. They sign in with the
          name on the board and a PIN, so that is what this form asks for; the
          number is an internal key and the server generates it. */}
      <label className="block">
        <span className="text-xs text-slate-600">Name — what they type to sign in</span>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g. ALFRED MORGAN"
          autoCapitalize="characters"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      {!driver ? (
        <label className="block">
          <span className="text-xs text-slate-600">
            PIN — last 4 of their cell. Paste the whole number if easier.
          </span>
          <input
            value={newPin}
            onChange={(e) => setNewPin(e.target.value)}
            inputMode="numeric"
            placeholder="2099  or  (678) 226-2099"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          {newPin.trim() && !pinPreview ? (
            <span className="text-xs text-rose-600">Need at least 4 digits.</span>
          ) : pinPreview ? (
            <span className="text-xs text-slate-500">PIN will be <span className="font-mono">{pinPreview}</span></span>
          ) : (
            <span className="text-xs text-slate-500">Leave blank to set it later.</span>
          )}
        </label>
      ) : (
        <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2">
          <div className="text-xs text-slate-600">They sign in by typing one of these, exactly:</div>
          <div className="mt-1 text-sm">
            <SignsInAs cred={driver} creds={allCreds} />
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            It must match in full — “ALFRED” will not match “ALFRED MORGAN”. Add a short spelling above if they want
            to type less.
          </div>
        </div>
      )}

      <AliasChips
        aliases={driver ? (driver.nuvizzAliases || []) : newAliases}
        available={availableForThisDriver}
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
          // Gated on the NAME, not a number nobody has. That gate is what made
          // adding a driver impossible.
          disabled={busy || !displayName.trim() || (!!newPin.trim() && !pinPreview)}
          onClick={() =>
            onSave({
              action: 'upsert',
              // Blank on create: the server generates the internal key.
              driverNumber: driverNumber.trim(),
              displayName,
              ...(newPin.trim() ? { pin: pinPreview } : {}),
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

/**
 * "A new version is ready."
 *
 * Fixed to the bottom so it cannot push the scan button or the stop list around,
 * and dismissible — a driver mid-truck should be able to make it go away and take
 * the update between loads. It comes back on the next check if still pending.
 */
function UpdateBanner({ onApply, onDismiss }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3 pointer-events-none">
      <div className="pointer-events-auto mx-auto max-w-md rounded-xl bg-[#1e5b92] text-white shadow-lg px-3 py-2 flex items-center gap-2">
        <RefreshCw className="w-4 h-4 shrink-0" />
        <div className="flex-1 text-sm">
          <div className="font-medium">A new version is ready</div>
          <div className="text-[11px] text-white/80">Safe to take between trucks — nothing scanned is lost.</div>
        </div>
        <button type="button" onClick={onApply} className="rounded-lg bg-white text-[#1e5b92] px-3 py-1.5 text-sm font-medium">
          Update
        </button>
        <button type="button" onClick={onDismiss} aria-label="Later" className="text-white/70 px-1 text-lg leading-none">
          ×
        </button>
      </div>
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [session, setSession] = useState(() => loadSession());
  const [manifest, setManifest] = useState(null);
  const [activeLoad, setActiveLoad] = useState(null);
  /** Loads the dispatcher handed to this person for the current shift. */
  const [assigned, setAssigned] = useState([]);
  /** A newer build is deployed and waiting to be taken. */
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => watchForUpdate(() => setUpdateReady(true)), []);

  useEffect(() => {
    // Runs in the ROOT, where there is no session until someone signs in.
    if (!session?.token) {
      setAssigned([]);
      return undefined;
    }
    let alive = true;
    api
      .fetchAssignments(session.token, shiftDayString())
      .then((r) => alive && setAssigned(r?.mine ?? []))
      // No assignments, or the endpoint is not deployed yet: the board still
      // works exactly as it did. This must never block getting to a truck.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session?.token]);

  /**
   * Start the clock on a truck.
   *
   * Deliberately NOT awaited by the caller and deliberately silent on failure.
   * The worklog is a record OF the work, never a gate ON it — a loader at 3am
   * must not be held at the door because a timing write timed out. A start that
   * never lands degrades the report to a scan-derived duration, which is exactly
   * what the 'derived' timing source exists to admit to.
   */
  const clockIn = useCallback(
    (loadNbr) => {
      // The root renders before anyone has signed in, so the session is legitimately
      // null here and the dependency array below must not dereference it either.
      if (!loadNbr || !session?.token) return;
      api
        .postWorkEvents(session.token, [
          { kind: 'start', loadNbr, at: new Date().toISOString(), workerName: session.displayName },
        ])
        .catch(() => {});
    },
    [session?.token, session?.displayName],
  );
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
      <>
      {updateReady ? <UpdateBanner onApply={applyUpdate} onDismiss={() => setUpdateReady(false)} /> : null}
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
      </>
    );
  }

  return (
    <div className="min-h-full">
      {/* Between trucks is the SAFEST moment to take an update — nothing is
          half-counted — so the banner belongs here as much as on the scan screen. */}
      {updateReady ? <UpdateBanner onApply={applyUpdate} onDismiss={() => setUpdateReady(false)} /> : null}
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
            assigned={assigned}
            // A summary row has no stops: fetch the chosen load before opening
            // it. Same ?loadNbr path the manual entry already used.
            onPick={async (loadNbr) => {
              if (manifest.summariesOnly) await getManifest({ loadNbr });
              setActiveLoad(loadNbr);
              clockIn(loadNbr);
            }}
            onManual={async (loadNbr) => {
              await getManifest({ loadNbr });
              setActiveLoad(loadNbr);
              clockIn(loadNbr);
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
