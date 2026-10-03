// src/lib/order-view.js — the ORDER VIEW window's rules, PURE (v1.113.0).
//
// Chad, 10/03: "i want to have a button that expands an order from the side bar to a floating
// window like when we hit the duplicate order button. I want to redesign the window to better
// present the full orders details from more of a customer service perspective."
//
// Everything the window says is decided here, from the board row, the customer's note and the
// screen's own board flags — never a NuVizz call, never a guess. The window answers, in order:
// where is it, when is it due, what is on it, what needs attention, what to do next. Rules:
//  · MISSING IS MISSING. Most board rows are list rows (nuvizz-list toBoardStop): no contact, no
//    line items, no notes, no references until the order is enriched or refreshed. Absent data is
//    reported as "not loaded", never as a zero or an empty string that reads as a fact.
//  · CONFIRMED vs ESTIMATED vs INFERRED are kept apart. NuVizz's own ETA is "as of" the moment it
//    was read; our ETA model is an estimate with its error band; a requirement read out of the
//    order's free text is "in the order text", never presented as a saved customer requirement.
//  · ONE next action, chosen deterministically: blockers first, then a list-only row is loaded,
//    then what the order's status calls for. Every alert carries the action that resolves it.
// test/order-view.test.mjs pins every rule.

import { stopTimelineModel } from './stop-timeline.js';
import { routeStopEta } from './route-stop-line.js';
import { resolveStopContact, orderContactAside, isDialable } from './stop-contact.js';
import { hoursProvenance } from './hours-provenance.js';
import { addressLooksOff } from './address-fix.js';
import { stopHandlingFlags, HANDLING_FLAGS } from './handling-flags.js';
import { closedDayTier, dayReceivingWindow, stopPosition, isFinishedStop, isSetAsideRoute, isAppointmentRoute } from './board-flags.js';
import { orderWindow, clockMinFromStamp, ALL_DAY_MIN } from './time-restrictions.js';

const t = (v) => (v == null ? '' : String(v).trim());
const num = (v) => {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── FORMATTING ────────────────────────────────────────────────────────────────

/** (770) 555-1212 for a US number; anything else exactly as given. '' stays ''. */
export function formatPhone(phone) {
  const s = t(phone);
  if (!s) return '';
  const d = s.replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return s;
}

/** A number with thousands separators, or '' when there is no number. */
export function fmtCount(n) {
  const v = num(n);
  if (v == null) return '';
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const pad2 = (n) => String(n).padStart(2, '0');
const twelve = (h, m) => `${h % 12 || 12}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}`;

/**
 * '2026-10-03T08:00:00' → '8:00 AM'. A time with no zone is NuVizz's wall clock and is read
 * as written; one carrying a zone (Z / ±hh:mm) is shown in Eastern, where Davis works.
 */
export function clockText(ts) {
  const s = t(ts);
  if (!s) return '';
  const m = /T(\d{2}):(\d{2})/.exec(s);
  if (!m) return '';
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return twelve(Number(m[1]), Number(m[2]));
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(d);
}

/** Minutes after midnight of a timestamp's wall clock (same reading as clockText), or null. */
export function clockMinutes(ts) {
  const s = t(ts);
  const m = /T(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return Number(m[1]) * 60 + Number(m[2]);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value);
  const mi = Number(parts.find((p) => p.type === 'minute')?.value);
  return Number.isFinite(h) && Number.isFinite(mi) ? h * 60 + mi : null;
}

/** The Eastern calendar day a timestamp falls on (wall-clock stamps read as written), or ''. */
function etDayOf(ts) {
  const s = t(ts);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return '';
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

const minText = (min) => (min == null ? '' : twelve(Math.floor(min / 60) % 24, Math.round(min % 60)));

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
const ymdOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(t(s));

/** 'YYYY-MM-DD' → 'mon'..'sun', read at noon UTC so no zone can move the weekday. */
export function dayKeyOf(ymd) {
  if (!ymdOk(ymd)) return null;
  return DAY_KEYS[new Date(`${t(ymd)}T12:00:00Z`).getUTCDay()];
}

/** 'YYYY-MM-DD' → 'Sat, Oct 4' (with ', 2027' only when it is not this year). */
export function dayText(ymd, today = null) {
  if (!ymdOk(ymd)) return '';
  const d = new Date(`${t(ymd)}T12:00:00Z`);
  const sameYear = ymdOk(today) && t(today).slice(0, 4) === t(ymd).slice(0, 4);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}

/** The original order instructions as they read on the card: prefix and boilerplate gone. */
export function cleanOrderText(text) {
  return t(text).split('\n')
    .map((l) => l.replace(/^\s*SPL-INSTR-TEXT\s*:?\s*/i, '').trim())
    .filter((l) => l && !/do\s*not\s*break\s*down\s*skid/i.test(l))
    .join('\n');
}

// ── WHAT THE ORDER TEXT SAYS (inferred, and labelled so) ─────────────────────
// Free text from the shipper. Each cue keeps the sentence it came from so the window can show
// the original next to the summary, and none of them is ever shown as a saved requirement.
const CUE_RULES = [
  { key: 'call_ahead', label: 'Call before arrival', re: /\b(call|phone)\b[^.\n]{0,40}\b(ahead|before|prior|upon arrival|on arrival|when (?:you are )?close)\b|\bcall\s*ahead\b|\b\d+\s*(?:min|minutes|hr|hour)s?\s*(?:call|notice)\b/i },
  { key: 'appointment', label: 'Appointment', re: /\b(appt|appointment|by appt|schedule(?:d)? delivery)\b/i },
  { key: 'liftgate', label: 'Liftgate', re: /\blift\s*-?\s*gate\b/i },
  { key: 'inside', label: 'Inside delivery', re: /\binside\s+(delivery|del)\b|\bdeliver\s+inside\b|\bwhite\s*glove\b/i },
  { key: 'residential', label: 'Residential', re: /\bresidential\b|\bresidence\b/i },
  { key: 'dock', label: 'Dock or door', re: /\b(dock|door|bay)\s*#?\s*\d+\b|\b(back|rear|side)\s+(door|dock|entrance)\b|\breceiving\s+door\b/i },
  { key: 'gate', label: 'Gate or access code', re: /\bgate\s*(code|#)\b|\baccess\s*code\b|\bbuzz(?:er)?\b|\bcode\s*[:#]?\s*\d{3,}\b/i },
  { key: 'hours', label: 'Hours in the order text', re: /\b(close[sd]?|closing|open|receiving|hours)\b[^.\n]{0,30}\b\d{1,2}(:\d{2})?\s*(am|pm|a|p)\b/i },
];

// A line of shipper text often carries two instructions ("CALL 30 MIN AHEAD. USE DOCK 4.");
// each cue quotes only its own sentence, falling back to the line when a match spans two.
const sentencesOf = (line) => line.split(/(?<=[.;!?])\s+(?=\S)/).map((x) => x.trim()).filter(Boolean);

// "DO NOT CALL BEFORE ARRIVAL" is the opposite of a call-ahead — but only when the negation
// governs the call itself: "DO NOT STACK - CALL AHEAD" and "PO NO 4471 CALL AHEAD" still ask.
const NEGATED_CALL = /\b(?:do\s*not|don'?t|dont|never|no(?:\s+need\s+to)?)\s+(?:call|phone)\b/i;
const cueIn = (r, x) => r.re.test(x) && !(r.key === 'call_ahead' && NEGATED_CALL.test(x));

/** Cues read out of the order's own text: [{ key, label, snippet }], each once, in rule order. */
export function instructionCues(text) {
  const lines = cleanOrderText(text).split('\n').filter(Boolean);
  const out = [];
  for (const r of CUE_RULES) {
    let quote = '';
    for (const l of lines) {
      const sentences = sentencesOf(l);
      // Its own sentence first; the whole line only when the match spans two sentences.
      quote = sentences.find((x) => cueIn(r, x)) || (cueIn(r, l) && !sentences.some((x) => r.re.test(x)) ? l : '');
      if (quote) break;
    }
    if (!quote) continue;
    out.push({ key: r.key, label: r.label, snippet: quote.length > 140 ? `${quote.slice(0, 137)}…` : quote });
  }
  return out;
}

// ── THE SCREEN'S BOARD FLAGS FOR ONE ORDER ───────────────────────────────────

/** The flag rows (computeBoardFlags().rows) that name this order — directly, as one of a dock's
 *  orders, or inside a collapsed summary row. Each row once. */
export function flagsForStop(rows, stop) {
  const nbr = t(stop?.stopNbr || stop?.pro);
  if (!nbr || !Array.isArray(rows)) return [];
  const names = (r) => t(r?.stopNbr) === nbr || (Array.isArray(r?.stopNbrs) && r.stopNbrs.map(t).includes(nbr));
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    if (names(r)) out.push(r);
    else if (Array.isArray(r.collapsedRows)) for (const c of r.collapsedRows) if (names(c)) out.push(c);
  }
  return out;
}

// ── LABELS (the notes editor's own words, App.jsx EQUIPMENT_OPTIONS / DOCK_TYPES) ─────────────
const EQUIPMENT_LABEL = {
  no_tractor_trailer: 'No tractor trailer', uline_straight_truck: 'Uline: straight truck (advisory)',
  '26ft_max': '26ft max', no_53ft: 'No 53ft', box_truck_only: 'Box truck only',
  no_overhead_clearance: 'Low overhead clearance', tractor_trailer_friendly: 'Tractor trailer friendly',
};
const DOCK_LABEL = { dock_high: 'Dock high', ground: 'Ground level', either: 'Dock high or ground' };
const BUILDING_LABEL = { residential: 'Residential', school: 'School', church: 'Church', government: 'Government' };
const STATUS_LABEL = {
  UNPLANNED: 'Unplanned', SCHEDULED: 'Scheduled', OUT_FOR_DEL: 'Out for delivery',
  ARRIVED: 'Arrived', DELIVERED: 'Delivered', EXCEPTION: 'Exception',
};

const SAVED = 'Saved for this customer';
const UNRECORDED = 'Source not recorded';
const AUTO = 'Auto-detected — verify';
const ORDER_TEXT = 'In this order’s text';
const NUVIZZ = 'On the NuVizz order';

const TIER_RANK = { block: 0, warn: 1, info: 2 };
// A flag row's title by its rule, for the rows a collapsed batch hands over untitled
// (board-flags.js — the rule ids its row() calls emit).
const FLAG_RULE_TITLE = {
  hours_risk: 'May miss receiving hours', no_driver_hours: 'No driver for a deadline',
  trailer_conflict: 'No tractor trailer at this stop', place_trailer_conflict: 'Tight place for a tractor-trailer',
  box_truck_conflict: 'Needs a tractor trailer', route_name_ambiguous: 'Two live loads share this route name',
};

/**
 * EVERYTHING THE ORDER VIEW SHOWS, from what the screen already holds.
 *
 * @param {object} input
 * @param {object} input.stop      the live board row (the card's useLiveStop answer)
 * @param {object} input.note      the customer's customer_notes doc, or null
 * @param {string} input.kind      classifyStopStatus(stop) — the card's own status reading
 * @param {object[]} input.flags   this order's board-flag rows (flagsForStop), or []
 * @param {object} input.eta       this order's etaByStop entry from the same flags run, or null
 * @param {string} input.boardDate the day the screen shows (YYYY-MM-DD)
 * @param {string} input.today     today in Eastern (YYYY-MM-DD)
 * @param {number} input.nowMin    minutes after midnight now, Eastern
 * @param {string} input.driverPhone the driver's number when the screen has it, else ''
 * @param {Set} input.defaultSlots detectDefaultSlots(board) — NuVizz's creation stamp, which must
 *                                 not pose as an appointment (time-restrictions.js), or null
 */
export function buildOrderView({ stop, note = null, kind = null, flags = [], eta = null, boardDate = null, today = null, nowMin = null, driverPhone = '', defaultSlots = null } = {}) {
  const s = stop || {};
  const k = STATUS_LABEL[kind] ? kind : 'SCHEDULED';
  const finished = k === 'DELIVERED' || isFinishedStop(s);
  const exec = s.raw?.stopExecutionInfo || {};
  const deliveredTs = t(s.deliveredDTTM) || t(exec.to?.confirmedDTTM) || t(exec.receiveDTTM);
  // THE ORDER'S OWN DAY. A row on the board is that board's day. A Past PRO search result
  // (__historical) is not a row on the screen's board, so it keeps its own date — never the
  // day the dispatcher happens to be looking at.
  const ownDay = [s.boardDate, s.scheduledDate, s.schedDate].map(t).find(ymdOk) || etDayOf(deliveredTs) || etDayOf(s.scheduledFrom) || null;
  const day = s.__historical ? ownDay : (ymdOk(boardDate) ? t(boardDate) : ownDay);
  const dayKey = dayKeyOf(day);
  const isToday = !!day && day === t(today);
  // Route state, needed before the alerts: the flag engine judges neither its set-aside routes
  // (ULINE APPT, the owner's truck) nor an unrouted unplanned order's day.
  const routeKey = t(s.loadNbr || s.routeName);
  const routed = !!routeKey;
  const setAside = routed && isSetAsideRoute(routeKey);
  // ULINE APPT is a holding pen, not a truck: "anything on a Uline appt route for a given day is
  // not actually going to deliver today" (board-flags.js). The owner's truck does deliver.
  const held = routed && isAppointmentRoute(routeKey);
  const unscheduled = !routed && (t(s.status) === '10' || k === 'UNPLANNED');

  // ── identity ──
  const pro = t(s.pro || s.stopNbr);
  const customerName = t(s.businessName);

  // ── what we hold (a list row carries none of these until enriched or refreshed) ──
  const lines = Array.isArray(s.stopDetails) ? s.stopDetails.filter((d) => d && typeof d === 'object') : [];
  const comments = Array.isArray(s.allComments) ? s.allComments : [];
  const hasContact = !!(s.contact && (t(s.contact.name) || t(s.contact.phone) || t(s.contact.email)));
  const enriched = s.enriched === true || !!s.raw || hasContact || lines.length > 0 || comments.length > 0;
  const missing = [];
  if (!hasContact) missing.push('contact');
  if (!lines.length) missing.push('items');
  if (!comments.length && !t(s.signalSources?.orderInstructions) && !t(s.orderInstructions)) missing.push('notes');
  if (![s.poRef, s.bol, s.custRef, s.orderNbr].some((v) => t(v))) missing.push('references');
  const listOnly = !enriched;

  // ── where ──
  const ov = note?.address_override || null;
  const addr1 = t(ov?.addr1 || s.addr1);
  const addr2 = t(ov?.addr2 ?? s.addr2);
  const city = t(ov?.city ?? s.city); const state = t(ov?.state ?? s.state); const zip = t(ov?.zip ?? s.zip);
  const cityLine = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const pos = stopPosition(s, note);
  const where = {
    lines: [addr1, addr2, cityLine].filter(Boolean),
    copyText: [customerName, addr1, addr2, cityLine].filter(Boolean).join('\n'),
    query: [addr1, cityLine].filter(Boolean).join(', '),
    corrected: !!ov,
    pinMoved: note?.location_override ? true : false,
    noPin: !pos,
    looksOff: !finished && addressLooksOff(s, note),
    complete: !!(addr1 && city && zip),
  };

  // ── when ──
  // A stamp dated another day belongs to that day's plan (a carried-over order keeps day one's
  // schedule and ETA). It is shown with its date and never judged against today's clock.
  const otherDayOf = (ts) => { const d = etDayOf(ts); return d && day && d !== day ? d : ''; };
  const fromTs = t(s.scheduledFrom); const toTs = t(s.scheduledTo);
  // THE WINDOW, THE WAY THE REST OF THE APP READS IT (time-restrictions.js orderWindow): NuVizz
  // stamps STRICT on nearly every stop and 08:00–20:00 on most, 05:00–05:00 is a placeholder and
  // a half-hour stamped on many unrelated customers is its creation default. Only a span narrower
  // than a working day counts, and 'strict' is never read from timeConstraint.
  let window = null;
  let windowNote = '';
  if (fromTs && toTs) {
    const ow = orderWindow(s, defaultSlots);
    if (ow) {
      const od = otherDayOf(toTs);
      window = {
        text: `${clockText(fromTs)} – ${clockText(toTs)}`, closeMin: od ? null : ow.closeMin,
        appointment: ow.kind === 'appointment', estimateOnly: false, otherDay: od ? dayText(od, today) : '',
      };
    } else {
      // Said by what orderWindow actually decided, with NuVizz's own times — never a claim that
      // NuVizz defaulted a schedule the code only knows is a working day long.
      const o = clockMinFromStamp(fromTs); const c = clockMinFromStamp(toTs);
      const raw = `${clockText(fromTs)} – ${clockText(toTs)}`;
      windowNote = o == null || c == null ? 'NuVizz’s schedule on this order carries no clock time — not a delivery window.'
        : c - o <= 0 ? `NuVizz’s schedule reads ${raw} — a placeholder, not a delivery window.`
          : o === 8 * 60 && c === 20 * 60 ? `NuVizz’s all-day default, ${raw} — not a delivery window.`
            : c - o >= ALL_DAY_MIN ? `NuVizz’s schedule ${raw} spans a working day — not read as a delivery window.`
              : `${raw} is the half hour NuVizz stamps on many unrelated orders on this board — not an appointment.`;
    }
  } else if (fromTs) {
    // A list row's scheduledFrom is NuVizz's Estimated Arrival, shared by the whole load — a
    // schedule, not this order's window. Said so, never dressed as a window.
    const od = otherDayOf(fromTs);
    window = { text: `around ${clockText(fromTs)}`, closeMin: null, appointment: false, estimateOnly: true, otherDay: od ? dayText(od, today) : '' };
  }
  // THE ETA, IN THE APP'S OWN ORDER (route-stop-line.js routeStopTime): our anchored estimate
  // first — eta-backtest put it 13-14 min off against NuVizz's 79 — then NuVizz's planned ETA.
  const nvEta = routeStopEta(s);
  const readAt = t(s.enriched_at || s.notes_refreshed_at);
  const asOf = readAt ? `${clockText(readAt)}${etDayOf(readAt) && etDayOf(readAt) !== t(today) ? ` on ${dayText(etDayOf(readAt), today)}` : ''}` : '';
  let etaView = null;
  let etaMissing = '';
  if (!finished && k !== 'ARRIVED') {
    if (isToday && eta && num(eta.etaMin) != null) {
      const band = num(eta.errorMin);
      etaView = {
        text: `about ${minText(num(eta.etaMin))}`, band: band != null ? `±${Math.round(band)} min` : '',
        basis: 'model', stale: false,
        detail: `Our estimate from the route's order and drive times${band != null ? `, ±${Math.round(band)} min` : ''}. ${eta.anchored ? 'Measured from the truck’s last recorded stop today.' : 'Projected from the route’s usual departure — no truck time recorded yet today.'}`,
      };
    } else if (nvEta?.label === 'ETA' && otherDayOf(nvEta.ts)) {
      etaMissing = `NuVizz’s planned ETA is from ${dayText(otherDayOf(nvEta.ts), today)}’s plan, not this day’s.`;
    } else if (nvEta?.label === 'ETA') {
      // A planned time that has come and gone with no arrival on our board is a stale plan,
      // not an ETA — said so, never shown as if it still held.
      const etaAt = clockMinutes(nvEta.ts);
      const stale = isToday && etaAt != null && nowMin != null && nowMin - etaAt > 15;
      etaView = { text: clockText(nvEta.ts), basis: 'nuvizz', stale, detail: stale
        ? `NuVizz planned this time${asOf ? ` (as it had it at ${asOf})` : ''}. It has passed with no arrival on our board.`
        : `NuVizz's planned ETA${asOf ? `, as NuVizz had it at ${asOf}` : ''} — it is not updated live on our board.` };
    }
    if (!etaView && !etaMissing) {
      etaMissing = isToday ? 'No live ETA for this order. NuVizz gives very few orders a per-stop ETA, and our estimate needs the route in sequence.' : 'No ETA before the delivery day.';
    }
  }
  const arrivedTs = t(s.arrivalDTTM) || t(exec.to?.arrivalDTTM) || t(exec.arrivalDTTM);
  const when = {
    day, dayLabel: dayText(day, today), isToday,
    window, windowNote, eta: etaView, etaMissing,
    arrived: (k === 'ARRIVED' || k === 'DELIVERED') && arrivedTs ? clockText(arrivedTs) : '',
    delivered: k === 'DELIVERED' && deliveredTs ? clockText(deliveredTs) : '',
    carryoverFrom: s.carryover === true && ymdOk(s.scheduledDate) && t(s.scheduledDate) !== day ? dayText(s.scheduledDate, today) : '',
  };

  // ── who to call ──
  const c = resolveStopContact(s, note);
  const aside = orderContactAside(s, c);
  const saved = Array.isArray(note?.contacts) ? note.contacts.filter((x) => x && (t(x.name) || t(x.phone))) : [];
  const contact = {
    name: c.name, phone: c.phone, phoneDisplay: formatPhone(c.phone), dialable: c.dialable, source: c.source, role: c.role,
    email: t(s.contact?.email),
    aside: aside ? { name: aside.name, phoneDisplay: formatPhone(aside.phone), phone: aside.phone } : null,
    others: saved.filter((x) => !(t(x.phone) && t(x.phone) === c.phone && t(x.name) === c.name))
      .map((x) => ({ name: t(x.name), role: t(x.role), phone: t(x.phone), phoneDisplay: formatPhone(x.phone), dialable: isDialable(x.phone) })),
    known: !!(c.name || c.phone),
  };

  // ── what is on it (Davis's meaning of NuVizz's fields: cartons = pallets, volume = loose,
  //    pallets = total pieces; nuvizz-scan normalizeStop) ──
  const pallets = num(s.cartons); const loose = num(s.volume); const total = num(s.pallets); const weight = num(s.weight);
  const freight = {
    pallets, loose, total: total != null ? total : (pallets != null || loose != null ? (pallets ?? 0) + (loose ?? 0) : null),
    weight, known: [pallets, loose, total, weight].some((v) => v != null),
    items: lines.map((d) => ({
      product: t(d.product) || t(d.sku) || 'Item',
      qty: num(d.quantity), uom: t(d.quantityUOM),
      weight: num(d.weight), weightUOM: t(d.weightUOM),
      cls: t(d.referenceText), oversize: t(d.productCategory).toUpperCase() === 'L',
      dims: [d.length, d.width, d.height].every((v) => num(v) != null) ? `${num(d.length)} × ${num(d.width)} × ${num(d.height)}${t(d.lengthUOM) ? ` ${t(d.lengthUOM).toLowerCase() === 'inch' ? 'in' : t(d.lengthUOM).toLowerCase()}` : ''}` : '',
    })),
    handling: stopHandlingFlags(s).map((key) => HANDLING_FLAGS[key]?.label || key),
  };
  const refs = [
    ['PO', s.poRef], ['BOL', s.bol], ['Customer ref', s.custRef], ['Order', s.orderNbr],
    ['Shipment', s.shipmentNbr && t(s.shipmentNbr) !== pro ? s.shipmentNbr : ''],
    ['Warehouse', s.warehouse], ['Terms', s.terms], ['Account', s.customerAccount],
  ].filter(([, v]) => t(v)).map(([label, value]) => ({ label, value: t(value) }));

  // ── requirements, each with where it came from ──
  const reqs = [];
  const req = (key, label, detail, source, must = false) => reqs.push({ key, label, detail: t(detail), source, must });
  const prov = hoursProvenance(note);
  // hoursProvenance's 'unrecorded' is hours with no trail either way — never dressed as saved.
  const hoursSource = prov?.kind === 'dispatcher' ? SAVED : prov?.kind === 'auto' ? AUTO : UNRECORDED;
  const recv = dayKey ? dayReceivingWindow(note, dayKey) : null;
  if (recv && (recv.openMin != null || recv.closeMin != null)) {
    const txt = recv.openMin != null && recv.closeMin != null ? `${minText(recv.openMin)} – ${minText(recv.closeMin)}` : recv.closeMin != null ? `until ${minText(recv.closeMin)}` : `from ${minText(recv.openMin)}`;
    req('hours', `Receiving ${txt}`, dayKey ? `${DAY_NAMES[dayKey]}'s hours` : '', hoursSource, false);
  }
  if (note?.appointment_required) req('appointment', 'Appointment required', note.appointment_notes, SAVED, true);
  else if (t(note?.appointment_notes)) req('appointment_notes', 'Appointment notes', note.appointment_notes, SAVED);
  if (window && !window.estimateOnly && !window.otherDay) req('window', window.appointment ? 'Appointment slot' : 'Delivery window', window.text, NUVIZZ, true);
  if (note?.liftgate_required) req('liftgate', 'Liftgate required', '', SAVED, true);
  if (t(note?.delivery_window)) req('ampm', `${t(note.delivery_window)} delivery only`, '', SAVED, true);
  if (DOCK_LABEL[note?.dock_type]) req('dock', DOCK_LABEL[note.dock_type], note?.dock_notes, SAVED);
  else if (t(note?.dock_notes)) req('dock_notes', 'Dock notes', note.dock_notes, SAVED);
  const equip = Array.isArray(note?.equipment_restrictions) ? note.equipment_restrictions : [];
  const equipLabels = equip.map((e) => EQUIPMENT_LABEL[e]).filter(Boolean);
  if (equipLabels.length) req('equipment', equipLabels.join(' · '), '', note?.manual_overrides?.equipment_restrictions ? SAVED : AUTO, equip.some((e) => e !== 'tractor_trailer_friendly' && e !== 'uline_straight_truck'));
  if (note?.vehicle_eligibility === 'box_only') req('vehicle', 'Box truck only', '', SAVED, true);
  else if (note?.vehicle_eligibility === 'tractor') req('vehicle', 'Tractor trailer OK', '', SAVED);
  if (BUILDING_LABEL[note?.building_type]) req('building', `${BUILDING_LABEL[note.building_type]} building`, '', SAVED);
  for (const label of freight.handling) req(`handling:${label}`, label, '', ORDER_TEXT, true);
  const dnsDrivers = Array.isArray(note?.dns_drivers) ? note.dns_drivers.map(t).filter(Boolean) : [];
  if (note?.do_not_send && dnsDrivers.length) req('dns_drivers', `Not allowed: ${dnsDrivers.join(', ')}`, 'Drivers barred from this customer', SAVED, true);

  const instructionText = cleanOrderText(s.signalSources?.orderInstructions || s.orderInstructions);
  const cues = instructionCues(instructionText)
    // A cue the customer's saved notes already state is not repeated as an inference.
    .filter((cu) => !(cu.key === 'appointment' && note?.appointment_required) && !(cu.key === 'liftgate' && note?.liftgate_required));
  for (const cu of cues) req(`cue:${cu.key}`, cu.label, cu.snippet, ORDER_TEXT, false);

  // ── what needs attention ──
  const alerts = [];
  const alert = (a) => { if (!alerts.some((x) => x.key === a.key)) alerts.push(a); };
  const driver = t(s.driverName);
  // Every action offered must be one that can run: no "View the route" for an order on no route,
  // no "Call" without a number. A list-only row has not loaded its contact, so the move that gets
  // one is loading it — "no number" is not yet a fact about that order.
  const reachDriver = driver ? { key: 'text-driver', label: 'Text the driver' } : routed ? { key: 'open-route', label: 'View the route' } : null;
  const reachCustomer = (label) => (contact.dialable ? { key: 'call-customer', label }
    : listOnly ? { key: 'load-order', label: 'Load the order to call' } : { key: 'add-contact', label: 'Add a customer number' });
  // THE FLAG ENGINE'S OWN GATES (board-flags.js computeBoardFlags): a set-aside route (ULINE APPT,
  // the owner's truck) is judged for none of these, and an unrouted unplanned order's day is not
  // judged for closed days — freight parked BECAUSE the customer is closed is the dispatcher
  // having already solved it.
  if ((s.dupNbr || s.dupNbrSuspect) && !finished && !setAside) {
    alert({ key: 'dup', tier: 'block', title: 'Two NuVizz orders share this number', detail: 'Check you are looking at the right order before acting on it.', action: { key: 'load-order', label: 'Load the order from NuVizz' } });
  }
  if (note?.do_not_send && !finished) {
    if (dnsDrivers.length && driver && dnsDrivers.some((d) => d.toUpperCase() === driver.toUpperCase())) {
      alert({ key: 'dns-driver', tier: 'block', title: `${driver} is not allowed at this customer`, detail: 'The customer notes bar this driver. Move the order to another route.', action: routed ? { key: 'open-route', label: 'View the route' } : null });
    } else if (!dnsDrivers.length) {
      alert({ key: 'dns', tier: 'block', title: 'Customer is marked Do not send', detail: 'Read the customer notes before this goes out.', action: { key: 'edit-notes', label: 'Open customer notes' } });
    }
  }
  const closedBy = !finished && !setAside && !unscheduled && dayKey ? closedDayTier(note, dayKey, s) : null;
  if (closedBy === 'auto') {
    // The stored-day rule (CLOSED_DAYS_FROM_ORDER=off): the scanner read it from some order —
    // amber on the panel, and a check here, never a blocker.
    alert({ key: 'closed', tier: 'warn', title: `Customer may be closed ${DAY_NAMES[dayKey]}s`, detail: 'The scanner read it from an earlier order — judge the evidence before moving it.', action: reachCustomer('Call the customer') });
  } else if (closedBy) {
    alert({ key: 'closed', tier: 'block', title: `Customer is closed ${DAY_NAMES[dayKey]}s`, detail: closedBy === 'order' ? 'This order’s own text says so.' : 'Saved in the customer notes by a dispatcher.', action: { key: 'change-date', label: 'Change the delivery date' } });
  }
  if (where.noPin && !finished && !setAside) {
    alert({ key: 'no-pin', tier: 'block', title: 'No map location', detail: 'Routing cannot place this order until it has a pin.', action: { key: 'fix-pin', label: 'Correct the pin' } });
  }
  if (where.looksOff) {
    alert({ key: 'address', tier: 'warn', title: 'Address may be split wrong', detail: 'Part of the street sits in address line 2.', action: { key: 'fix-address', label: 'Fix the address' } });
  }
  // The screen's own board flags — the same rows as the flags panel. Their titles end
  // "— CUSTOMER" for the panel's list; this window already names the customer. A row recovered
  // from a collapsed batch carries no title or fingerprint (board-flags.js collapsedRows), so it
  // is titled by its rule and keyed by rule, order and day.
  const stripName = (title) => (customerName && title.toUpperCase().endsWith(` — ${customerName.toUpperCase()}`) ? title.slice(0, -(customerName.length + 3)).trim() : title);
  for (const f of Array.isArray(flags) ? flags : []) {
    if (!f || ['dup_number', 'no_location', 'closed_today'].includes(f.rule)) continue; // read directly above
    const tier = f.tier === 'critical' || f.tier === 'red' ? 'block' : 'warn';
    const estimate = f.rule === 'hours_risk' || f.rule === 'no_driver_hours';
    let basis = '';
    if (f.rule === 'hours_risk' && num(f.etaMin) != null && num(f.closeMin) != null) {
      basis = `Estimate: arrives about ${minText(num(f.etaMin))}${num(f.errorMin) != null ? ` ±${Math.round(num(f.errorMin))} min` : ''}; receiving closes ${minText(num(f.closeMin))}${f.hoursTier === 'assumed' ? ' (assumed — no hours on file)' : f.hoursTier === 'auto' ? ' (auto-detected hours)' : ''}. ${f.anchored ? 'Measured from the truck.' : 'Projected from the route’s usual departure.'}`;
    }
    alert({
      key: `flag:${f.rule}:${f.fingerprint || f.title || `${t(f.stopNbr)}|${t(f.servedDate)}`}`, tier, estimate,
      title: stripName(t(f.title)) || FLAG_RULE_TITLE[f.rule] || 'Board flag', detail: t(f.detail), basis,
      action: estimate
        ? (contact.dialable || listOnly ? reachCustomer('Call about receiving hours') : { key: 'change-date', label: 'Change the delivery date' })
        : routed ? { key: 'open-route', label: 'View the route' } : null,
    });
  }
  // The window: only a real window (time-restrictions.js) dated this day, on today's board,
  // and only before delivery.
  if (!finished && isToday && window && window.closeMin != null && nowMin != null) {
    const left = window.closeMin - nowMin;
    if (left < 0) {
      alert({ key: 'window-closed', tier: 'block', title: `Delivery window closed at ${minText(window.closeMin)}`, detail: 'Our board does not show it delivered. Delivered can lag the scan by a few minutes.', action: reachCustomer('Call the customer') });
    } else if (left <= 60) {
      alert({ key: 'window-closing', tier: 'warn', title: `Delivery window closes in ${left} min`, detail: `At ${minText(window.closeMin)}.`, action: reachDriver || reachCustomer('Call the customer') });
    }
  }
  if (etaView?.stale) {
    alert({ key: 'eta-stale', tier: 'warn', title: `Planned ETA ${etaView.text} has passed`, detail: 'Our board shows no arrival yet. The plan is not updated live — ask the driver where the truck is.', action: reachDriver });
  }
  if (k === 'EXCEPTION') {
    alert({ key: 'exception', tier: 'block', title: 'NuVizz marked this order an exception', detail: t(s.status) === '80' ? 'Unable to deliver (code 80).' : 'Open the activity to see what the driver recorded.', action: { key: 'activity', label: 'See the activity' } });
  }
  if (when.carryoverFrom) alert({ key: 'carryover', tier: 'info', title: `Carried over from ${when.carryoverFrom}`, detail: 'It did not deliver on its first day.', action: null });
  if (s.isAttempt) alert({ key: 'attempt', tier: 'info', title: 'This is a re-attempt', detail: 'The shipment number carries ATT.', action: null });
  // Late against hours a dispatcher typed — scanner-read hours are advisory (board-flags.js
  // dayReceivingWindow) and never become a stated fact here.
  if (finished && k === 'DELIVERED' && note && dayKey && recv?.tier === 'typed') {
    const recvClose = recv.closeMin;
    const at = clockMinutes(deliveredTs);
    if (recvClose != null && at != null && at > recvClose) alert({ key: 'late-delivery', tier: 'info', title: `Delivered ${at - recvClose} min after receiving closed`, detail: `Receiving closed at ${minText(recvClose)}, as a dispatcher saved it.`, action: null });
  }
  alerts.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);

  // ── the one next action ──
  const route = {
    name: t(s.routeName) || (t(s.loadNbr) && !/^\d+$/.test(t(s.loadNbr)) ? t(s.loadNbr) : ''),
    seq: num(s.routeSeq), driver, driverPhone: t(driverPhone), driverPhoneDisplay: formatPhone(driverPhone),
    planned: routed, held,
  };
  const podDocs = Array.isArray(s.podDocs) ? s.podDocs : [];
  const callAhead = cues.some((cu) => cu.key === 'call_ahead');
  // tone: 'act' when something needs doing now (the band says Next and the button is filled);
  // 'calm' when nothing is wrong (the band says On track and the button steps back). The window
  // only raises its voice when an order needs it.
  let next;
  const blocker = alerts.find((a) => a.tier === 'block' && a.action);
  const check = alerts.find((a) => a.tier === 'warn' && a.action);
  const moving = k === 'OUT_FOR_DEL' || k === 'ARRIVED';
  if (k === 'DELIVERED') {
    next = podDocs.length
      ? { key: 'view-pod', label: 'View proof of delivery', tone: 'calm', reason: `Delivered${when.delivered ? ` at ${when.delivered}` : ''} · ${podDocs.length} document${podDocs.length === 1 ? '' : 's'} on file.` }
      : { key: 'load-pod', label: 'Load delivery photos', tone: 'calm', reason: `Delivered${when.delivered ? ` at ${when.delivered}` : ''}. Our board has no proof of delivery yet — 1 NuVizz call.` };
  } else if (blocker) {
    next = { key: blocker.action.key, label: blocker.action.label, tone: 'act', reason: blocker.title, alertKey: blocker.key };
  } else if (listOnly && pro) {
    next = { key: 'load-order', label: 'Load the full order', tone: 'act', reason: 'Our board has only the list row — no contact, items or notes yet. 1 NuVizz call.' };
  } else if (k === 'OUT_FOR_DEL' && (callAhead || note?.appointment_required) && contact.dialable) {
    // The truck is on its way: a call-ahead the order asks for is due now. Once it has
    // ARRIVED the call-ahead is past — that falls to reaching the driver below.
    next = { key: 'call-customer', label: 'Call the customer', tone: 'act', reason: callAhead ? 'The order asks for a call before arrival.' : 'Appointment required for this customer.' };
  } else if (check) {
    next = { key: check.action.key, label: check.action.label, tone: 'act', reason: check.title, alertKey: check.key };
  } else if (moving) {
    next = route.driverPhone && isDialable(route.driverPhone)
      ? { key: 'call-driver', label: `Call ${driver || 'the driver'}`, tone: 'calm', reason: `${STATUS_LABEL[k]}${route.name ? ` on ${route.name}${route.seq != null ? `, stop ${route.seq}` : ''}` : ''}.` }
      : driver ? { key: 'text-driver', label: `Text ${driver}`, tone: 'calm', reason: `${STATUS_LABEL[k]}${route.name ? ` on ${route.name}` : ''}. No driver number on file.` }
        : routed ? { key: 'open-route', label: 'View the route', tone: 'calm', reason: STATUS_LABEL[k] }
          : { ...reachCustomer('Call the customer'), tone: contact.dialable ? 'calm' : 'act', reason: `${STATUS_LABEL[k]} — no route or driver on our board.` };
  } else if (!contact.dialable) {
    next = { key: 'add-contact', label: 'Add a customer number', tone: 'act', reason: contact.name ? `${contact.name} is on file, but no number to call.` : 'No customer contact on this order.' };
  } else if (note?.appointment_required) {
    next = { key: 'call-customer', label: 'Call to confirm the appointment', tone: 'act', reason: 'Appointment required for this customer.' };
  } else if (callAhead) {
    // Not on its way yet: the call-ahead is a reminder for later, not a job for now.
    next = { key: 'call-customer', label: 'Call the customer', tone: 'calm', reason: 'The order asks for a call before arrival — due once the truck is on its way.' };
  } else {
    next = { key: 'call-customer', label: 'Call the customer', tone: 'calm', reason: k === 'UNPLANNED' ? 'Unplanned — not on a route yet.' : `${STATUS_LABEL[k]}${route.name ? ` on ${route.name}` : ''}${when.dayLabel ? ` for ${when.dayLabel}` : ''}.` };
  }

  // ── journey ──
  const timeline = stopTimelineModel({ kind: k, arrivedAt: when.arrived || null, deliveredAt: when.delivered || null, etaClock: etaView?.basis === 'nuvizz' ? etaView.text : null, etaIsReal: etaView?.basis === 'nuvizz' });

  return {
    pro, stopId: t(s.stopId), customerName,
    status: { kind: k, label: STATUS_LABEL[k], finished },
    when, where, contact, freight, refs,
    requirements: reqs, instructions: instructionText, cues,
    alerts, next, route, timeline,
    pod: { count: podDocs.length },
    data: { listOnly, missing, enriched },
    freshness: {
      board: clockText(s.listUpdatedDTTM),
      details: clockText(s.enriched_at),
      notes: clockText(s.notes_refreshed_at),
    },
  };
}

// ── MESSAGE DRAFTS ────────────────────────────────────────────────────────────
// Editable starting points for the existing Text composer, built only from facts the view
// verified. Nothing is sent from here — the dispatcher reviews and presses Send in the composer.
export function orderMessageDrafts(view) {
  if (!view) return [];
  const ref = [view.pro ? `PRO ${view.pro}` : '', view.customerName].filter(Boolean).join(' — ');
  const lead = `Davis Delivery${ref ? ` (${ref})` : ''}:`;
  const out = [];
  const k = view.status?.kind;
  if (k === 'DELIVERED') {
    out.push({ key: 'delivered', label: 'Delivered', text: `${lead} your order was delivered${view.when?.delivered ? ` at ${view.when.delivered}` : ''}${view.when?.dayLabel ? ` on ${view.when.dayLabel}` : ''}.` });
    return out;
  }
  // No time is ever put in a customer's mouth from an estimate: NuVizz's planned ETA lands a
  // median 79 min off and ours is a model with a band. The dispatcher adds one if they choose.
  if (k === 'OUT_FOR_DEL') {
    out.push({ key: 'on-the-way', label: 'On the way', text: `${lead} your order is out for delivery today. Reply here with any questions.` });
  }
  if (k === 'ARRIVED') {
    out.push({ key: 'arrived', label: 'Driver has arrived', text: `${lead} our driver has arrived with your delivery.` });
  }
  // "Scheduled" only for an order on a truck's route — an unplanned order's day is NuVizz's
  // estimate, and an order held on an appointment route is parked, not scheduled.
  if (view.when?.dayLabel && view.route?.planned && !view.route?.held && (k === 'SCHEDULED' || k === 'OUT_FOR_DEL')) {
    const w = view.when.window;
    const win = w && !w.estimateOnly && !w.otherDay ? ` between ${w.text.replace(' – ', ' and ')}` : '';
    out.push({ key: 'scheduled', label: 'Delivery day', text: `${lead} your delivery is scheduled for ${view.when.dayLabel}${win}. Reply here with any questions.` });
  }
  out.push({ key: 'delay', label: 'Running late', text: `${lead} we are running behind on your delivery. We will follow up with an updated time.` });
  out.push({ key: 'call-me', label: 'Please call', text: `${lead} please call us about your delivery when you have a moment.` });
  return out;
}
