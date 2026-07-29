// manifest.mts — the ONE place NuVizz's freight field names are translated.
//
// ── FIELD SEMANTICS: NuVizz mislabels every freight count ────────────────────
//
//   NuVizz field    stop index key   what it ACTUALLY is
//   totalPallets    pallets          TOTAL PIECES   -> expectedPieces
//   totalCartons    cartons          SKIDS          -> skids
//   volume          volume           LOOSE PIECES   -> loose
//
// Source of truth for that mapping is dispatch-map/src/App.jsx:
//   "NuVizz mislabels freight: cartons = real skids, volume = loose pieces,
//    pallets (totalPallets) = total pieces."
//
// Translate here, once, at this boundary. The strings "cartons" and "pallets"
// must not appear downstream of this function — a piece-counting app that leaks
// NuVizz's naming will eventually count skids and call them pieces.
//
// ── THE UI TRAP — READ THIS BEFORE "FIXING" A COUNT MISMATCH ────────────────
//
// dispatch-map computes `totalPalletsCount` by summing `s.cartons` and renders it
// on screen labelled "total pallets". That number is SKIDS. load-scan's
// expectedPieces comes from `pallets`, which is PIECES. The two numbers are
// SUPPOSED to differ, often by a lot.
//
// If someone compares the dock scanner's expected count against the dispatch-map
// header and "corrects" load-scan to match, they will have broken piece-level
// verification while making the screens agree. Do not do it. Fix the label on the
// dispatch-map side if the mismatch is confusing, never the count on this side.

export interface ManifestStop {
  stopNbr: string;
  loadNbr: string;
  routeName: string | null;
  routeSeq: number | null;
  loadStopSeq: number | null;
  businessName: string;
  city: string;
  state: string;
  addr1: string;
  pros: string[];
  primaryPro: string | null;
  proCount: number;
  expectedPieces: number;
  skids: number;
  loose: number;
  weight: number;
  normalizedStatus: string | null;
  appointmentRequired: boolean;
  instructions: string;
  /** Four-layer preservation: the untouched index row, nothing dropped. */
  raw: any;
}

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const str = (v: any): string => String(v ?? '').trim();

/**
 * Appointment detection.
 *
 * The index has no boolean for this, so it is derived from the instruction text
 * the dispatcher and Uline both write into the stop. Kept deliberately narrow:
 * a false negative shows a stop green that needed a call, a false positive cries
 * wolf on every stop and gets ignored — which is worse. Only explicit appointment
 * language counts.
 */
const APPOINTMENT_RE = /\b(appt|appointment|must call|call ahead|call for appt|scheduled delivery|delivery appointment|by appointment)\b/i;

export function instructionText(raw: any): string {
  const parts = [raw?.instruction, raw?.instructions, raw?.notes, raw?.orderInstructions, raw?.comments]
    .map((v) => (Array.isArray(v) ? v.join(' | ') : str(v)))
    .filter(Boolean);
  return [...new Set(parts)].join(' | ');
}

export function isAppointmentRequired(raw: any): boolean {
  if (raw?.appointmentRequired === true) return true;
  return APPOINTMENT_RE.test(instructionText(raw));
}

/** PRO list, normalized and de-duplicated, tolerant of the several shapes the index uses. */
export function prosFor(raw: any): string[] {
  const list: any[] = Array.isArray(raw?.pros) ? raw.pros : [];
  const all = [...list, raw?.primaryPro, raw?.stopNbr]
    .map((p) => normalizePro(p))
    .filter(Boolean) as string[];
  return [...new Set(all)];
}

/** Match key: last 7 digits. Same rule as the WMS scanner and dispatch-map normalizePro. */
export function normalizePro(v: any): string {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits ? digits.slice(-7) : '';
}

/**
 * Shape one index row into a manifest stop, translating field semantics.
 *
 * `warn` collects the skids + loose !== expectedPieces mismatches. Per the brief
 * we log and serve expectedPieces anyway — the driver still needs to load the
 * truck, and a refused manifest at 5am is worse than a logged inconsistency.
 */
export function toManifestStop(raw: any, warn?: (msg: string) => void): ManifestStop {
  const expectedPieces = num(raw?.pallets);
  const skids = num(raw?.cartons);
  const loose = num(raw?.volume);
  const pros = prosFor(raw);

  if (warn && expectedPieces > 0 && skids + loose !== expectedPieces) {
    warn(
      `piece-count mismatch PRO ${pros[0] || raw?.stopNbr || '?'}: skids ${skids} + loose ${loose} = ${skids + loose}, expectedPieces ${expectedPieces} — serving expectedPieces`,
    );
  }

  return {
    stopNbr: str(raw?.stopNbr),
    loadNbr: str(raw?.loadNbr),
    routeName: str(raw?.routeName) || null,
    routeSeq: raw?.routeSeq == null ? null : num(raw.routeSeq),
    loadStopSeq: raw?.loadStopSeq == null ? null : num(raw.loadStopSeq),
    businessName: str(raw?.businessName),
    city: str(raw?.city),
    state: str(raw?.state),
    addr1: str(raw?.addr1 ?? raw?.address1 ?? raw?.address),
    pros,
    primaryPro: normalizePro(raw?.primaryPro) || pros[0] || null,
    proCount: num(raw?.proCount) || pros.length,
    expectedPieces,
    skids,
    loose,
    weight: num(raw?.weight),
    normalizedStatus: str(raw?.normalizedStatus) || null,
    appointmentRequired: isAppointmentRequired(raw),
    instructions: instructionText(raw),
    raw,
  };
}

/** Group manifest stops into loads, summing expected pieces per load. */
export function groupIntoLoads(stops: ManifestStop[]): Array<{
  loadNbr: string;
  routeName: string | null;
  stopCount: number;
  expectedPieces: number;
  stops: ManifestStop[];
}> {
  const byLoad = new Map<string, ManifestStop[]>();
  for (const s of stops) {
    const k = s.loadNbr || '(unassigned)';
    if (!byLoad.has(k)) byLoad.set(k, []);
    byLoad.get(k)!.push(s);
  }
  return [...byLoad.entries()]
    .map(([loadNbr, list]) => ({
      loadNbr,
      routeName: list[0]?.routeName ?? null,
      stopCount: list.length,
      expectedPieces: list.reduce((sum, s) => sum + s.expectedPieces, 0),
      stops: list.slice().sort((a, b) => (a.loadStopSeq ?? a.routeSeq ?? 0) - (b.loadStopSeq ?? b.routeSeq ?? 0)),
    }))
    .sort((a, b) => a.loadNbr.localeCompare(b.loadNbr));
}
