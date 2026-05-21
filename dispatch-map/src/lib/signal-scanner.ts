// M2.1 — Pattern scanner for NuVizz stop signals.
//
// Walks two signal sources on each stop and returns every flag/source/text hit.
// Used by the auto-scanner that passively populates customer_notes.
//
// To extend: add a new entry under PATTERNS or a new pattern array. Each entry's
// flag key must match an EQUIPMENT_OPTIONS value in App.jsx (or whatever target
// field you map it into).

export type SignalSource = 'addressLine2' | 'orderInstructions';

export interface ScanResult {
  flagValue: string;
  matchedSource: SignalSource;
  matchedText: string;
  matchedPattern: string;
}

// Hardcoded for v1. Refactor to Firestore config when the rule set grows past
// what a code review can comfortably scan.
const PATTERNS: Record<string, RegExp[]> = {
  no_tractor_trailer: [
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
  ],
};

interface ScannableStop {
  signalSources?: {
    addressLine2?: string | null;
    orderInstructions?: string | null;
  };
  // Back-compat: older callers may still pass top-level addr2.
  addr2?: string | null;
}

function scanText(text: string | null | undefined, source: SignalSource): ScanResult[] {
  if (!text) return [];
  const hits: ScanResult[] = [];
  for (const [flagValue, patterns] of Object.entries(PATTERNS)) {
    for (const pattern of patterns) {
      const m = pattern.exec(text);
      if (m) {
        hits.push({
          flagValue,
          matchedSource: source,
          matchedText: m[0],
          matchedPattern: pattern.source,
        });
        break; // one hit per flag per source
      }
    }
  }
  return hits;
}

export function scanStop(stop: ScannableStop): ScanResult[] {
  const ss = stop.signalSources || {};
  const addressLine2 = ss.addressLine2 ?? stop.addr2 ?? null;
  const orderInstructions = ss.orderInstructions ?? null;
  return [
    ...scanText(addressLine2, 'addressLine2'),
    ...scanText(orderInstructions, 'orderInstructions'),
  ];
}

// Convenience: tally hits across many stops, grouped by flag.
// Caller-friendly summary for HANDOFF/diagnostics screens.
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
