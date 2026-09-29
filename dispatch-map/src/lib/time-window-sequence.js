// src/lib/time-window-sequence.js
//
// ── RE-SEQUENCE A COMPARE CARD AROUND RECEIVING HOURS (v1.89.0) ──────────────
//
// Chad, 2026-09-28, with the Re-sequence menu open on TRAILER 1: "i need an optimization that
// uses the time restrictions and trys to make the best route considering those so this type of
// optimization may need a quick claude sonnett 5.5 call".
//
// NO MODEL CALL, AND WHY. The question is arithmetic — which order gets the truck to each dock
// before it closes — and the card already holds the exact arithmetic: routePreflight, the check
// behind every "late" and "can't make" badge on the card (the same engine the board's flags run).
// So every candidate order here is scored by THAT and by nothing else. The order it picks is
// judged on the very clock the badges read, it costs nothing, it answers in well under a second
// (0.12 ms a scoring on an 18-stop route, measured), and it gives the same answer twice. A model
// would need the same drive times handed to it, can get the sums wrong, and would still have to be
// checked by this code before anything reached the card.
//
// WHAT COUNTS AS A TIME RESTRICTION. Not receiving hours alone. Each stop's clock is the same merged
// rule the route builder reads (routing-time-windows.mts stopTimeRestriction): the order's OWN booked
// window or appointment, the customer's receiving hours for the board day, and a closed day — the
// tightest combination wins, and a booked appointment stands over a dock whose hours disagree. The
// card's own late verdicts (routePreflight) are counted as well, so nothing its badges show is ever
// ignored. Free-text restrictions ("CLOSES AT 3 30 PM", a lunch closure, "APPT REQD") are read by the
// tested parsers behind that rule, not guessed at here.
//
// WHAT "BEST" MEANS, in the order a dispatcher weighs it:
//   1. fewest stops reached after they close — a receiving-hours close, or the end of a booked window;
//   2. fewest stops reached before an opening that is a real commitment: a booked window or
//      appointment, or a DISPATCHER-TYPED opening. Auto hours can invent one ("DELIVER BY 2PM" parses
//      as 6:00a–2:00p, see board-flags), and chasing an invented opening would push a real stop late.
//      The card's clock does not wait at a closed dock, so arriving early is avoided here rather than
//      modelled as a wait;
//   3. fewest minutes late in all — a stop that cannot make it arrives as early as the rest allow,
//      which is the shorter phone call to the customer;
//   4. the earliest finish — the time the last stop is reached, which is the shorter day.
// A stop whose customer is shut that weekday cannot be served by ANY order, so it adds the same to
// every candidate and is left out of the ranking (the route builder excludes it from trucks).
//
// HOW IT SEARCHES. Three starting orders — the card as it stands, the shortest-distance order the
// menu already offers, and closes-first — each improved by moving one stop at a time and by
// reversing a stretch of the route, keeping any change that scores better, until nothing does or
// the scoring budget is spent. Deterministic: the same card gives the same order every time.
// NEVER WORSE: when nothing beats the card as it stands, the card's own order comes back
// unchanged and the result says so.
//
// A stop the check cannot judge (no map location, or not resolvable) is never dropped and never
// guessed at: it rides at the END in the order it already had, exactly as the other strategies
// treat an unplaceable stop.
import { routePreflight } from './route-preflight.js';
import { dayReceivingWindow, fmtMin } from './board-flags.js';
import { resequence } from './routing-select.js';
import { orderWindow } from './time-restrictions.js';
import { stopTimeRestriction } from '../../netlify/functions/lib/routing-time-windows.mts';

/** Scorings one press may spend. ~0.7 s at 18 stops in Node; a cut is reported, never silent. */
export const TIME_WINDOW_MAX_EVALS = 6000;

const hasCoords = (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng);

/** PURE: a <b is better. Lexicographic over late, early, lateMin, finish. */
export function compareWindowScores(a, b) {
  for (const k of ['late', 'early', 'lateMin', 'finish']) {
    const x = Number(a?.[k]) || 0;
    const y = Number(b?.[k]) || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * PURE. Order a card's stops so the fewest miss their receiving hours.
 *
 * Takes exactly what the card's preflight takes (routePreflight), plus a scoring budget.
 * @returns {{ order: string[], before: object, after: object, changed: boolean, evals: number,
 *             capped: boolean, judged: number, unjudged: number }}
 *   order    — every id the card had, judged ones in the chosen order, unjudged ones after them
 *   before   — the card's own order, scored { late, early, lateMin, finish }
 *   after    — the returned order, scored the same way
 */
export function timeWindowSequence({
  order = [],
  stopById = new Map(),
  notes = new Map(),
  routeKey = 'DRAFT',
  servedDate = null,
  dayKey = null,
  depot = null,
  travel = null,
  departMin,
  departureSource,
  rosterRows = null,
  defaultSlots = null,   // detectDefaultSlots(board) — keeps the vendor's creation stamp from posing as an appointment
  maxEvals = TIME_WINDOW_MAX_EVALS,
} = {}) {
  const ids = (Array.isArray(order) ? order : []).map((v) => String(v)).filter(Boolean);
  const lookup = stopById instanceof Map ? stopById : new Map();
  const judged = ids.filter((id) => hasCoords(lookup.get(id)));
  const judgedSet = new Set(judged);
  const tail = ids.filter((id) => !judgedSet.has(id));

  // Each stop's clock, read once: the merged window's close, whether the customer is shut today, and
  // the opening that is a real commitment (a booked window, or a typed opening) — see the header.
  const clocks = new Map();
  for (const id of judged) {
    const s = lookup.get(id);
    const note = notes?.get?.(s?.matchKey) || null;
    const w = stopTimeRestriction({ stop: s, note, date: servedDate || undefined, defaultSlots });
    const ord = orderWindow(s, defaultSlots);
    const dw = dayReceivingWindow(note, dayKey);
    const typedOpen = dw && dw.tier === 'typed' && Number.isFinite(dw.openMin) ? dw.openMin : null;
    const hard = [ord?.openMin, typedOpen].filter((v) => Number.isFinite(v));
    clocks.set(id, {
      closeMin: Number.isFinite(w?.closeMin) ? w.closeMin : null,
      closedToday: !!w?.closedToday,
      hardOpen: hard.length ? Math.max(...hard) : null,
    });
  }

  const pfArgs = {
    stopById: lookup, notes, routeKey, servedDate, dayKey, depot, travel, rosterRows,
    ...(departMin != null ? { departMin } : {}),
    ...(departureSource ? { departureSource } : {}),
  };
  const memo = new Map();
  let evals = 0;
  const budget = Math.max(1, Number(maxEvals) || TIME_WINDOW_MAX_EVALS);
  let capped = false;
  const score = (seq) => {
    const key = seq.join('\u001f');
    const hit = memo.get(key);
    if (hit) return hit;
    evals += 1;
    const pf = routePreflight({ ...pfArgs, order: seq });
    let late = 0; let lateMin = 0; let early = 0; let finish = 0;
    for (const st of pf.stops || []) {
      const c = clocks.get(String(st.stopNbr));
      if (c?.closedToday) continue;   // no order can serve it — the same for every candidate
      const eta = Number(st.etaMin);
      const haveEta = Number.isFinite(eta);
      // Late by the card's own verdict, or past the merged window's close — whichever says more.
      const byWindow = haveEta && c?.closeMin != null && eta > c.closeMin ? eta - c.closeMin : 0;
      const byCard = st.late ? Math.max(0, Number(st.lateBy) || 0) : 0;
      if (st.late || byWindow > 0) { late += 1; lateMin += Math.max(byCard, byWindow); }
      if (haveEta) {
        if (eta > finish) finish = eta;
        if (c?.hardOpen != null && eta < c.hardOpen) early += 1;
      }
    }
    const out = { late, early, lateMin: Math.round(lateMin), finish: Math.round(finish) };
    memo.set(key, out);
    return out;
  };

  const before = score(judged);
  if (judged.length < 2) {
    return { order: [...judged, ...tail], before, after: before, changed: false, evals, capped, judged: judged.length, unjudged: tail.length };
  }

  // THE THREE STARTS.
  const pts = judged.map((id) => ({ id, lat: lookup.get(id).lat, lng: lookup.get(id).lng }));
  const distanceOrder = hasCoords(depot) ? resequence(pts, depot, 'min').map((p) => p.id) : [...judged];
  const closeOf = (id) => {
    const w = dayReceivingWindow(notes?.get?.(lookup.get(id)?.matchKey) || null, dayKey);
    return w && Number.isFinite(w.closeMin) ? w.closeMin : Infinity;
  };
  const rankInDistance = new Map(distanceOrder.map((id, i) => [id, i]));
  const closesFirst = [...judged].sort((a, b) => (closeOf(a) - closeOf(b)) || (rankInDistance.get(a) - rankInDistance.get(b)));

  const better = (a, b) => compareWindowScores(a, b) < 0;
  const improve = (start) => {
    let cur = [...start];
    let curScore = score(cur);
    const n = cur.length;
    let improved = true;
    while (improved) {
      improved = false;
      // Move one stop to another place in the route.
      for (let i = 0; i < n && !improved; i++) {
        for (let j = 0; j < n && !improved; j++) {
          if (j === i) continue;
          if (evals >= budget) { capped = true; return { seq: cur, s: curScore }; }
          const cand = [...cur];
          const [x] = cand.splice(i, 1);
          cand.splice(j, 0, x);
          const s = score(cand);
          if (better(s, curScore)) { cur = cand; curScore = s; improved = true; }
        }
      }
      // Reverse a stretch of the route (untangles a crossing the single moves cannot).
      for (let i = 0; i < n - 1 && !improved; i++) {
        for (let k = i + 1; k < n && !improved; k++) {
          if (evals >= budget) { capped = true; return { seq: cur, s: curScore }; }
          const cand = [...cur.slice(0, i), ...cur.slice(i, k + 1).reverse(), ...cur.slice(k + 1)];
          const s = score(cand);
          if (better(s, curScore)) { cur = cand; curScore = s; improved = true; }
        }
      }
    }
    return { seq: cur, s: curScore };
  };

  let best = { seq: judged, s: before };
  for (const start of [judged, distanceOrder, closesFirst]) {
    const r = improve(start);
    if (better(r.s, best.s)) best = r;
    if (capped) break;
  }
  const changed = better(best.s, before);
  const chosen = changed ? best.seq : judged;
  return {
    order: [...chosen, ...tail],
    before,
    after: changed ? best.s : before,
    changed,
    evals,
    capped,
    judged: judged.length,
    unjudged: tail.length,
  };
}

const dur = (m) => {
  const v = Math.max(0, Math.round(Number(m) || 0));
  return v >= 60 ? `${Math.floor(v / 60)}h ${v % 60}m` : `${v}m`;
};

/** PURE: the one line the card says after a Time windows re-sequence — before and after, never an
 *  intent. `name` is the card's display name. */
export function timeWindowSummary(res, name = 'load') {
  if (!res) return `Time windows: nothing to re-sequence on ${name}.`;
  const b = res.before || {}; const a = res.after || {};
  const lateWords = (s) => `${s.late || 0} late${s.late ? ` (${dur(s.lateMin)} in all)` : ''}`;
  const cut = res.capped ? ' — search cut short, the best order found so far' : '';
  const skipped = res.unjudged ? ` · ${res.unjudged} stop(s) without a map location left at the end` : '';
  if (!res.changed) {
    return `Time windows: kept ${name}'s order — no order found with fewer late stops (${lateWords(b)}${b.early ? `, ${b.early} before an opening` : ''})${cut}${skipped}.`;
  }
  const lateChange = (b.late === a.late && !b.late) ? 'none late' : `${lateWords(b)} → ${lateWords(a)}`;
  const earlyPart = (b.early || a.early) ? ` · before an opening ${b.early || 0} → ${a.early || 0}` : '';
  // THE COST, SAID: the order that makes the windows can end the day later than the shortest one.
  const moved = Number(a.finish) - Number(b.finish);
  const finishPart = Number.isFinite(moved) && Math.abs(moved) >= 5 && a.finish > 0 && b.finish > 0
    ? ` · last stop ${fmtMin(b.finish)} → ${fmtMin(a.finish)}` : '';
  return `Re-sequenced ${name} · Time windows — ${lateChange}${earlyPart}${finishPart}${cut}${skipped}`;
}

/** VITE_COMPARE_TIME_WINDOWS — house shape: default on, an off-word (off/0/false/no) turns it off,
 *  anything malformed leaves it on. Off takes "Time windows" out of the Re-sequence menu; every
 *  other strategy is untouched either way. Build-time, so flipping it is a redeploy. */
export function compareTimeWindowsEnabled(env) {
  const v = String(env?.VITE_COMPARE_TIME_WINDOWS ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}
