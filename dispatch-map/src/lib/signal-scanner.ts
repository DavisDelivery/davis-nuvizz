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

export interface ScanResult {
  flagValue: FlagValue;
  matchedSource: SignalSource;
  matchedText: string;
  matchedPattern: string;
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
