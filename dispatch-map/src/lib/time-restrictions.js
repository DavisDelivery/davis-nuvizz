// Time restrictions — "which PROs on this board are constrained by the CLOCK?"
//
// WHAT THIS IS FOR. A dispatcher building a board needs to know which stops cannot
// simply be dropped anywhere in a route: the dock that shuts at 2pm, the consignee who
// will not take freight without an appointment, the PM-only window. Everything else can
// be sequenced for distance. This module answers that question for one stop, and the
// report/endpoint above it just formats the answer.
//
// THE TRAP THIS MODULE EXISTS TO AVOID. The obvious signals are worthless:
//
//   • `timeConstraint: 'STRICT'` is stamped on 800 of 862 stops on a normal board.
//     NuVizz sets it by default. Filtering on it returns the whole board and tells a
//     dispatcher nothing. It is deliberately NOT a restriction here, on its own.
//   • `scheduledFrom/To` of 08:00–20:00 rides on ~88% of stops. That is the vendor's
//     all-day placeholder, not a delivery window.
//   • A zero-length schedule (05:00–05:00) is a placeholder too — routing-pipeline.mts
//     already refuses to treat those as real windows, and so do we.
//   • 'DO NOT BREAKDOWN SKID' is on 745 of 862 stops. Boilerplate, not an instruction.
//
// So a window counts only when it is genuinely NARROWER than a working day, and the
// free-text signals are read through the repo's existing tested scanner rather than a
// second, competing set of regexes.
//
// SEVERITY IS ORDERED BY WHAT IT COSTS TO GET WRONG, because a dispatcher acts
// differently on each:
//
//   hard_window  the dock shuts. Arrive late and the freight comes back and goes out
//                again tomorrow — the most expensive failure on the board. Route first.
//   appointment  somebody must call or book BEFORE the truck rolls. The cost lands in
//                the office, in the morning, not on the road.
//   closed_day   the customer is shut on this weekday entirely. Do not send it today.
//   half_day     AM/PM preference. Sequencing, not refusal — the cheapest to miss.
//
// Everything here is pure: same inputs, same answer, no clock and no network. The
// caller supplies the served date so a report for last Friday reads Friday's hours.

import { parseClockMin, fmtMin, dayReceivingWindow, closedDayTier } from './board-flags.js';
import { scanStopFull } from './signal-scanner.ts';

// A schedule spanning this long or longer is a working day, not a delivery window.
// 08:00–20:00 (720) and a normal 08:00–17:00 (540) both fall through; 12:00–17:00 (300,
// the PM window this app itself writes) and a 30-minute appointment do not. Set at 8h so
// an early close — 08:00–15:00 — still reads as the constraint it is.
export const ALL_DAY_MIN = 480;

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABEL = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

// Most severe first — the order the report ranks by.
export const TIER_ORDER = ['hard_window', 'appointment', 'closed_day', 'half_day'];
export const TIER_LABEL = {
  hard_window: 'Hard window',
  appointment: 'Appointment / call ahead',
  closed_day: 'Closed today',
  half_day: 'Half-day window',
};

// 'YYYY-MM-DD' → 'mon'..'sun'. Parsed at local noon so a DST boundary can never shift the
// weekday — the same guard weekdayKeyFromDate uses in App.jsx.
export function weekdayKey(dateString) {
  const [y, m, d] = String(dateString ?? '').split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 12, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : DAY_KEYS[dt.getDay()];
}

// Minutes-since-midnight from a naive stamp like '2026-08-19T14:31:00'. Returns null for
// anything that is not one — NEVER 0, because Number(null) is 0 and 0 is a finite midnight
// that reads as a real deadline. That exact coercion once mailed a customer a midnight
// deadline for a stop that had no deadline at all.
export function clockMinFromStamp(v) {
  const m = String(v ?? '').match(/T(\d{2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// A window this short is a booked slot rather than a part-day preference.
export const SLOT_MIN = 90;

// The order's own schedule, but only when it says something. Returns
// { openMin, closeMin, spanMin, kind } | null.
//   kind: 'appointment' (≤90 min — a booked slot) | 'window' (a narrowed part-day)
// null for a missing, unparseable, zero/negative-length, or all-day schedule.
//
// `defaultSlots` (see detectDefaultSlots) suppresses the slot-shaped windows that are
// really a system stamp — pass the board's set so a creation default cannot masquerade
// as 21 separate appointments.
export function orderWindow(stop, defaultSlots = null) {
  const openMin = clockMinFromStamp(stop?.scheduledFrom);
  const closeMin = clockMinFromStamp(stop?.scheduledTo);
  if (openMin == null || closeMin == null) return null;
  const spanMin = closeMin - openMin;
  if (spanMin <= 0) return null;          // placeholder (05:00–05:00) or inverted
  if (spanMin >= ALL_DAY_MIN) return null; // a working day, not a window
  const kind = spanMin <= SLOT_MIN ? 'appointment' : 'window';
  if (kind === 'appointment' && defaultSlots?.has?.(slotKey(openMin, closeMin))) return null;
  return { openMin, closeMin, spanMin, kind };
}

const slotKey = (openMin, closeMin) => `${openMin}-${closeMin}`;

// WHICH 30-MINUTE "APPOINTMENTS" ARE REALLY A SYSTEM STAMP.
//
// On the 2026-08-19 board, 09:00–09:30 sits on 21 stops belonging to 21 unrelated
// customers, on nine different routes, half of them not even planned. Twenty-one
// independent consignees do not book the same half hour: that is the default schedule
// an order gets when it is created without one — the same class of placeholder as the
// 08:00–20:00 all-day span, just narrower and therefore more convincing.
//
// Left in, it is worse than noise. The report sorts hard windows by earliest close, so
// a screenful of phantom 9:30 slots lands ABOVE the genuine 11am docks and pushes the
// stops that actually need routing first off the top of the page.
//
// Detected from the board rather than hardcoded, because it is the vendor's default and
// can change without telling us. Only SLOT-shaped windows are eligible: a 12:00–17:00
// PM window is on 61 stops too, but that one is a real half-day statement this app
// writes itself, and it must never be swept up here.
export const DEFAULT_SLOT_MIN_STOPS = 5;
export const DEFAULT_SLOT_MIN_CUSTOMERS = 3;

export function detectDefaultSlots(stops = []) {
  const seen = new Map(); // slotKey → Set(customer)
  for (const s of stops) {
    const openMin = clockMinFromStamp(s?.scheduledFrom);
    const closeMin = clockMinFromStamp(s?.scheduledTo);
    if (openMin == null || closeMin == null) continue;
    const span = closeMin - openMin;
    if (span <= 0 || span > SLOT_MIN) continue;
    const k = slotKey(openMin, closeMin);
    if (!seen.has(k)) seen.set(k, { stops: 0, customers: new Set() });
    const e = seen.get(k);
    e.stops += 1;
    if (s.businessName) e.customers.add(String(s.businessName).trim().toUpperCase());
  }
  const out = new Set();
  for (const [k, e] of seen) {
    if (e.stops >= DEFAULT_SLOT_MIN_STOPS && e.customers.size >= DEFAULT_SLOT_MIN_CUSTOMERS) out.add(k);
  }
  return out;
}

// Appointment / call-ahead obligations in the free text. These are what Uline actually
// sends, counted against a real board before being listed here: 'NTFY OF DELIVERY-APPT
// REQD' is on 27 of 862 stops, so it is a signal — unlike 'DO NOT BREAKDOWN SKID' (745),
// which is boilerplate and is matched by nothing below.
const APPOINTMENT_PATTERNS = [
  [/\bNTFY\s+OF\s+DELIVERY\s*-?\s*APPT\s+REQD\b/i, 'Notify of delivery — appointment required'],
  [/\bAPPOINTMENT\s+REQUIRED\b/i, 'Appointment required'],
  [/\bAPPT\s+(REQD|REQUIRED)\b/i, 'Appointment required'],
  [/\bEMAIL\s+FOR\s+APPOINTMENT\b/i, 'Email for appointment'],
  [/\bCALL\s+FOR\s+(AN\s+)?APPOINTMENT\b/i, 'Call for appointment'],
  [/\bMUST\s+CALL\b/i, 'Driver must call ahead'],
  [/\bCALL\s+(UPON|ON)\s+APPROACH\b/i, 'Call on approach'],
  [/\bPRIOR\s+TO\s+DELIVERY\b/i, 'Call ahead before delivery'],
  [/\bCALL\s+AHEAD\b/i, 'Call ahead'],
];

// Free-text closing time that the hours scanner does not model as a range — 'CLOSES AT
// 3 30 PM'. Space-for-colon is how these arrive ('3 30' is 3:30), the same quirk the
// hours scanner already handles.
const CLOSES_AT = /\bCLOSE[SD]?\s+(?:AT|BY)\s+(\d{1,2})(?:[:\s](\d{2}))?\s*([AP])\.?M\.?/i;

// A MIDDAY CLOSURE, not a deadline: 'PICK UP BEFORE 11AM OR AFTER 12:30PM'. The shared
// signal scanner matches only the first half of this and returns a flat 11:00 close, so
// a delivery at 4:29p — which the customer explicitly allowed — scores as 329 minutes
// late. That is the report crying wolf on a stop that was served correctly, and it is
// the one direction of error a dispatcher stops trusting a report over. We keep the
// stop (a lunch closure IS a real restriction) and read the escape hatch: the dock is
// shut BETWEEN the two times, and nothing outside that gap is a miss.
const SPLIT_WINDOW = /\bBEFORE\s+(\d{1,2})(?:[:\s](\d{2}))?\s*([AP])\.?M\.?[\s\S]{0,40}?\bOR\s+AFTER\s+(\d{1,2})(?:[:\s](\d{2}))?\s*([AP])\.?M\.?/i;

const to24 = (hh, mm, ap) => {
  const h = Number(hh); const m = mm ? Number(mm) : 0;
  if (h < 1 || h > 12 || m > 59) return null;
  return ((h % 12) + (ap.toLowerCase() === 'p' ? 12 : 0)) * 60 + m;
};

// { shutFromMin, shutUntilMin } | null — the hours the dock will NOT take freight.
export function splitWindow(text) {
  const m = String(text ?? '').match(SPLIT_WINDOW);
  if (!m) return null;
  const shutFromMin = to24(m[1], m[2], m[3]);
  const shutUntilMin = to24(m[4], m[5], m[6]);
  if (shutFromMin == null || shutUntilMin == null || shutUntilMin <= shutFromMin) return null;
  return { shutFromMin, shutUntilMin };
}

function stopText(stop) {
  const src = stop?.signalSources || {};
  return [src.orderInstructions, src.addressLine2, stop?.addr2]
    .filter(Boolean).join('\n');
}

function appointmentHits(text) {
  const seen = new Set();
  for (const [re, label] of APPOINTMENT_PATTERNS) {
    const m = text.match(re);
    if (m) seen.add(label);
  }
  return [...seen];
}

function closesAtMin(text) {
  const m = text.match(CLOSES_AT);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  if (hh > 12 || hh < 1 || mm > 59) return null;
  let h = hh % 12;
  if (m[3].toLowerCase() === 'p') h += 12;
  return h * 60 + mm;
}

/**
 * Classify ONE stop. Returns null when nothing constrains the clock — which is the common
 * case and must stay cheap to read.
 *
 * @param stop      a board stop (scheduledFrom/To, signalSources, deliveredDTTM…)
 * @param note      that customer's customer_notes doc, or null when we hold none
 * @param servedDate 'YYYY-MM-DD' — the board day; decides WHICH weekday's hours apply
 */
export function classifyStopTimeRestriction(stop, note, servedDate, defaultSlots = null) {
  if (!stop) return null;
  const dayKey = weekdayKey(servedDate);
  const text = stopText(stop);
  const kinds = [];
  const sources = new Set();

  // ── the dock's own hours ────────────────────────────────────────────────────
  // Typed hours (a dispatcher entered them) outrank the scanner's reading of Uline's
  // text; dayReceivingWindow already reports which it is, and a 'typed' tier is the one
  // we are willing to call authoritative in the report.
  let closeMin = null; let openMin = null; let hoursTier = null; let hoursLabel = '';
  // WHERE THE HOURS CAME FROM, kept separate from how much we trust them. These are two
  // different questions and collapsing them misattributes the data: dayReceivingWindow
  // reports tier 'auto' both for hours sitting in a customer's saved notes and — via the
  // branches below — for hours parsed out of THIS order's text, so a tier-derived label
  // told the reader 100 of 107 rows were read off the order in front of them when they
  // were really read off a record saved earlier. The column exists so a dispatcher can
  // judge how far to trust a row; an attribution the data does not support is worse than
  // no column at all.
  //   'dispatcher' — somebody typed these hours for this customer
  //   'saved'      — auto-detected previously and kept on the customer's record
  //   'order-text' — parsed from the instructions on this order
  let hoursProvenance = null;
  const split = splitWindow(text);
  const noteWindow = dayKey ? dayReceivingWindow(note, dayKey) : null;
  if (noteWindow?.closeMin != null) {
    openMin = noteWindow.openMin; closeMin = noteWindow.closeMin; hoursTier = noteWindow.tier;
    hoursProvenance = hoursTier === 'typed' ? 'dispatcher' : 'saved';
    sources.add(hoursTier === 'typed' ? 'Dispatcher-entered hours' : 'Saved hours (auto-detected)');
  } else if (split) {
    // Shut between the two times. Held separately from open/close because it is a hole
    // in the day, not a window around it.
    hoursTier = 'auto'; hoursProvenance = 'order-text';
    sources.add('Order instructions (midday closure)');
  } else {
    // Nothing on file: read the order text with the repo's own tested scanner. Its
    // byDay map is what makes 'MON-THU 8-2 / FRI 8-12' answer FRIDAY correctly — the
    // day that actually bites.
    const scanned = scanStopFull(stop)?.hours || null;
    const forDay = (dayKey && scanned?.byDay?.[dayKey]) || null;
    const open = forDay ? forDay.open : scanned?.open;
    const close = forDay ? forDay.close : scanned?.close;
    const cm = parseClockMin(close);
    const om = parseClockMin(open);
    if (scanned && cm != null) {
      openMin = om; closeMin = cm; hoursTier = 'auto'; hoursProvenance = 'order-text';
      sources.add('Order instructions (receiving hours)');
    } else if (scanned && om != null) {
      // OPEN-ONLY — 'RECEIVING AFTER 10AM'. A real constraint (this cannot be the 7am
      // first stop) with no close to miss, so it is carried as an open and can never
      // produce a past-close miss. Dropping these, as an earlier cut did, hid a
      // genuine routing constraint entirely.
      openMin = om; hoursTier = 'auto'; hoursProvenance = 'order-text';
      sources.add('Order instructions (opens at)');
    }
  }
  // A bare 'CLOSES AT 3 30 PM' with no range anywhere else is still a close time.
  if (closeMin == null) {
    const c = closesAtMin(text);
    if (c != null) {
      closeMin = c; hoursTier = 'auto'; hoursProvenance = 'order-text';
      sources.add('Order instructions (closing time)');
    }
  }
  if (split) {
    hoursLabel = `before ${fmtMin(split.shutFromMin)} or after ${fmtMin(split.shutUntilMin)}`;
    kinds.push('hard_window');
  } else if (closeMin != null) {
    hoursLabel = openMin != null ? `${fmtMin(openMin)}–${fmtMin(closeMin)}` : `closes ${fmtMin(closeMin)}`;
    kinds.push('hard_window');
  } else if (openMin != null) {
    hoursLabel = `opens ${fmtMin(openMin)}`;
    kinds.push('hard_window');
  }

  // ── the order's own schedule ────────────────────────────────────────────────
  const win = orderWindow(stop, defaultSlots);
  if (win) {
    sources.add('Order schedule');
    kinds.push(win.kind === 'appointment' ? 'hard_window' : 'half_day');
  }

  // ── an appointment you must book, or a call you must make ───────────────────
  const appts = appointmentHits(text);
  if (note?.appointment_required) {
    appts.unshift('Appointment required (on file)');
    sources.add('Customer notes');
  }
  if (appts.length) {
    kinds.push('appointment');
    if (!sources.has('Customer notes')) sources.add('Order instructions (appointment)');
  }

  // ── shut today ──────────────────────────────────────────────────────────────
  const closedToday = dayKey ? !!closedDayTier(note, dayKey) : false;
  if (closedToday) { kinds.push('closed_day'); sources.add('Customer notes (closed day)'); }

  // ── AM/PM preference a dispatcher set by hand ───────────────────────────────
  const amPm = note?.delivery_window === 'AM' || note?.delivery_window === 'PM'
    ? note.delivery_window : null;
  if (amPm) { kinds.push('half_day'); sources.add('Customer notes (AM/PM)'); }

  if (!kinds.length) return null;

  const tier = TIER_ORDER.find((t) => kinds.includes(t));

  // Did we actually make the dock? Only answerable when we hold BOTH a close time and a
  // real delivery stamp — otherwise it stays null and the report prints nothing rather
  // than implying we were on time.
  const deliveredMin = clockMinFromStamp(stop?.deliveredDTTM);
  let missedByMin = null;
  // RECEIVING HOURS GOVERN FREIGHT COMING IN, AND A PICKUP IS NOT THAT. Every stop
  // carries stopType PU or DO, and a completed pickup is also status DELIVERED — the
  // same conflation that once had this app telling a shipper "your delivery is complete"
  // at the moment we took custody (v0.54.89). Here it produced two false misses on one
  // board: an internal Davis pickup collected at 12:05p, exactly as its order asked
  // ("PICK UP BEFORE 1:00PM"), scored 65 minutes late against a consignee close time it
  // had inherited from a customer_notes doc that has nothing to do with pickups. The
  // hours stay on the row as context; only the ACCUSATION is withheld.
  const isPickup = stop?.stopType === 'PU';
  if (deliveredMin != null && !isPickup) {
    if (split) {
      // Only the GAP is a miss. Arriving after the dock reopens is exactly what the
      // customer asked for and must never be reported as late.
      if (deliveredMin > split.shutFromMin && deliveredMin < split.shutUntilMin) {
        missedByMin = deliveredMin - split.shutFromMin;
      }
    } else if (closeMin != null && deliveredMin > closeMin) {
      missedByMin = deliveredMin - closeMin;
    }
  }

  return {
    tier,
    kinds: TIER_ORDER.filter((t) => kinds.includes(t)),
    hoursLabel,
    openMin,
    closeMin,
    hoursTier,
    hoursProvenance,
    orderWindowLabel: win ? `${fmtMin(win.openMin)}–${fmtMin(win.closeMin)}` : '',
    orderWindowKind: win ? win.kind : '',
    appointmentReasons: appts,
    closedToday,
    closedDayLabel: closedToday && dayKey ? DAY_LABEL[dayKey] : '',
    amPm,
    deliveredMin,
    missedByMin,
    splitWindow: split,
    sources: [...sources],
    summary: summarize({ hoursLabel, win, appts, closedToday, dayKey, amPm }),
  };
}

// One line a dispatcher can read at a glance. Leads with the hardest constraint.
function summarize({ hoursLabel, win, appts, closedToday, dayKey, amPm }) {
  const parts = [];
  if (closedToday) parts.push(`Closed ${DAY_LABEL[dayKey]}`);
  if (hoursLabel) parts.push(`Receiving ${hoursLabel}`);
  if (win) {
    parts.push(win.kind === 'appointment'
      ? `Booked ${fmtMin(win.openMin)}–${fmtMin(win.closeMin)}`
      : `Window ${fmtMin(win.openMin)}–${fmtMin(win.closeMin)}`);
  }
  if (appts.length) parts.push(appts[0]);
  if (amPm) parts.push(`${amPm} only`);
  return parts.join(' · ');
}

/**
 * Every restricted PRO on a board, most-constrained first.
 *
 * @param stops  the day's stops
 * @param notes  Map<matchKey, note> — pass an empty Map when notes are unavailable, and
 *               say so in the output rather than letting an empty map read as "no
 *               customer has hours on file".
 */
export function buildTimeRestrictionRows(stops = [], notes = new Map(), servedDate = null) {
  const defaultSlots = detectDefaultSlots(stops);
  const rows = [];
  for (const stop of stops) {
    const note = notes.get?.(stop?.matchKey) ?? null;
    const r = classifyStopTimeRestriction(stop, note, servedDate, defaultSlots);
    if (!r) continue;
    rows.push({
      pro: stop.primaryPro || stop.pro || stop.stopNbr || '',
      orderNbr: stop.orderNbr || '',
      customer: stop.businessName || '',
      address: stop.addr1 || '',
      city: stop.city || '',
      state: stop.state || '',
      zip: stop.zip || '',
      stopType: stop.stopType === 'PU' ? 'Pickup' : 'Delivery',
      status: stop.normalizedStatus || '',
      // A stop carried over from an earlier day is still undelivered freight that
      // carries a clock. Flagged rather than hidden: an appointment-required stop
      // sitting since Monday is the most actionable row on the sheet.
      carryover: stop.carryover ? 'Yes' : '',
      scheduledDate: stop.scheduledDate || '',
      route: stop.routeName || '',
      driver: stop.driverName || '',
      tier: r.tier,
      tierLabel: TIER_LABEL[r.tier],
      restriction: r.summary,
      receivingHours: r.hoursLabel,
      hoursSource: HOURS_SOURCE_LABEL[r.hoursProvenance] || '',
      orderWindow: r.orderWindowLabel,
      appointment: r.appointmentReasons.join('; '),
      closedToday: r.closedToday ? 'Yes' : '',
      amPm: r.amPm || '',
      deliveredAt: r.deliveredMin != null ? fmtMin(r.deliveredMin) : '',
      missedCloseByMin: r.missedByMin != null ? String(r.missedByMin) : '',
      sources: r.sources.join('; '),
      // Sort key only — the earliest thing that shuts on this stop. Not a CSV column.
      _closeMin: r.closeMin ?? (r.splitWindow ? r.splitWindow.shutFromMin : null),
    });
  }
  const rank = (t) => TIER_ORDER.indexOf(t);
  // Within a tier, EARLIEST CLOSE FIRST. That is the order a dispatcher works the
  // board in: the dock that shuts at 11am has to be planned before the one that shuts
  // at 5pm, whatever the customer is called. Stops with no close time sort last.
  const closeOf = (r) => (r._closeMin == null ? Number.POSITIVE_INFINITY : r._closeMin);
  rows.sort((a, b) => rank(a.tier) - rank(b.tier)
    || closeOf(a) - closeOf(b)
    || String(a.customer).localeCompare(String(b.customer))
    || String(a.pro).localeCompare(String(b.pro)));
  return rows;
}

export const HOURS_SOURCE_LABEL = {
  dispatcher: 'Dispatcher',
  saved: 'Saved on customer',
  'order-text': 'This order',
};

export const CSV_COLUMNS = [
  ['pro', 'PRO'],
  ['orderNbr', 'Order #'],
  ['customer', 'Customer'],
  ['address', 'Address'],
  ['city', 'City'],
  ['state', 'State'],
  ['zip', 'ZIP'],
  ['stopType', 'Type'],
  ['status', 'Status'],
  ['carryover', 'Carried over'],
  ['scheduledDate', 'Scheduled for'],
  ['route', 'Route'],
  ['driver', 'Driver'],
  ['tierLabel', 'Restriction type'],
  ['restriction', 'Restriction'],
  ['receivingHours', 'Receiving hours'],
  ['hoursSource', 'Hours source'],
  ['orderWindow', 'Order window'],
  ['appointment', 'Appointment / call-ahead'],
  ['closedToday', 'Closed today'],
  ['amPm', 'AM/PM'],
  ['deliveredAt', 'Delivered at'],
  ['missedCloseByMin', 'Minutes past close'],
  ['sources', 'Signal source'],
];

// RFC 4180. A leading =, +, - or @ is prefixed with a single quote so Excel treats the
// cell as text: a customer named '-ACME' would otherwise be parsed as a formula.
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns = CSV_COLUMNS) {
  const lines = [columns.map(([, h]) => csvCell(h)).join(',')];
  for (const r of rows) lines.push(columns.map(([k]) => csvCell(r[k])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

// Counts the report leads with. Kept here so the PDF and the endpoint cannot drift.
export function summarizeRows(rows = []) {
  const byTier = {};
  for (const t of TIER_ORDER) byTier[t] = 0;
  let missed = 0; let carried = 0; let open = 0;
  const customers = new Set();
  for (const r of rows) {
    byTier[r.tier] = (byTier[r.tier] || 0) + 1;
    if (r.customer) customers.add(r.customer);
    if (r.missedCloseByMin) missed += 1;
    if (r.carryover) carried += 1;
    if (r.status && r.status !== 'DELIVERED') open += 1;
  }
  return {
    total: rows.length, byTier, customers: customers.size,
    missedClose: missed, carryover: carried, stillOpen: open,
  };
}
