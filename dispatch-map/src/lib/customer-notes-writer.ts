// M2.1 — Auto-populate customer_notes from scanner results.
//
// Reads each stop's scan results, merges with the existing customer_notes doc
// (if any), and writes back via a Firestore batch. Respects the manual-override
// guard: if a dispatcher has set `manual_overrides.equipment_restrictions = true`,
// we never touch equipment_restrictions on that doc — but we still update the
// audit fields (auto_sources, auto_matches, auto_detected_at) so the UI can
// disclose what *would have* been detected.
//
// Schema additions for M2.1:
//   manual_overrides: { equipment_restrictions: boolean }   // dispatcher acknowledged
//   auto_sources:     { [flag]: SignalSource[] }            // which sources detected each flag
//   auto_matches:     { [flag]: { source, text, pattern }[] } // exact text that matched
//   auto_detected_at: Timestamp                             // last auto-scan write
//   auto_detected_by: string                                // 'auto-scanner v0.2.0'
//
// pro_history is also appended FIFO (max 20) so we keep visibility into which
// PRO triggered the most recent detection at this customer.

import { doc, writeBatch, arrayUnion, serverTimestamp, Firestore } from 'firebase/firestore';
import type { ScanResult, SignalSource } from './signal-scanner';

const MAX_BATCH = 450;       // Firestore caps at 500; leave headroom
const SCANNER_TAG = 'auto-scanner v0.2.0';

export interface ScannedStop {
  matchKey: string | null;
  pro: string | null;
  businessName: string | null;
  addr1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  scanResults: ScanResult[];
}

export interface ExistingNote {
  equipment_restrictions?: string[];
  manual_overrides?: { equipment_restrictions?: boolean };
  auto_sources?: Record<string, SignalSource[]>;
  auto_matches?: Record<string, { source: SignalSource; text: string; pattern: string }[]>;
  pro_history?: { pro: string; date: string }[];
}

interface WriteDecision {
  matchKey: string;
  payload: Record<string, any>;
  shouldMergeRestrictions: boolean;
  detectedFlags: string[];
  skippedDueToOverride: string[];
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

// Build the payload for one stop. Returns null if nothing to write.
// Visible for testing.
export function decideWrite(
  stop: ScannedStop,
  existing: ExistingNote | undefined,
): WriteDecision | null {
  if (!stop.matchKey || !stop.scanResults.length) return null;

  // Group results by flag → sources + matches.
  const sourcesByFlag: Record<string, SignalSource[]> = {};
  const matchesByFlag: Record<string, { source: SignalSource; text: string; pattern: string }[]> = {};
  const detectedFlags: string[] = [];

  for (const r of stop.scanResults) {
    if (!detectedFlags.includes(r.flagValue)) detectedFlags.push(r.flagValue);
    const sources = sourcesByFlag[r.flagValue] || (sourcesByFlag[r.flagValue] = []);
    if (!sources.includes(r.matchedSource)) sources.push(r.matchedSource);
    const matches = matchesByFlag[r.flagValue] || (matchesByFlag[r.flagValue] = []);
    matches.push({ source: r.matchedSource, text: r.matchedText, pattern: r.matchedPattern });
  }

  const overrideOnRestrictions = existing?.manual_overrides?.equipment_restrictions === true;

  // Audit fields are always written — disclosure should reflect what was detected
  // even when override is on, so the UI can show "would have detected X".
  const payload: Record<string, any> = {
    match_key: stop.matchKey,
    raw_name: stop.businessName || '',
    raw_address: [stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', '),
    auto_sources: sourcesByFlag,
    auto_matches: matchesByFlag,
    auto_detected_at: serverTimestamp(),
    auto_detected_by: SCANNER_TAG,
  };

  // Restriction merge — only when override is OFF.
  let shouldMergeRestrictions = false;
  const skippedDueToOverride: string[] = [];
  if (overrideOnRestrictions) {
    skippedDueToOverride.push(...detectedFlags);
  } else {
    // Use arrayUnion so we never clobber human-added restrictions (e.g.
    // 'liftgate_required' set by dispatcher stays put).
    payload.equipment_restrictions = arrayUnion(...detectedFlags);
    shouldMergeRestrictions = true;
  }

  // Append today's PRO to history (FIFO 20). arrayUnion would dedupe by exact
  // equality but the {pro,date} object means today's same PRO would re-append
  // forever, so we do this conditionally based on the existing tail.
  if (stop.pro) {
    const arr = Array.isArray(existing?.pro_history) ? existing!.pro_history! : [];
    const today = todayYmd();
    const last = arr[arr.length - 1];
    if (!last || last.pro !== stop.pro || last.date !== today) {
      const next = [...arr, { pro: stop.pro, date: today }];
      payload.pro_history = next.slice(-20);
    }
  }

  return { matchKey: stop.matchKey, payload, shouldMergeRestrictions, detectedFlags, skippedDueToOverride };
}

export interface ApplyResult {
  attempted: number;          // stops with detections
  written: number;            // docs actually written
  overrideSkips: number;      // docs where equipment_restrictions was respected as locked
  errors: { matchKey: string; message: string }[];
}

// Apply scanner results across many stops.
// `existingNotes` is the live Firestore snapshot Map<match_key, note>.
export async function applyScannerResults(
  db: Firestore,
  stops: ScannedStop[],
  existingNotes: Map<string, ExistingNote>,
): Promise<ApplyResult> {
  const result: ApplyResult = { attempted: 0, written: 0, overrideSkips: 0, errors: [] };
  if (!db) return result;

  // Dedupe by match_key — if two stops at the same customer both detect, we want
  // ONE write that merges both stops' sources. (Common — Uline reships to the same
  // consignee multiple times.)
  const merged = new Map<string, { stop: ScannedStop; results: ScanResult[] }>();
  for (const s of stops) {
    if (!s.matchKey || !s.scanResults.length) continue;
    const prev = merged.get(s.matchKey);
    if (prev) {
      prev.results.push(...s.scanResults);
    } else {
      merged.set(s.matchKey, { stop: s, results: [...s.scanResults] });
    }
  }
  result.attempted = merged.size;

  const decisions: WriteDecision[] = [];
  for (const { stop, results } of merged.values()) {
    const d = decideWrite({ ...stop, scanResults: results }, existingNotes.get(stop.matchKey));
    if (!d) continue;
    decisions.push(d);
    if (!d.shouldMergeRestrictions && d.skippedDueToOverride.length) result.overrideSkips++;
  }

  // Chunk into Firestore-safe batches.
  for (let i = 0; i < decisions.length; i += MAX_BATCH) {
    const slice = decisions.slice(i, i + MAX_BATCH);
    const batch = writeBatch(db);
    for (const d of slice) {
      batch.set(doc(db, 'customer_notes', d.matchKey), d.payload, { merge: true });
    }
    try {
      await batch.commit();
      result.written += slice.length;
    } catch (e: any) {
      for (const d of slice) result.errors.push({ matchKey: d.matchKey, message: e.message });
    }
  }

  return result;
}
