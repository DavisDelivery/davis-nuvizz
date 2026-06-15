// src/lib/parseStopComments.ts
//
// Pure parser: turns a NuVizz Stop "comments" blob into structured operational
// intelligence. NuVizz carries delivery instructions as free-text segments tagged
// `SPL-INSTR-TEXT:` (occasionally with a trailing `TOTAL-AMOUNT : NN.NN` billing tail),
// usually concatenated with `;`. Real examples seen in production:
//
//   "SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID; TOTAL-AMOUNT : 58.37"
//   "SPL-INSTR-TEXT: INSIDE DELIVERY"
//   "SPL-INSTR-TEXT: RECEIVING HOURS 7AM-12PM; SPL-INSTR-TEXT: CALL UPON APPROACH"
//   "SPL-INSTR-TEXT: Do Not Deliver Double Stacked; SPL-INSTR-TEXT: LIFT GATE"
//
// Design rules (enforced):
//  - Pure & side-effect-free so it unit-tests cleanly and runs in CI.
//  - Case-insensitive; tolerant of extra whitespace, missing/garbled values,
//    and any number of SPL-INSTR-TEXT segments.
//  - Four-layer preservation: the ORIGINAL raw string is always returned verbatim,
//    and every unrecognized segment is captured in `other[]` — nothing is ever dropped.
//  - receivingHours is SOFT/advisory ONLY. The orchestrator assumes a soft posture;
//    a single constant (RECEIVING_HOURS_HARD) gates any future hard-gating so it can
//    be flipped without hunting through call sites.

// Hard-gate switch for receiving hours. The orchestrator treats receiving hours as
// advisory (flag, don't block). Flip to `true` only if/when receiving windows should
// become a hard scheduling constraint. Nothing in this lib should branch on the window
// as a gate unless this is true.
export const RECEIVING_HOURS_HARD = false;

export interface ReceivingHours {
  /** 24h "HH:MM" start of the receiving window. */
  start: string;
  /** 24h "HH:MM" end of the receiving window. */
  end: string;
  /** Original substring the window was parsed from (preserved verbatim). */
  raw: string;
  /**
   * 'high'  — both ends had an explicit AM/PM or unambiguous 24h reading.
   * 'low'   — at least one end was inferred (bare hour, assumed business-hours AM/PM).
   */
  confidence: 'high' | 'low';
}

export interface ParsedStopComments {
  // --- boolean operational flags ---
  liftgate: boolean;
  insideDelivery: boolean;
  doNotBreakdownSkid: boolean;
  doNotDoubleStack: boolean;
  callUponApproach: boolean;
  gravelOrNewConstruction: boolean;

  // --- structured values ---
  /** Soft/advisory receiving window, or null when none was present. NEVER a hard gate. */
  receivingHours: ReceivingHours | null;
  /** Parsed TOTAL-AMOUNT (the stop's billed / Non-Uline amount), or null. */
  totalAmount: number | null;

  // --- preservation ---
  /** Every unrecognized SPL-INSTR-TEXT segment, captured verbatim. Never dropped. */
  other: string[];
  /** The original comment string, exactly as received (layer-1 preservation). */
  raw: string;

  /** True when at least one recognized flag/value/segment was found. */
  hasAny: boolean;
}

// ---------------------------------------------------------------------------
// Input coercion — accept a raw string, an array of strings, or an array of
// NuVizz Comment objects ({ commentDescription }). Returns a single normalized
// string with segments joined by ';' so downstream splitting is uniform.
// ---------------------------------------------------------------------------
type CommentLike = string | { commentDescription?: string | null } | null | undefined;

export function commentsToString(input: CommentLike | CommentLike[]): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input
      .map((c) => commentsToString(c as CommentLike))
      .filter((s) => s && s.trim().length > 0)
      .join('; ');
  }
  // NuVizz Comment object
  return (input.commentDescription || '').toString();
}

// ---------------------------------------------------------------------------
// Time parsing for receiving hours.
// Handles: "7AM-12PM", "7am - 12pm", "8-3", "07:00-15:00", "9 AM to 5 PM".
// Returns 24h "HH:MM" plus whether the reading was explicit.
// ---------------------------------------------------------------------------
interface TimeToken {
  hhmm: string;
  explicit: boolean; // had an explicit AM/PM or a colon'd 24h time
}

function parseTimeToken(token: string, assumeMeridiem: 'am' | 'pm' | null): TimeToken | null {
  const m = token.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (hour > 23 || minute > 59) return null;
  const mer = (m[3] || '').toLowerCase();
  let explicit = false;

  if (mer === 'pm' || mer === 'p') {
    if (hour < 12) hour += 12;
    explicit = true;
  } else if (mer === 'am' || mer === 'a') {
    if (hour === 12) hour = 0;
    explicit = true;
  } else if (m[2] && hour <= 23) {
    // Had a colon (e.g. "07:00", "15:00") — treat as explicit 24h.
    explicit = true;
  } else if (assumeMeridiem) {
    // Bare hour, inherit the meridiem implied by the other end of the range.
    if (assumeMeridiem === 'pm' && hour < 12) hour += 12;
    if (assumeMeridiem === 'am' && hour === 12) hour = 0;
  }
  // else: bare hour with no context — left as-is (low confidence, see caller).

  const hhmm = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  return { hhmm, explicit };
}

function meridiemOf(token: string): 'am' | 'pm' | null {
  const m = token.trim().match(/(am|pm|a|p)\s*$/i);
  if (!m) return null;
  const x = m[1].toLowerCase();
  return x.startsWith('p') ? 'pm' : 'am';
}

function parseReceivingHours(segment: string): ReceivingHours | null {
  // Strip the leading "RECEIVING HOURS" / "RECV" / "RCV" label, keep the time range.
  const cleaned = segment
    .replace(/receiving\s*hours?/i, '')
    .replace(/\brec(?:eiv(?:ing)?)?\b/i, '')
    .replace(/\brcv\b/i, '')
    .replace(/\bhours?\b/i, '')
    .trim();

  // Find a range "A - B" where separator is -, –, to, until, thru.
  const range = cleaned.match(
    /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?)\s*(?:-|–|—|to|until|thru|through)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?)/i
  );
  if (!range) return null;

  const startTok = range[1].trim();
  const endTok = range[2].trim();

  // Infer a meridiem for a bare end from the other end, and vice-versa.
  const startMer = meridiemOf(startTok);
  const endMer = meridiemOf(endTok);

  const start = parseTimeToken(startTok, endMer && !startMer ? endMer : null);
  const end = parseTimeToken(endTok, startMer && !endMer ? startMer : null);
  if (!start || !end) return null;

  // Heuristic for the very common bare "8-3" business window: if neither end had a
  // meridiem and the numbers look like a daytime dock window, read start as AM and
  // end as PM (8am-3pm). Low confidence — it's a guess.
  let startHHMM = start.hhmm;
  let endHHMM = end.hhmm;
  let confidence: 'high' | 'low' = start.explicit && end.explicit ? 'high' : 'low';

  // Only the bare-hour case (no meridiem AND no explicit colon'd 24h reading) needs the
  // daytime-window guess; explicit 24h times like "07:00-15:00" stay high confidence.
  if (!startMer && !endMer && !(start.explicit && end.explicit)) {
    const sH = parseInt(start.hhmm.slice(0, 2), 10);
    const eH = parseInt(end.hhmm.slice(0, 2), 10);
    // e.g. 8-3 => start 08:00, end would naively be 03:00 (< start). Bump end to PM.
    if (eH < sH && eH + 12 <= 23) {
      endHHMM = `${(eH + 12).toString().padStart(2, '0')}:${end.hhmm.slice(3)}`;
    }
    confidence = 'low';
  }

  return { start: startHHMM, end: endHHMM, raw: segment.trim(), confidence };
}

// ---------------------------------------------------------------------------
// Flag matchers — each is a tolerant regex over a single segment's text.
// ---------------------------------------------------------------------------
const FLAG_MATCHERS: Array<{ key: keyof Pick<ParsedStopComments,
  'liftgate' | 'insideDelivery' | 'doNotBreakdownSkid' | 'doNotDoubleStack' |
  'callUponApproach' | 'gravelOrNewConstruction'>; test: RegExp }> = [
  { key: 'liftgate', test: /lift\s*-?\s*gate/i },
  { key: 'insideDelivery', test: /inside\s+deliver/i },
  { key: 'doNotBreakdownSkid', test: /do\s*not\s*break\s*-?\s*down\s+(?:the\s+)?skid/i },
  { key: 'doNotDoubleStack', test: /(?:do\s*not|no|don'?t)\b[^;]*?double\s*-?\s*stack/i },
  { key: 'callUponApproach', test: /call\s+(?:upon|on|when|prior\s+to)\s+approach|call\s+upon\s+arrival|call\s+ahead/i },
  { key: 'gravelOrNewConstruction', test: /\bgravel\b|new\s+construction|unpaved|dirt\s+(?:lot|road)/i },
];

// A segment is "recognized" if it matched a flag, a receiving window, or a total amount.
// Everything else is preserved verbatim in other[].

export function parseStopComments(input: CommentLike | CommentLike[]): ParsedStopComments {
  const raw = commentsToString(input);

  const result: ParsedStopComments = {
    liftgate: false,
    insideDelivery: false,
    doNotBreakdownSkid: false,
    doNotDoubleStack: false,
    callUponApproach: false,
    gravelOrNewConstruction: false,
    receivingHours: null,
    totalAmount: null,
    other: [],
    raw,
    hasAny: false,
  };

  if (!raw || !raw.trim()) return result;

  // Split into segments. Segments are separated by ';'. The "SPL-INSTR-TEXT:" /
  // "TOTAL-AMOUNT:" labels are stripped per-segment. We split on ';' first, then
  // peel labels, so a "...; TOTAL-AMOUNT : 58.37" tail is its own segment.
  const segments = raw
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const segRaw of segments) {
    // Peel a leading label (SPL-INSTR-TEXT, TOTAL-AMOUNT, etc.) but remember if it
    // was the amount label.
    const amountMatch = segRaw.match(/total\s*-?\s*amount\s*:?\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (amountMatch) {
      const val = parseFloat(amountMatch[1]);
      if (!Number.isNaN(val)) {
        result.totalAmount = val;
        result.hasAny = true;
      }
      // A pure TOTAL-AMOUNT segment carries no instruction text; don't preserve as "other".
      const residue = segRaw
        .replace(/spl-?instr-?text\s*:?/i, '')
        .replace(/total\s*-?\s*amount\s*:?\s*\$?\s*[0-9]+(?:\.[0-9]+)?/i, '')
        .trim();
      if (!residue) continue;
    }

    // Strip the instruction label to get the human text.
    const text = segRaw.replace(/spl-?instr-?text\s*:?/i, '').trim();
    if (!text) continue;

    let recognized = false;

    // Receiving hours (soft/advisory).
    if (/recv|receiv|\brcv\b|hours/i.test(text)) {
      const rh = parseReceivingHours(text);
      if (rh) {
        // Keep the first/widest window if multiple appear; first wins.
        if (!result.receivingHours) result.receivingHours = rh;
        recognized = true;
        result.hasAny = true;
      }
    }

    // Boolean flags.
    for (const { key, test } of FLAG_MATCHERS) {
      if (test.test(text)) {
        result[key] = true;
        recognized = true;
        result.hasAny = true;
      }
    }

    // Anything we didn't recognize is preserved verbatim — never dropped.
    if (!recognized) {
      result.other.push(text);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Appointment-reality helper.
// NuVizz often carries placeholder windows that are NOT real appointments:
//   - both ends 00:00
//   - 00:00 - 23:59 (or 00:00 - 24:00) all-day sentinel
// Never render these as a real appointment window.
// ---------------------------------------------------------------------------
export function isPlaceholderWindow(
  from: string | null | undefined,
  to: string | null | undefined
): boolean {
  const norm = (t: string | null | undefined): string | null => {
    if (!t) return null;
    const m = t.toString().trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return `${m[1].padStart(2, '0')}:${m[2]}`;
  };
  const f = norm(from);
  const t = norm(to);
  if (!f && !t) return true; // no window at all → treat as "no appt"
  if (f === '00:00' && (t === '00:00' || t === null)) return true;
  if (f === '00:00' && (t === '23:59' || t === '24:00')) return true;
  if (f === t) return true; // zero-width window
  return false;
}

// Format a 24h "HH:MM" as a compact human window piece, e.g. "7:00a".
export function fmt12h(hhmm: string): string {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hhmm;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const mer = h >= 12 ? 'p' : 'a';
  h = h % 12;
  if (h === 0) h = 12;
  return min === '00' ? `${h}:00${mer}` : `${h}:${min}${mer}`;
}

// Convenience: render a ReceivingHours as "Recv 7:00a-12:00p".
export function fmtReceivingHours(rh: ReceivingHours | null): string {
  if (!rh) return '';
  return `Recv ${fmt12h(rh.start)}-${fmt12h(rh.end)}`;
}

// ---------------------------------------------------------------------------
// Chip catalog — the UI renders these from the parsed flags. Centralized here so
// the legend, filters, and rows all agree on labels/colors.
// ---------------------------------------------------------------------------
export const STOP_CHIPS: Array<{
  key: keyof ParsedStopComments;
  label: string;
  /** Muted text/background color (Tailwind-independent hex). */
  color: string;
}> = [
  { key: 'liftgate', label: 'LIFTGATE', color: '#7c3aed' },
  { key: 'insideDelivery', label: 'INSIDE', color: '#0891b2' },
  { key: 'doNotBreakdownSkid', label: 'NO-BREAKDOWN', color: '#b45309' },
  { key: 'doNotDoubleStack', label: 'NO-DBL-STACK', color: '#be123c' },
  { key: 'callUponApproach', label: 'CALL', color: '#2563eb' },
  { key: 'gravelOrNewConstruction', label: 'GRAVEL', color: '#65a30d' },
];

// Pull the active chip descriptors for a parsed result (in catalog order).
export function activeChips(parsed: ParsedStopComments) {
  return STOP_CHIPS.filter((c) => parsed[c.key] === true);
}
