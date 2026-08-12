// M2.1 — Pattern scanner for NuVizz stop signals.
//
// Walks two signal sources on each stop and returns every flag/source/text hit.
// Source-locked: each source maps to its own flag, because the two sources have
// different confidence levels:
//
//   addressLine2     — Davis dispatchers curate this manually; treat as gospel.
//                      Hits produce `no_tractor_trailer` (red marker).
//   orderInstructions — Uline sends SPL-INSTR-TEXT on every order; sometimes
//                      wrong/over-broad. Treat as advisory only.
//                      Hits produce `uline_straight_truck` (amber marker).
//
// Why source-locked rather than text-locked: the same phrase "STRAIGHT TRUCK
// ONLY" can appear in either source, but the *trust level* is determined by
// who wrote it, not what they wrote. Keeping the source as the trust signal
// means the markers / filters / notes stay honest.

export type SignalSource = 'addressLine2' | 'orderInstructions';
export type FlagValue = 'no_tractor_trailer' | 'uline_straight_truck';
export type DayCode = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface ScanResult {
  flagValue: FlagValue;
  matchedSource: SignalSource;
  matchedText: string;
  matchedPattern: string;
}

// M4.4 — Separate from equipment-restriction ScanResult because the writer
// applies these to different fields (receiving_hours, closed_days). Same
// source-locked trust model: addressLine2 is curated, orderInstructions is
// advisory; the writer respects the matching manual_overrides flags.
export interface HoursScanResult {
  open: string;  // "HH:MM" 24-hour — '' when only a close is known ("UNTIL 2PM")
  close: string; // "HH:MM" 24-hour — '' when only an open is known ("OPENS AT 11AM")
  matchedSource: SignalSource;
  matchedText: string;
  // Day-qualified schedules (corpus sweep, Aug 2026): "MON-THURS 6 30-4 / FRI 8-12"
  // carries DIFFERENT windows per weekday — the one-range-fills-seven model cannot say
  // "Friday closes at noon", which is exactly the day that bites. When present, the
  // writer fills ONLY these days; `open`/`close` above hold the most common window as
  // a back-compat summary. Absent for plain single-range detections.
  byDay?: Partial<Record<DayCode, { open: string; close: string }>>;
}

export interface ClosedDayScanResult {
  day: DayCode;
  matchedSource: SignalSource;
  matchedText: string;
}

export interface FullScanResult {
  restrictions: ScanResult[];
  hours: HoursScanResult | null;
  closedDays: ClosedDayScanResult[];
}

// Hardcoded for v1. Refactor to Firestore config when the rule set grows past
// what a code review can comfortably scan.
const ADDR2_PATTERNS: RegExp[] = [
  // Phrasings dispatchers actually type into addr2. We accept Uline-style
  // phrasing here too (Davis sometimes copies it) — the source itself is what
  // confers Davis-trusted status, not the wording.
  /\bNO\s*TT\b/i,
  /\bNO\s+TRACTOR\s+TRL?\b/i,
  /\bNO\s+TRACTOR\s+TRAILER\b/i,
  /\bSTRAIGHT\s+TRUCK\s+ONLY\b/i,
  /\bST\s+ONLY\b/i,
  /\bSTRAIGHT\s+ONLY\b/i,
  /\bBOX\s+TRUCK\s+ONLY\b/i,
  /\b26\s*['']\s*MAX\b/i,
  /\b26\s*FT\s*MAX\b/i,
  /\bSMALL\s+TRUCK\s+ONLY\b/i,
  /\bNO\s+53\s*['']?\b/i,
  /\bNO\s+53\s*FT\b/i,
];

const ORDER_INSTR_PATTERNS: RegExp[] = [
  // What Uline puts in SPL-INSTR-TEXT.
  /\bSTRAIGHT\s+TRUCK\s+ONLY\b/i,
  /\bSTRAIGHT\s+TRUCK\b/i,
  /\bBOX\s+TRUCK\s+ONLY\b/i,
  /\b26\s*FT\s*MAX\b/i,
  /\b26\s*['']\s*MAX\b/i,
  /\bSMALL\s+TRUCK\s+ONLY\b/i,
  /\bNO\s+TRACTOR\s+TRAILER\b/i,
  /\bNO\s+TRACTOR\s+TRL?\b/i,
  /\bNO\s+53\s*['']?\b/i,
  /\bNO\s+53\s*FT\b/i,
];

const SOURCE_RULES: { source: SignalSource; flagValue: FlagValue; patterns: RegExp[] }[] = [
  { source: 'addressLine2',      flagValue: 'no_tractor_trailer',  patterns: ADDR2_PATTERNS },
  { source: 'orderInstructions', flagValue: 'uline_straight_truck', patterns: ORDER_INSTR_PATTERNS },
];

interface ScannableStop {
  signalSources?: {
    addressLine2?: string | null;
    orderInstructions?: string | null;
  };
  // Back-compat: older callers may still pass top-level addr2.
  addr2?: string | null;
}

function firstHit(text: string | null | undefined, patterns: RegExp[]): { text: string; pattern: string } | null {
  if (!text) return null;
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return { text: m[0], pattern: p.source };
  }
  return null;
}

export function scanStop(stop: ScannableStop): ScanResult[] {
  const ss = stop.signalSources || {};
  const sourceTexts: Record<SignalSource, string | null | undefined> = {
    addressLine2: ss.addressLine2 ?? stop.addr2 ?? null,
    orderInstructions: ss.orderInstructions ?? null,
  };
  const out: ScanResult[] = [];
  for (const rule of SOURCE_RULES) {
    const hit = firstHit(sourceTexts[rule.source], rule.patterns);
    if (hit) {
      out.push({
        flagValue: rule.flagValue,
        matchedSource: rule.source,
        matchedText: hit.text,
        matchedPattern: hit.pattern,
      });
    }
  }
  return out;
}

// ---------- M4.4: receiving hours + closed-day pattern matchers ----------

// Match either "6AM-2PM" / "8-4" / "6:30 AM to 2:30 PM" style ranges. The
// outer wrappers (`HOURS:`, `OPEN`, `RECEIVING:`, `RH` (Uline shorthand for
// Receiving Hours, e.g. "RH 7-11AM"), `DELIVER BETWEEN`, `DELIVER BY`) precede
// the actual time range; we capture both pieces in separate regexes so the
// wrapper is just a gate and the inner time parser can be reused. matchedText
// returns the full wrapper+range slice so the audit trail shows what triggered
// detection.
// One time token — every shape the Firestore corpus actually holds (Aug 2026 sweep):
// "7", "7:30", "7 30" (space as the colon — Chad's 08-11 EOD manifest), "7.30",
// meridiem as AM/PM or the single letter A/P ("8A-1P", "4 30P"), or the word NOON.
// Minutes are locked to two digits 00-59 so "7 3-1" can't half-match.
const TIME_TOKEN = '(?:NOON\\b|[0-9]{1,2}(?:[:. ]?[0-5][0-9])?\\s*(?:AM|PM|A|P)?\\b\\.?)';
const TIME_RANGE = `${TIME_TOKEN}\\s*(?:-|TO|—)\\s*${TIME_TOKEN}`;
// The receiving-hours label vocabulary, as actually written: RECEIVING HOURS,
// REC HRS, RCVG HRS, RCV HRS, HOURS, HRS, RH.
const HOURS_LABEL = '(?:(?:RECEIVING|RCVNG|RCVG|RCV|REC)\\s*)?(?:HOURS?|HRS?)|RECEIVING|RH';
const HOURS_WRAPPERS: RegExp[] = [
  // Label + range. The label and the range often arrive as SEPARATE SPL-INSTR-TEXT
  // comments that join with a newline — \s bridges it.
  new RegExp(`\\b(?:${HOURS_LABEL})\\s*[:\\-]?\\s*(${TIME_RANGE})`, 'i'),
  new RegExp(`\\bOPEN(?:\\s+FROM)?\\s*[:\\-]?\\s*(${TIME_RANGE})`, 'i'),
  new RegExp(`\\bDELIVER(?:Y)?\\s+BETWEEN\\s+(${TIME_TOKEN}\\s*(?:-|TO|AND|—)\\s*${TIME_TOKEN})`, 'i'),
  // A range labelled as a jobsite delivery window ("$80.00 8AM-11AM Jobsite Delivery").
  new RegExp(`(${TIME_RANGE})\\s+JOBSITE\\b`, 'i'),
];
// Close-only forms → {open: 06:00 default, close}: "DELIVER BY 2PM", "DEL BY NOON",
// "RCVG HRS UNTIL 2PM ONLY", "CLOSE AT 3PM", "HAS TO BE PICKED UP BEFORE 3PM".
const CLOSE_ONLY_WRAPPERS: RegExp[] = [
  new RegExp(`\\bDEL(?:IVER(?:Y|ED)?)?\\s+(?:BY|BEFORE|UNTIL)\\s+(${TIME_TOKEN})`, 'i'),
  new RegExp(`\\b(?:${HOURS_LABEL})\\s*(?:UNTIL|TIL|BY)\\s+(${TIME_TOKEN})`, 'i'),
  new RegExp(`\\bCLOSE[SD]?\\s+(?:AT|@)\\s*(${TIME_TOKEN})`, 'i'),
  new RegExp(`\\bPICK(?:ED)?\\s*UP\\s+(?:BY|BEFORE)\\s+(${TIME_TOKEN})`, 'i'),
  // "$69.99 *11:00 AM GUARANTEE LAMAR ...*" — a paid delivery deadline (month study, x16).
  new RegExp(`(${TIME_TOKEN})\\s*GUARANTEE\\b`, 'i'),
];
// Open-only forms → {open, close: ''}: "OPENS AT 11AM", "RECEIVING AFTER 10AM",
// "NO DELIVERIES BEFORE 8AM". A missing close arms nothing downstream (the hours-risk
// check needs a close), but the window shows on the customer card instead of vanishing.
const OPEN_ONLY_WRAPPERS: RegExp[] = [
  new RegExp(`\\bOPENS?\\s+(?:AT|@)\\s*(${TIME_TOKEN})`, 'i'),
  new RegExp(`\\b(?:RECEIVING|RCVNG|RCVG|RCV|DELIVER(?:Y|IES)?)\\s+AFTER\\s+(${TIME_TOKEN})`, 'i'),
  new RegExp(`\\bNO\\s+DELIVER(?:Y|IES)?\\s+BEFORE\\s+(${TIME_TOKEN})`, 'i'),
];

// ── Day-qualified schedules ──────────────────────────────────────────────────
// "MON-THURS 6 30-4 / FRI 8-12", "M-TH ONLY 9-4PM", "MONDAY-THURS 6 30A-3 30P /
// FRIDAY 6 30A-11A", and the label-on-its-own-line form ("FRIDAY" then
// "7 00 AM - 12 00 PM" in the next comment). Also day-qualified closes:
// "FRIDAYS CLOSE AT NOON", "CLOSED FRI AT 12PM", "DEL BY NOON ON FRIDAYS".
const DAY_WORD: Record<string, DayCode> = {
  M: 'mon', MON: 'mon', MONDAY: 'mon',
  TU: 'tue', TUE: 'tue', TUES: 'tue', TUESDAY: 'tue',
  W: 'wed', WED: 'wed', WEDNESDAY: 'wed',
  TH: 'thu', THU: 'thu', THUR: 'thu', THURS: 'thu', THURSDAY: 'thu',
  F: 'fri', FRI: 'fri', FRIDAY: 'fri',
  SA: 'sat', SAT: 'sat', SATURDAY: 'sat',
  SU: 'sun', SUN: 'sun', SUNDAY: 'sun',
};
const DAY_ORDER: DayCode[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
// Multi-letter tokens can stand alone ("FRI 8-12"); single letters only inside a
// span ("M-TH") where the dash disambiguates them from ordinary prose.
const DAY_TOKEN_MULTI = '(?:MONDAY|MON|TUESDAY|TUES|TUE|WEDNESDAY|WED|THURSDAY|THURS|THUR|THU|FRIDAY|FRI|SATURDAY|SAT|SUNDAY|SUN)';
const DAY_TOKEN_ANY = `(?:${DAY_TOKEN_MULTI}|M|TU|W|TH|F|SA|SU)`;
const DAY_SPAN = `(?:${DAY_TOKEN_ANY}\\s*-\\s*${DAY_TOKEN_ANY}|${DAY_TOKEN_MULTI})S?`;
function expandDaySpan(spanText: string): DayCode[] {
  const t = spanText.trim().toUpperCase().replace(/S$/, '');
  const m = t.split(/\s*-\s*/);
  const a = DAY_WORD[m[0]?.replace(/S$/, '') ?? ''];
  if (!a) return [];
  if (m.length === 1) return [a];
  const b = DAY_WORD[m[1]?.replace(/S$/, '') ?? ''];
  if (!b) return [a];
  const ai = DAY_ORDER.indexOf(a), bi = DAY_ORDER.indexOf(b);
  return ai <= bi ? DAY_ORDER.slice(ai, bi + 1) : [a];
}

// Parse a captured range like "6AM-2PM" or "8-4" or "6:30 AM to 2:30 PM" into
// {open, close} 24-hour strings. Returns null if the range can't be parsed
// confidently — callers persist the raw matched text under auto_sources so
// dispatchers can review.
function parseTimeRange(rangeText: string): { open: string; close: string } | null {
  const cleaned = rangeText.replace(/[—–]/g, '-').replace(/\s+TO\s+/i, '-').replace(/\s+AND\s+/i, '-').trim();
  const parts = cleaned.split('-').map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const open = parseTimePiece(parts[0], parts[1]);
  let close = parseTimePiece(parts[1], parts[0]);
  if (!open || !close) return null;
  // Business-hours correction — the same rules board-flags applies to legacy range
  // strings. A close at or before the open with NO written meridiem is afternoon
  // ("8-3" means 8a-3p, "7 30-1" means 7:30a-1p) — peer inference alone left these
  // as 03:00/01:00, a dawn close that would flag nearly every real arrival. A close
  // that is EXPLICITLY earlier ("9PM-5AM", an overnight dock) is not a daytime
  // window and is refused rather than silently flipped 12 hours.
  const toMin = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3), 10);
  if (toMin(close) <= toMin(open)) {
    // NOON counts as explicit — it names 12:00 outright.
    const closeHadMeridiem = /(?:(A|P)M?\.?|NOON)\s*$/i.test(parts[1]);
    if (closeHadMeridiem || toMin(close) >= 720) return null;
    close = `${String(parseInt(close.slice(0, 2), 10) + 12).padStart(2, '0')}:${close.slice(3)}`;
  }
  return { open, close };
}

// Parse one half of a range. The other half (peer) is used to infer AM/PM
// when the first half omits a meridiem: e.g. "8-4" → 8AM-4PM (close is PM
// because business hours straddle noon ~95% of the time and 4-hour evening
// receiving windows are vanishingly rare).
function parseTimePiece(piece: string, peer: string): string | null {
  if (/^NOON\.?$/i.test(piece.trim())) return '12:00';
  // Separator can be ":", "." or a space — Uline's "7 30-1" writes 7:30 with a space.
  // Meridiem can be the single letter: "8A", "4 30P" (corpus: "RECEIVING HOURS 8A-1P").
  const m = /^([0-9]{1,2})(?:[:. ]?([0-5][0-9]))?\s*(AM|PM|A|P)?\.?$/i.exec(piece);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  let meridiem = m[3] ? (m[3][0].toUpperCase() + 'M') : null;
  if (hour < 0 || hour > 24) return null;
  if (minute < 0 || minute > 59) return null;
  if (!meridiem) {
    // Peer-based inference. If peer has a meridiem, use the opposite for the
    // earlier hour and same for the later hour. If neither has one, assume
    // morning-open + afternoon-close.
    const peerM = /(A|P)M?\.?\s*$/i.exec(peer);
    const peerMeridiem = peerM ? (peerM[1].toUpperCase() + 'M') : (/NOON\.?\s*$/i.test(peer) ? 'PM' : null);
    // Anchored so compact times backtrack correctly: the peer hour of "430PM" is 4, not 43.
    // NaN when the peer carries no digits — the close-only callers pass a bare 'PM'/'AM'
    // HINT as the peer ("CLOSES AT 4" has no other half to infer from).
    const peerHour = /NOON/i.test(peer) ? 12
      : parseInt(/^([0-9]{1,2})(?:[:. ]?[0-5][0-9])?\s*(?:AM|PM|A|P)?\.?$/i.exec(peer.trim())?.[1] ?? 'x', 10);
    if (peerMeridiem === 'PM' && !Number.isFinite(peerHour)) {
      // Digit-less PM hint (close-only forms). Daytime docks: "CLOSES AT 4" / "3 30" is
      // afternoon; 12 is noon; a bare 8-11 is ambiguous (8:00a produce dock vs 8:00p
      // retail) and is REFUSED rather than guessed. The month-of-data study caught the
      // regression this branch fixes: v0.54.60's peer rule read "CLOSES AT 4" as 04:00,
      // a dawn close that would have amber-flagged every arrival all day.
      if (hour === 12 || hour <= 7) meridiem = 'PM';
      else return null;
    } else if (peerMeridiem === 'PM') {
      // Bare half against a PM peer. Business windows straddle noon: "9-4PM" opens 9 AM,
      // "2-4PM" runs same-afternoon, "8-12P" ends at noon with a morning open, and a bare
      // 12 is always noon. (The old "mirror if lower" rule read "9-4PM" as 9 PM and the
      // range refused itself.)
      meridiem = hour === 12 ? 'PM' : (peerHour !== 12 && hour < peerHour) ? 'PM' : 'AM';
    } else if (peerMeridiem === 'AM') {
      meridiem = 'AM'; // a bare half next to an AM peer is morning; the afternoon-shift rescues "8AM-4"
    } else {
      meridiem = hour < 12 ? 'AM' : 'PM';
    }
  }
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// NuVizz joins each comment as its own "SPL-INSTR-TEXT: ..." line, so a label
// and its time range often land on adjacent lines ("SPL-INSTR-TEXT: RECEIVING
// HOURS" then "SPL-INSTR-TEXT: 8AM-12PM"). Strip those prefixes so the wrapper
// regexes see "RECEIVING HOURS 8AM-12PM" contiguously.
function stripCommentPrefixes(text: string): string {
  return text.replace(/SPL-INSTR-TEXT\s*:?\s*/gi, ' ').replace(/[ \t]+/g, ' ');
}

function scanHours(text: string | null | undefined, source: SignalSource): HoursScanResult | null {
  if (!text) return null;
  const normalized = stripCommentPrefixes(text);

  // 1 — Day-qualified segments (most specific evidence wins). Both shapes: day span +
  // range ("MON-THURS 6 30-4", "FRIDAY ⏎ 7 00 AM - 12 00 PM") and day-qualified closes
  // ("FRIDAYS CLOSE AT NOON", "CLOSED FRI AT 12PM", "DEL BY NOON ON FRIDAYS").
  const byDay: Partial<Record<DayCode, { open: string; close: string }>> = {};
  const matchedBits: string[] = [];
  const daySegRe = new RegExp(`\\b(${DAY_SPAN})\\s*(?:ONLY)?\\s*[:\\-]?\\s*(${TIME_RANGE})`, 'gi');
  for (let m = daySegRe.exec(normalized); m; m = daySegRe.exec(normalized)) {
    const days = expandDaySpan(m[1]);
    const parsed = parseTimeRange(m[2]);
    if (!days.length || !parsed) continue;
    for (const d of days) byDay[d] = { open: parsed.open, close: parsed.close };
    matchedBits.push(m[0]);
  }
  const dayCloseRes: RegExp[] = [
    new RegExp(`\\b(${DAY_SPAN})\\s+CLOSES?\\s+(?:AT|@)\\s*(${TIME_TOKEN})`, 'gi'),
    new RegExp(`\\bCLOSE[SD]?\\s+(?:ON\\s+)?(${DAY_SPAN})\\s+(?:AT|@)\\s*(${TIME_TOKEN})`, 'gi'),
  ];
  for (const re of dayCloseRes) {
    for (let m = re.exec(normalized); m; m = re.exec(normalized)) {
      const days = expandDaySpan(m[1]);
      const close = parseTimePiece(m[2].trim(), 'PM');
      if (!days.length || !close) continue;
      for (const d of days) byDay[d] = { open: byDay[d]?.open || '', close };
      matchedBits.push(m[0]);
    }
  }
  const delByOnRe = new RegExp(`\\bDEL(?:IVER(?:Y)?)?\\s+BY\\s+(${TIME_TOKEN})\\s+(?:ON\\s+)?(${DAY_SPAN})`, 'gi');
  for (let m = delByOnRe.exec(normalized); m; m = delByOnRe.exec(normalized)) {
    const days = expandDaySpan(m[2]);
    const close = parseTimePiece(m[1].trim(), 'PM');
    if (!days.length || !close) continue;
    for (const d of days) byDay[d] = { open: byDay[d]?.open || '', close };
    matchedBits.push(m[0]);
  }

  // 2 — Generic (day-less) range via the label wrappers.
  let generic: { open: string; close: string; matchedText: string } | null = null;
  for (const w of HOURS_WRAPPERS) {
    const m = w.exec(normalized);
    if (!m) continue;
    // A day-qualified segment already claimed this exact slice — don't double-read
    // "FRI 8-12" as a generic all-week window through the bare-range wrappers.
    if (matchedBits.some((b) => b.includes(m[1]))) continue;
    const parsed = parseTimeRange(m[1]);
    if (parsed) { generic = { ...parsed, matchedText: m[0] }; break; }
  }

  // 3 — Assemble. Day-qualified evidence produces byDay (generic fills the week first
  // when both exist); a lone generic range keeps the legacy single-window shape.
  const dayKeys = Object.keys(byDay) as DayCode[];
  if (dayKeys.length) {
    if (generic) {
      for (const d of DAY_ORDER) if (!byDay[d]) byDay[d] = { open: generic.open, close: generic.close };
      matchedBits.unshift(generic.matchedText);
    }
    // Summary open/close for back-compat consumers: the most common window among the days.
    const counts = new Map<string, { n: number; w: { open: string; close: string } }>();
    for (const d of dayKeys) {
      const w = byDay[d]!;
      const k = `${w.open}|${w.close}`;
      counts.set(k, { n: (counts.get(k)?.n || 0) + 1, w });
    }
    const top = [...counts.values()].sort((a, b) => b.n - a.n)[0].w;
    return { open: top.open, close: top.close, byDay, matchedSource: source, matchedText: matchedBits.join(' · ') };
  }
  if (generic) return { open: generic.open, close: generic.close, matchedSource: source, matchedText: generic.matchedText };

  // 4 — One-sided forms. Close-only keeps the legacy 06:00 default open ("DELIVER BY
  // 2PM" behavior); open-only stores the open with no close (informs the card, arms
  // nothing — the hours-risk check needs a close).
  for (const re of CLOSE_ONLY_WRAPPERS) {
    const m = re.exec(normalized);
    if (!m) continue;
    const close = parseTimePiece(m[1].trim(), 'PM');
    if (close) return { open: '06:00', close, matchedSource: source, matchedText: m[0] };
  }
  for (const re of OPEN_ONLY_WRAPPERS) {
    const m = re.exec(normalized);
    if (!m) continue;
    const open = parseTimePiece(m[1].trim(), 'AM');
    if (open) return { open, close: '', matchedSource: source, matchedText: m[0] };
  }

  // 5 — BARE number pairs, last resort (Chad, Aug 2026: "we should learn the bare number
  // pairs because ... most businesses we deliver to are normal day time hours as we don't
  // run through the night"). A pair with no hours label counts ONLY when everything about
  // it says daytime receiving window:
  //   • the resolved window is daytime: opens 5:00a-12:00p, closes by 7:00p — Davis never
  //     runs nights, so anything else is not a window we could be being told about;
  //   • it is at least 3 hours wide — every labeled window in the corpus is; the 1-hour
  //     pairs are LUNCH CLOSURES ("CLOSED 1-2 FOR LUNCH"), the exact opposite of hours;
  //   • it is not preceded by a refusing context (CLOSED / NO DELIVERIES / BTWN) and not
  //     followed by FOR LUNCH or a MIN/MINS qualifier ("CALL 30-1 MIN AHEAD");
  //   • it is not digit-adjacent (phone numbers, PO numbers, weights already fail the
  //     token/hour rules, and this keeps it that way).
  const bareRe = new RegExp(`(^|[^0-9-])(${TIME_RANGE})(?!\\s*-)`, 'gi');
  for (let m = bareRe.exec(normalized); m; m = bareRe.exec(normalized)) {
    const before = normalized.slice(Math.max(0, m.index - 28), m.index + m[1].length);
    if (/(CLOSED|NO\s+DELIVER\w*|BTWN|BETWEEN|LUNCH)\s*$/i.test(before)) continue;
    const after = normalized.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (/^\s*(FOR\s+LUNCH|MINS?\b|MINUTES?\b)/i.test(after)) continue;
    const parsed = parseTimeRange(m[2]);
    if (!parsed || !parsed.open || !parsed.close) continue;
    const toMin = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3), 10);
    const o = toMin(parsed.open), c = toMin(parsed.close);
    if (o < 300 || o > 720) continue;      // opens 5:00a-12:00p
    if (c > 19 * 60) continue;             // closes by 7:00p
    // Width floor: 3 hours for fully bare pairs; 90 minutes when a meridiem is WRITTEN
    // ("8-10am Delivery" is self-evidently a window — month study, x18 — while the
    // 1-hour lunch pairs never carry one).
    const hasMeridiem = /(A|P)M?\.?\s*(?:-|TO|—)|(A|P)M?\.?\s*$/i.test(m[2]) || /NOON/i.test(m[2]);
    if (c - o < (hasMeridiem ? 90 : 180)) continue;
    return { open: parsed.open, close: parsed.close, matchedSource: source, matchedText: m[2] };
  }
  return null;
}

// Closed-day patterns. Per brief: every day, in case Uline ever sends
// "CLOSED SUNDAY" etc. The map between matched text and day code is encoded
// in the pattern entry so callers don't need to interpret the regex.
// Each pattern allows an optional "ON" ("CLOSED ON FRIDAY") and an optional
// trailing "S" plural ("CLOSED ON FRIDAYS" — the exact Uline instruction format),
// in addition to the bare "CLOSED FRIDAY" / "NO FRIDAY" / "FRIDAY CLOSED" forms.
const CLOSED_DAY_PATTERNS: { day: DayCode; patterns: RegExp[] }[] = [
  { day: 'mon', patterns: [/\bCLOSED\s+(?:ON\s+)?MON(?:DAY)?S?\b/i, /\bNO\s+MONDAYS?\b/i, /\bMONDAYS?\s+CLOSED\b/i, /\bNO\s+DELIVER(?:Y|IES)?\s+(?:ON\s+)?MONDAYS?\b/i] },
  { day: 'tue', patterns: [/\bCLOSED\s+(?:ON\s+)?TUE(?:S|SDAY)?S?\b/i, /\bNO\s+TUESDAYS?\b/i, /\bTUESDAYS?\s+CLOSED\b/i, /\bNO\s+DELIVER(?:Y|IES)?\s+(?:ON\s+)?TUESDAYS?\b/i] },
  { day: 'wed', patterns: [/\bCLOSED\s+(?:ON\s+)?WED(?:NESDAY)?S?\b/i, /\bNO\s+WEDNESDAYS?\b/i, /\bWEDNESDAYS?\s+CLOSED\b/i, /\bNO\s+DELIVER(?:Y|IES)?\s+(?:ON\s+)?WEDNESDAYS?\b/i] },
  { day: 'thu', patterns: [/\bCLOSED\s+(?:ON\s+)?THU(?:RS|RSDAY)?S?\b/i, /\bNO\s+THURSDAYS?\b/i, /\bTHURSDAYS?\s+CLOSED\b/i, /\bNO\s+DELIVER(?:Y|IES)?\s+(?:ON\s+)?THURSDAYS?\b/i] },
  { day: 'fri', patterns: [/\bCLOSED\s+(?:ON\s+)?FRI(?:DAY)?S?\b/i, /\bNO\s+FRIDAYS?\b/i, /\bNOT\s+OPEN\s+FRIDAYS?\b/i, /\bFRIDAYS?\s+CLOSED\b/i, /\bNO\s+DELIVER(?:Y|IES)?\s+(?:ON\s+)?FRIDAYS?\b/i] },
  { day: 'sat', patterns: [/\bCLOSED\s+(?:ON\s+)?SAT(?:URDAY)?S?\b/i, /\bNO\s+SATURDAYS?\b/i, /\bSATURDAYS?\s+CLOSED\b/i, /\bNO\s+DELIVER(?:Y|IES)?\s+(?:ON\s+)?SATURDAYS?\b/i] },
  { day: 'sun', patterns: [/\bCLOSED\s+(?:ON\s+)?SUN(?:DAY)?S?\b/i, /\bNO\s+SUNDAYS?\b/i, /\bSUNDAYS?\s+CLOSED\b/i, /\bNO\s+DELIVER(?:Y|IES)?\s+(?:ON\s+)?SUNDAYS?\b/i] },
];

function scanClosedDays(text: string | null | undefined, source: SignalSource): ClosedDayScanResult[] {
  if (!text) return [];
  const out: ClosedDayScanResult[] = [];
  for (const entry of CLOSED_DAY_PATTERNS) {
    for (const p of entry.patterns) {
      const m = p.exec(text);
      if (m) {
        // "CLOSED FRI AT 12PM" is an EARLY CLOSE, not a closed day — the customer is open
        // Friday morning. The day-qualified hours scanner owns that form; marking the day
        // closed here would tell dispatch to skip a morning that is actually deliverable.
        const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 16);
        if (/^\s+AT\s+(?:NOON|[0-9])/i.test(tail)) continue;
        out.push({ day: entry.day, matchedSource: source, matchedText: m[0] });
        break; // one hit per day is enough
      }
    }
  }
  return out;
}

// Run all detectors against a stop. Equipment restrictions remain source-locked
// (red/amber). Hours + closed days check both sources and dedupe by source
// preference (addressLine2 wins over orderInstructions when both fire).
export function scanStopFull(stop: ScannableStop): FullScanResult {
  const ss = stop.signalSources || {};
  const addr2Text = ss.addressLine2 ?? stop.addr2 ?? null;
  const orderText = ss.orderInstructions ?? null;

  const restrictions = scanStop(stop);

  // Hours: prefer addr2 (curated) over orderInstructions (advisory).
  const hours = scanHours(addr2Text, 'addressLine2') ?? scanHours(orderText, 'orderInstructions');

  // Closed days: union across both sources, addr2 wins on conflict (same day).
  const closedFromAddr2 = scanClosedDays(addr2Text, 'addressLine2');
  const closedFromOrder = scanClosedDays(orderText, 'orderInstructions');
  const seenDays = new Set<DayCode>();
  const closedDays: ClosedDayScanResult[] = [];
  for (const r of [...closedFromAddr2, ...closedFromOrder]) {
    if (seenDays.has(r.day)) continue;
    seenDays.add(r.day);
    closedDays.push(r);
  }

  return { restrictions, hours, closedDays };
}

// Convenience: tally hits across many stops, grouped by flag.
export function summarizeHits(allHits: ScanResult[][]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const stopHits of allHits) {
    const seen = new Set<string>();
    for (const h of stopHits) {
      if (seen.has(h.flagValue)) continue;
      seen.add(h.flagValue);
      counts[h.flagValue] = (counts[h.flagValue] || 0) + 1;
    }
  }
  return counts;
}
