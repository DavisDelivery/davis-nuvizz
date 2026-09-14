// src/lib/order-arrivals.js
//
// ── WHEN THE FREIGHT ACTUALLY LANDED IN OUR SYSTEM, AND WHETHER TONIGHT IS HEAVY ──────────
//
// Chad, Sep 2026: "I want a durable way of knowing what time the orders hit our system and
// tracking that information in the manifest to try to see if we can predict days when the
// volume is heavier than normal, sooner than at the end of the day."
//
// THE QUESTION THIS ANSWERS, AND WHY THE OLD ANSWER WAS USELESS. Uline's forecast says what
// is coming; the nightly manifest says what came. Both are end-of-night. At 6pm, building
// tomorrow's loads, the dispatcher has neither — and "how does tonight compare so far" was
// unanswerable because nothing recorded WHEN an order arrived, only that it had.
//
// It turns out something does. The scan pulls /stop/info exactly once per order, the first
// time it ever sees that stop number, and stamps `enriched_at` in a registry keyed by the
// number — "Record the newly-enriched PROs so they're never auto-enriched again (any day)"
// (refresh-stops-core.mts). Every later scan carries the record forward instead of re-reading,
// and `enriched_at` is not a LIVE list field, so it never drifts. It is a FIRST-SIGHT stamp,
// already sitting on every stop we have ever indexed. This module is what reads it.
//
// FIRST SIGHT IS NOT ORDER CREATION, and the screen must never imply it is. The stamp is when
// OUR scan first saw the order, which trails NuVizz's own creation time by up to one scan tick
// plus any enrichment backlog (ENRICH_MAX defaults to 250 PROs per run, "rest next tick"). On
// a heavy drop that backlog is longest, so a heavy night reads slightly LATER than it was —
// the bias runs toward under-calling a heavy night, which is the expensive direction. That is
// the argument for the asymmetric thresholds below, not a reason to distrust the number.
//
// THE AXIS IS LEAD HOURS, NOT CLOCK TIME, and that is a correctness decision rather than a
// convenience. "6pm the night before" is not a fixed calendar offset: Monday's board is
// Friday's freight, so clock-time-on-D−1 for a Monday delivery is a Sunday that holds almost
// nothing. Lead hours are measured back from the delivery day's 5am ET roll — the same
// rollover the manifest archive and the forecast scorer already use — so every day is on one
// axis and a Tuesday is still only ever compared against other Tuesdays.
//
// EVERYTHING HERE IS PURE. Stops in, a clock in, plain data out. No Firestore, no NuVizz, no
// Date.now(): the caller passes `nowMs`, so a test can stand anywhere on the calendar and the
// verdict for a given night never changes after the fact.

import { isoWeekday, shiftIso } from './manifest-window.js';
import { etParts } from './uline-forecast-score.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The operating-day roll this repo already runs on: before 5am ET the night belongs to
 *  yesterday (manifest-archive NIGHT_ROLLOVER_HOUR, uline-forecast operatingDayET). Lead
 *  hours are measured back from this instant on the delivery day, so the tail of a night
 *  that lands at 12:40am counts toward the day it is for. */
export const ROLL_HOUR_ET = 5;

/** Buckets reach four days back. Uline freight for a Tuesday is Monday's ship with a Sunday
 *  tail; four days covers the Friday→Monday weekend case with room, and everything older is
 *  one `early` bucket rather than a hundred empty ones. */
export const LEAD_MAX_HOURS = 96;

/** Below this share of a day's orders carrying a stamp we report the raw count and REFUSE to
 *  project. A curve built on two thirds of the freight is not a curve, and a projection that
 *  quietly divides by a partial count is the "plausible story that fits the symptom" this
 *  repo has a rule about. Coverage is always reported, projection or not. */
export const MIN_COVERAGE = 0.8;

/** Fewer sealed same-weekday nights than this and the screen says "not enough Tuesdays yet"
 *  rather than a normal it would not act on. Three is the smallest number whose median is not
 *  just the middle of two guesses. */
export const MIN_BASELINE_DAYS = 3;

/** Under this share of the night in hand, no projection is offered at any coverage. Dividing
 *  60 orders by a 0.05 fraction produces 1,200 and a phone call nobody needed; early in the
 *  evening the honest answer is the count and the normal beside it. */
export const MIN_PROJECT_FRACTION = 0.15;

/** THE THRESHOLDS ARE DELIBERATELY NOT SYMMETRIC, and the asymmetry is the whole point.
 *  Calling a normal night HEAVY costs one short route. Calling a heavy night NORMAL costs
 *  late deliveries into closed receiving windows, refusals, redeliveries and carryover — the
 *  same argument the forecast scorer's plan-only-moves-up rule is built on. So HEAVY fires at
 *  +8% and LIGHT waits for −15%: we warn early and we only stand down when it is obvious. */
export const HEAVY_RATIO = 1.08;
export const LIGHT_RATIO = 0.85;

const median = (xs) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const pct = (n) => (Number.isFinite(n) ? Math.round(n * 100) : null);

/** Epoch ms for the delivery day's 5am ET roll — the zero of the lead-hour axis.
 *  Built from the ET parts of a probe instant so it is correct on both sides of a DST flip
 *  rather than assuming a fixed UTC offset. */
export function rollInstant(deliveryDate) {
  if (!ISO_RE.test(String(deliveryDate || ''))) return null;
  // Noon UTC on the delivery day is the same ET calendar day in either season; walk from
  // there to the 5am ET instant by measuring the offset the zone actually reports.
  const probe = Date.parse(`${deliveryDate}T12:00:00Z`);
  if (!Number.isFinite(probe)) return null;
  const p = etParts(probe);
  if (!p) return null;
  // offsetMs = how far ET noon-of-record sits from the UTC instant we probed.
  const offsetMs = Date.parse(`${p.date}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:00Z`) - probe;
  return Date.parse(`${deliveryDate}T${String(ROLL_HOUR_ET).padStart(2, '0')}:00:00Z`) - offsetMs;
}

/** Hours before the delivery day's roll. Larger = earlier. Negative means it landed after the
 *  day had already begun — a same-day add, counted and reported rather than hidden. */
export function leadHoursFor(atMs, deliveryDate) {
  const roll = rollInstant(deliveryDate);
  const at = typeof atMs === 'string' ? Date.parse(atMs) : Number(atMs);
  if (roll == null || !Number.isFinite(at)) return null;
  return (roll - at) / 3_600_000;
}

/** The ET clock label for a lead hour on a given delivery day — "Mon 6pm" — so the screen can
 *  speak in the dispatcher's terms while the arithmetic stays on the lead axis. */
export function clockLabelFor(lead, deliveryDate) {
  const roll = rollInstant(deliveryDate);
  if (roll == null || !Number.isFinite(Number(lead))) return null;
  const p = etParts(roll - Number(lead) * 3_600_000);
  if (!p) return null;
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${DOW[isoWeekday(p.date)]} ${h}${p.hour < 12 ? 'am' : 'pm'}`;
}

/**
 * One night's arrival curve, from the stops themselves.
 *
 * `buckets[i]` is how many orders were first seen in the hour whose lead is i; anything older
 * than LEAD_MAX_HOURS lands in the last bucket, anything after the roll in bucket 0. A stop
 * with no `enriched_at` is NOT dropped silently — it is counted in `unstamped`, because a
 * curve that quietly ignores a third of the freight looks exactly like a light night.
 */
export function buildCurve({ stops = [], deliveryDate, stampField = 'enriched_at' } = {}) {
  const buckets = new Array(LEAD_MAX_HOURS + 1).fill(0);
  let stamped = 0; let unstamped = 0; let afterRoll = 0;
  let firstMs = null; let lastMs = null;
  for (const s of Array.isArray(stops) ? stops : []) {
    const raw = s?.[stampField];
    const lead = raw == null || raw === '' ? null : leadHoursFor(raw, deliveryDate);
    if (lead == null || !Number.isFinite(lead)) { unstamped += 1; continue; }
    stamped += 1;
    const ms = typeof raw === 'string' ? Date.parse(raw) : Number(raw);
    if (firstMs == null || ms < firstMs) firstMs = ms;
    if (lastMs == null || ms > lastMs) lastMs = ms;
    if (lead < 0) afterRoll += 1;
    const idx = Math.min(LEAD_MAX_HOURS, Math.max(0, Math.floor(lead)));
    buckets[idx] += 1;
  }
  const total = stamped + unstamped;
  return {
    date: deliveryDate ?? null,
    dow: ISO_RE.test(String(deliveryDate || '')) ? DOW[isoWeekday(deliveryDate)] : null,
    total, stamped, unstamped, afterRoll,
    coverage: total ? stamped / total : null,
    firstAt: firstMs ? new Date(firstMs).toISOString() : null,
    lastAt: lastMs ? new Date(lastMs).toISOString() : null,
    buckets,
  };
}

/** How many orders were in hand at lead L — every bucket at or earlier than L. */
export function inHandAt(curve, lead) {
  const b = curve?.buckets;
  if (!Array.isArray(b)) return null;
  const from = Math.min(LEAD_MAX_HOURS, Math.max(0, Math.ceil(Number(lead))));
  let n = 0;
  for (let i = from; i <= LEAD_MAX_HOURS; i++) n += Number(b[i]) || 0;
  return n;
}

/**
 * The same-weekday normal, from sealed nights.
 *
 * Two medians, and they answer different questions: `fraction[L]` is what share of a night is
 * usually in hand by lead L (the pacing model the projection divides by), and `typicalFinal`
 * is what that weekday usually finishes at (what "heavier than normal" is measured against).
 * A night with no stamped orders contributes to neither — it would drag every fraction toward
 * zero and make a quiet night look like a flood.
 */
export function buildBaseline(curves = [], { minDays = MIN_BASELINE_DAYS } = {}) {
  const usable = (Array.isArray(curves) ? curves : []).filter((c) => c && Number(c.stamped) > 0 && Number(c.total) > 0);
  const finals = usable.map((c) => Number(c.total));
  const fraction = new Array(LEAD_MAX_HOURS + 1).fill(null);
  for (let L = 0; L <= LEAD_MAX_HOURS; L++) {
    const fs = usable.map((c) => {
      const stampedTotal = Number(c.stamped);
      return stampedTotal > 0 ? inHandAt(c, L) / stampedTotal : null;
    });
    fraction[L] = median(fs);
  }
  return {
    n: usable.length,
    ready: usable.length >= minDays,
    dates: usable.map((c) => c.date).filter(Boolean),
    typicalFinal: finals.length ? Math.round(median(finals)) : null,
    fraction,
  };
}

/**
 * The sentence the dispatcher reads at 6pm.
 *
 * Every refusal is NAMED. "I cannot tell yet, and here is which of the four reasons" is a
 * complete answer; a projection computed anyway is the one output that cannot be told from a
 * good one. The four: no baseline yet, coverage too thin, too early in the night, no orders.
 */
export function assess({ curve, nowMs, baseline, deliveryDate = null } = {}) {
  const date = deliveryDate ?? curve?.date ?? null;
  const lead = leadHoursFor(nowMs, date);
  const out = {
    date,
    dow: curve?.dow ?? (ISO_RE.test(String(date || '')) ? DOW[isoWeekday(date)] : null),
    lead: round1(lead),
    clock: lead == null ? null : clockLabelFor(lead, date),
    soFar: null, coverage: curve?.coverage ?? null, unstamped: curve?.unstamped ?? 0,
    typicalSoFar: null, typicalFinal: baseline?.typicalFinal ?? null, baselineN: baseline?.n ?? 0,
    fraction: null, projected: null, ratio: null,
    verdict: 'unknown', text: '', why: null,
  };
  if (lead == null) { out.why = 'no clock'; out.text = 'no reading — the date or the clock is unreadable'; return out; }

  out.soFar = inHandAt(curve, lead);
  if (out.soFar == null) { out.why = 'no curve'; out.text = 'no orders indexed for this day yet'; return out; }

  // The raw comparison is worth saying even when the projection is refused: "we have 431 and
  // a Tuesday usually has 388 by now" is actionable on its own.
  const f = baseline?.ready ? baseline.fraction?.[Math.min(LEAD_MAX_HOURS, Math.max(0, Math.ceil(lead)))] : null;
  if (baseline?.ready && Number.isFinite(f) && Number.isFinite(baseline.typicalFinal)) {
    out.fraction = round1(f * 100) == null ? null : f;
    out.typicalSoFar = Math.round(f * baseline.typicalFinal);
  }

  if (!baseline?.ready) {
    out.why = 'no baseline';
    out.text = `${out.soFar} in hand · not enough sealed ${out.dow || 'same-weekday'} nights yet (${baseline?.n ?? 0} of ${MIN_BASELINE_DAYS})`;
    return out;
  }
  if (out.coverage != null && out.coverage < MIN_COVERAGE) {
    out.why = 'coverage';
    out.text = `${out.soFar} in hand · ${pct(out.coverage)}% of today's orders carry an arrival stamp — too thin to project`;
    return out;
  }
  if (!Number.isFinite(f) || f < MIN_PROJECT_FRACTION) {
    out.why = 'too early';
    out.text = `${out.soFar} in hand · a ${out.dow} usually has ${out.typicalSoFar ?? '?'} by ${out.clock} — too early in the night to project`;
    return out;
  }

  out.projected = Math.round(out.soFar / f);
  out.ratio = baseline.typicalFinal ? round1(out.projected / baseline.typicalFinal) : null;
  const r = out.projected / baseline.typicalFinal;
  out.verdict = r >= HEAVY_RATIO ? 'heavy' : r <= LIGHT_RATIO ? 'light' : 'normal';
  const delta = out.projected - baseline.typicalFinal;
  const sign = delta >= 0 ? '+' : '−';
  out.text = `${out.soFar} in hand at ${out.clock} · a ${out.dow} usually has ${out.typicalSoFar} by now`
    + ` · tracking to ~${out.projected} (${sign}${Math.abs(delta)} vs a typical ${baseline.typicalFinal})`;
  return out;
}

/** THE EVENING AT A GLANCE, in the hours a dispatcher actually thinks in. Leads chosen so the
 *  labels land on the clock: for a Tuesday board these read Mon 6am / noon / 6pm / 9pm, then
 *  Tue midnight and 3am — the whole arc from the morning drip to the overnight flood. */
export const CHECKPOINT_LEADS = [23, 17, 11, 8, 5, 2];

/**
 * One row per checkpoint: what we had, and what a normal same-weekday night had by then.
 *
 * An hour that HAS NOT HAPPENED YET is null, never zero. Those are different facts and a
 * column of zeros stretching into tomorrow morning reads as a collapse in volume — the same
 * "absent is not zero" trap this repo has hit before.
 */
export function checkpoints({ curve, baseline, nowMs, deliveryDate, leads = CHECKPOINT_LEADS } = {}) {
  const date = deliveryDate ?? curve?.date ?? null;
  const nowLead = leadHoursFor(nowMs, date);
  return (Array.isArray(leads) ? leads : []).map((L) => {
    const reached = nowLead == null ? false : nowLead <= L;
    const typicalFraction = baseline?.ready ? baseline.fraction?.[L] : null;
    return {
      lead: L,
      clock: clockLabelFor(L, date),
      soFar: reached ? inHandAt(curve, L) : null,
      typical: Number.isFinite(typicalFraction) && Number.isFinite(baseline?.typicalFinal)
        ? Math.round(typicalFraction * baseline.typicalFinal) : null,
      reached,
    };
  });
}

/** The compact document a sealed night is stored as. Buckets plus the counts that say how much
 *  of the night the buckets actually describe — never the stops themselves. */
export function sealedDoc(curve, { sealedAt } = {}) {
  if (!curve) return null;
  return {
    date: curve.date, dow: curve.dow,
    total: curve.total, stamped: curve.stamped, unstamped: curve.unstamped, afterRoll: curve.afterRoll,
    coverage: curve.coverage == null ? null : round1(curve.coverage * 100) / 100,
    firstAt: curve.firstAt, lastAt: curve.lastAt,
    buckets: curve.buckets,
    sealedAt: sealedAt ?? null,
  };
}

/** Same-weekday sealed nights, newest first, excluding the day being judged. `weeks` back is
 *  a count of NIGHTS not calendar weeks — a holiday-shortened run must not silently widen the
 *  window into a different season. */
export function sameWeekdayDates(date, weeks = 6) {
  if (!ISO_RE.test(String(date || ''))) return [];
  const out = [];
  for (let i = 1; i <= Math.max(0, weeks); i++) out.push(shiftIso(date, -7 * i));
  return out;
}
