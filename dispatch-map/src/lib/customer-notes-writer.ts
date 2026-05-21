// M2.1 — Auto-populate customer_notes from scanner results.
//
// Reads each stop's scan results, merges with the existing customer_notes doc
// (if any), and writes back via a Firestore batch. Respects the manual-override
// guard: if a dispatcher has set `manual_overrides.equipment_restrictions = true`,
// we never touch equipment_restrictions on that doc — but we still update the
// audit fields (auto_sources, auto_matches, auto_detected_at) so the UI can
// disclose what *would have* been detected.
//
// Source-locked flags (v0.3.0):
//   addressLine2     → no_tractor_trailer   (Davis-curated, trusted)
//   orderInstructions → uline_straight_truck (Uline-supplied, advisory)
//
// Migration: if a doc currently carries `no_tractor_trailer` but its only
// auto-detection source was `orderInstructions` (legacy v0.2.0 behavior where
// SPL-INSTR-TEXT mapped to no_tractor_trailer), we swap it to
// `uline_straight_truck`. Manual overrides are respected as always.
//
// Schema additions for M2.1:
//   manual_overrides: { equipment_restrictions: boolean }   // dispatcher acknowledged
//   auto_sources:     { [flag]: SignalSource[] }            // which sources detected each flag
//   auto_matches:     { [flag]: { source, text, pattern }[] } // exact text that matched
//   auto_detected_at: Timestamp                             // last auto-scan write
//   auto_detected_by: string                                // 'auto-scanner v0.3.0'

import { doc, writeBatch, serverTimestamp, deleteField, Firestore } from 'firebase/firestore';
import type { ScanResult, SignalSource, FlagValue } from './signal-scanner';

const MAX_BATCH = 450;       // Firestore caps at 500; leave headroom
const SCANNER_TAG = 'auto-scanner v0.3.0';

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
  detectedFlags: FlagValue[];
  removedLegacyFlags: FlagValue[];
  skippedDueToOverride: FlagValue[];
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

  // Merge new scan with the doc's previously persisted auto trail. Per-flag
  // sources accumulate across days; matches reflect only the latest scan.
  const existingSources = existing?.auto_sources || {};
  const sourcesByFlag: Record<string, SignalSource[]> = {};
  const matchesByFlag: Record<string, { source: SignalSource; text: string; pattern: string }[]> = {};
  const detectedFlagsThisScan = new Set<FlagValue>();

  for (const r of stop.scanResults) {
    detectedFlagsThisScan.add(r.flagValue);
    const sources = sourcesByFlag[r.flagValue] || (sourcesByFlag[r.flagValue] = [...(existingSources[r.flagValue] || [])]);
    if (!sources.includes(r.matchedSource)) sources.push(r.matchedSource);
    const matches = matchesByFlag[r.flagValue] || (matchesByFlag[r.flagValue] = []);
    matches.push({ source: r.matchedSource, text: r.matchedText, pattern: r.matchedPattern });
  }

  const overrideOnRestrictions = existing?.manual_overrides?.equipment_restrictions === true;

  // Compute the new equipment_restrictions explicitly so we can both add new
  // detections AND clean up legacy v0.2.0 writes where orderInstructions hits
  // were mis-tagged as no_tractor_trailer.
  const detectedFlags: FlagValue[] = [...detectedFlagsThisScan];
  const removedLegacyFlags: FlagValue[] = [];
  const skippedDueToOverride: FlagValue[] = [];

  // Migration: if no_tractor_trailer is on the doc but its only auto-source
  // (across history) was orderInstructions, that's a legacy v0.2.0 write —
  // swap it to uline_straight_truck. We only migrate values the scanner
  // touched (not human-set ones); the manual_overrides flag is the canonical
  // signal of human touch.
  const ntSources = (existing?.auto_sources?.no_tractor_trailer || []) as SignalSource[];
  const ntFromAddr2 = ntSources.includes('addressLine2') || detectedFlagsThisScan.has('no_tractor_trailer');
  const existingArr: string[] = Array.isArray(existing?.equipment_restrictions) ? existing!.equipment_restrictions! : [];
  const shouldMigrate =
    !overrideOnRestrictions &&
    existingArr.includes('no_tractor_trailer') &&
    !ntFromAddr2 &&
    ntSources.includes('orderInstructions');

  if (shouldMigrate) {
    // Carry the legacy audit trail forward under the new flag so the UI keeps
    // showing the matched text (just under uline_straight_truck now).
    const legacyMatches = existing?.auto_matches?.no_tractor_trailer || [];
    if (legacyMatches.length) {
      matchesByFlag.uline_straight_truck = [...(matchesByFlag.uline_straight_truck || []), ...legacyMatches];
    }
    sourcesByFlag.uline_straight_truck = [
      ...new Set([...(sourcesByFlag.uline_straight_truck || []), ...ntSources]),
    ];
  }

  const payload: Record<string, any> = {
    match_key: stop.matchKey,
    raw_name: stop.businessName || '',
    raw_address: [stop.addr1, stop.city, stop.state, stop.zip].filter(Boolean).join(', '),
    // Merge persisted auto trail so flags detected on earlier scans aren't lost.
    auto_sources: { ...existingSources, ...sourcesByFlag },
    auto_matches: matchesByFlag,
    auto_detected_at: serverTimestamp(),
    auto_detected_by: SCANNER_TAG,
  };
  if (shouldMigrate) {
    // Drop the stale audit entry for the migrated-away flag so the UI doesn't
    // keep listing it under its old name. Nested deleteField in a setDoc-merge
    // call removes just that sub-key, leaving the rest of the map intact.
    payload.auto_sources = { ...payload.auto_sources, no_tractor_trailer: deleteField() };
    payload.auto_matches = { ...payload.auto_matches, no_tractor_trailer: deleteField() };
  }

  if (overrideOnRestrictions) {
    // Dispatcher locked the field — only update the audit trail, never touch
    // the array itself.
    skippedDueToOverride.push(...detectedFlags);
  } else {
    const next = new Set<string>(existingArr);
    for (const f of detectedFlags) next.add(f);
    if (shouldMigrate) {
      next.delete('no_tractor_trailer');
      next.add('uline_straight_truck');
      removedLegacyFlags.push('no_tractor_trailer');
    }
    payload.equipment_restrictions = [...next];
  }

  // Append today's PRO to history (FIFO 20).
  if (stop.pro) {
    const arr = Array.isArray(existing?.pro_history) ? existing!.pro_history! : [];
    const today = todayYmd();
    const last = arr[arr.length - 1];
    if (!last || last.pro !== stop.pro || last.date !== today) {
      const next = [...arr, { pro: stop.pro, date: today }];
      payload.pro_history = next.slice(-20);
    }
  }

  return { matchKey: stop.matchKey, payload, detectedFlags, removedLegacyFlags, skippedDueToOverride };
}

export interface ApplyResult {
  attempted: number;
  written: number;
  overrideSkips: number;
  legacyMigrations: number;
  errors: { matchKey: string; message: string }[];
}

export async function applyScannerResults(
  db: Firestore,
  stops: ScannedStop[],
  existingNotes: Map<string, ExistingNote>,
): Promise<ApplyResult> {
  const result: ApplyResult = { attempted: 0, written: 0, overrideSkips: 0, legacyMigrations: 0, errors: [] };
  if (!db) return result;

  // Dedupe by match_key — two stops at the same customer merge into one write.
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
    if (d.skippedDueToOverride.length) result.overrideSkips++;
    if (d.removedLegacyFlags.length) result.legacyMigrations++;
  }

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
