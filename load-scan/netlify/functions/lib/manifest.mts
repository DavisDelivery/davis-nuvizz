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
  /**
   * Position in LOADING order: 1 = first onto the trailer = nose = the LAST
   * stop delivered. The exact reverse of delivery order. Null when the stop
   * carries no sequence at all. See assignLoadSeq.
   */
  loadSeq: number | null;
  businessName: string;
  city: string;
  state: string;
  addr1: string;
  /** Cached alongside addr1 — a loader reading a label wants the whole address. */
  zip: string;
  /** Who to ask for at the dock, when the cache has it. */
  contactName: string;
  phone: string;
  /** The seal on the trailer for this stop, when NuVizz recorded one. */
  sealNbr: string;
  /** The delivery window, so an early or late load is obvious on the card. */
  plannedFrom: string;
  plannedTo: string;
  pros: string[];
  primaryPro: string | null;
  proCount: number;
  expectedPieces: number;
  /**
   * True when the index row carried NO piece total and expectedPieces was
   * computed as skids + loose. Means "computed here", NOT "uncertain": the
   * identity totalPallets = totalCartons + volume held on every one of the 328
   * live stops that carried a value (337 stops, 20 drivers, Aug 4 2026). The
   * rows that send no total are Averitt orders on the Inbound Integration feed.
   */
  countIsEstimated: boolean;
  /**
   * Can the app actually read a barcode off this freight? See stopIsScannable.
   * False means the driver has to hand-confirm the stop, because there is no
   * label the scanner can parse.
   */
  scannable: boolean;
  skids: number;
  loose: number;
  weight: number;
  normalizedStatus: string | null;
  appointmentRequired: boolean;
  /**
   * A PICKUP, not a delivery.
   *
   * NuVizz marks these stopType 'PU'. They are on the route because the driver
   * collects freight there — nothing about them is loaded at the dock. They
   * appeared in the loading list anyway, so the first thing on Alfred Morgan's
   * truck was a job nobody could do, and any pieces they carried counted toward
   * a total the loader could never reach.
   */
  isPickup: boolean;
  instructions: string;
  /** Four-layer preservation: the untouched index row, nothing dropped. */
  raw: any;
}

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Distinguishes "no value sent" from an explicit zero — num() collapses both. */
const numOrNull = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

/**
 * Can this stop's freight be scanned at all?
 *
 * ── WHY A STOP MIGHT NOT BE SCANNABLE ───────────────────────────────────────
 *
 * The scanner reads a Uline label: a bare 7-digit PRO (Code 39) plus an
 * OG+10-digit piece ID (Code 128). Averitt freight does not carry one. A real
 * Averitt pallet label, photographed on the dock Aug 2026, carries three
 * barcodes and NONE of them fit:
 *
 *   PRO#:      0259185096   10 bare digits — not 7, so not a PRO to isProBarcode
 *   SHIPMENT#: 5010437803   10 bare digits
 *   HU:        1076461290   10 bare digits, the per-pallet handling-unit ID
 *
 * There is no OG barcode, so pairFrame can never complete a piece, and every
 * one of those values classifies as 'unknown' and is silently dropped. The
 * load then sits short and will not close — worse than the bug it replaced,
 * because it blocks the driver.
 *
 * Worth noting for anyone tempted to "just widen the PRO regex": the three
 * barcodes are indistinguishable by format — all bare 10-digit numbers. Accept
 * 7-10 digits and scanning the SHIPMENT# yields PRO 0437803, which matches no
 * stop and shows the driver a RED "wrong freight" on freight that is correct.
 * A false red at 5am is worse than no scan. Making Averitt properly scannable
 * needs to know what those barcodes actually encode (symbology and any
 * prefix), which takes a physical scan of one label — not a photograph.
 *
 * ── THE TRIGGER ─────────────────────────────────────────────────────────────
 *
 * `scannable: false` on the index row is authoritative when present, so this
 * can be corrected without a deploy.
 *
 * Otherwise it derives from countIsEstimated — the stop sent no piece total.
 * Measured Aug 4 2026 over 337 stops on 20 drivers: exactly 9 sent no total,
 * and every one was an Averitt order on the Inbound Integration feed. So on
 * live data the two sets coincide.
 *
 * That is a correlation, not a law, and it is the weak point here: if a Uline
 * stop ever arrives with no piece total it would wrongly offer hand-confirm.
 * The cost is bounded — hand-confirm is deliberate, two-step, and recorded
 * distinctly from a scan, so a wrong offer is visible in the session record
 * rather than silent. Set `scannable` on the index row to end the guesswork.
 */
export function stopIsScannable(raw: any, countIsEstimated: boolean): boolean {
  if (raw?.scannable === false) return false;
  if (raw?.scannable === true) return true;
  return !countIsEstimated;
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
  const skids = num(raw?.cartons);
  const loose = num(raw?.volume);
  // A stop with no piece total is NOT an empty stop. Averitt orders on the
  // Inbound Integration feed send no totalPallets at all; treating that as 0
  // made those stops complete-at-zero and let a load close with freight still
  // on the dock. The total is exactly skids + loose everywhere NuVizz does send
  // it (328/328 stops carrying a value, Aug 4 2026), so compute it from the
  // parts and say so.
  const reported = numOrNull(raw?.pallets);
  const expectedPieces = reported === null ? skids + loose : reported;
  const countIsEstimated = reported === null;
  const pros = prosFor(raw);

  if (warn && !countIsEstimated && expectedPieces > 0 && skids + loose !== expectedPieces) {
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
    // Stamped by assignLoadSeq once the stop is grouped into its load — a
    // trailer position only means anything relative to the rest of the load.
    loadSeq: null,
    businessName: str(raw?.businessName),
    city: str(raw?.city),
    state: str(raw?.state),
    addr1: str(raw?.addr1 ?? raw?.address1 ?? raw?.address),
    // All already in the cached stop doc — they cost NOTHING extra to carry,
    // they were simply never asked for. See the mask in load-manifest.mts.
    zip: str(raw?.zip ?? raw?.postalCode),
    contactName: str(raw?.contactName),
    phone: str(raw?.phone),
    sealNbr: str(raw?.sealNbr),
    plannedFrom: str(raw?.plannedFrom),
    plannedTo: str(raw?.plannedTo),
    pros,
    primaryPro: normalizePro(raw?.primaryPro) || pros[0] || null,
    proCount: num(raw?.proCount) || pros.length,
    expectedPieces,
    countIsEstimated,
    scannable: stopIsScannable(raw, countIsEstimated),
    skids,
    loose,
    weight: num(raw?.weight),
    normalizedStatus: str(raw?.normalizedStatus) || null,
    appointmentRequired: isAppointmentRequired(raw),
    // 'type' is what dispatch-map's normalizer writes; 'stopType' is what the
    // raw vendor row carries. Accept either, because the index has held both
    // shapes and a missed pickup is worse than a redundant check.
    isPickup:
      String(raw?.type ?? '').toUpperCase() === 'PU' ||
      String(raw?.stopType ?? '').toUpperCase() === 'PU' ||
      String(raw?.stopType ?? '').toLowerCase() === 'pickup',
    instructions: instructionText(raw),
    raw,
  };
}

/**
 * The day's loads as PICK-LIST ROWS — no stops attached.
 *
 * This is what a forklift operator chooses from: they load somebody else's
 * truck, so they need to see every truck on the dock, but a phone must never
 * receive all ~600 stops. Summaries are a few hundred bytes; picking one then
 * goes through the existing ?loadNbr= path for that load's stops alone.
 *
 * driverName rides along because "whose truck is this" is how a dock talks
 * about a load — the load number alone is not how anyone identifies a trailer.
 */
export function loadSummaries(stops: ManifestStop[], roster?: any[]): Array<{
  loadNbr: string;
  routeName: string | null;
  driverName: string | null;
  stopCount: number;
  expectedPieces: number;
}> {
  return groupIntoLoads(stops, roster).map((l) => ({
    loadNbr: l.loadNbr,
    routeName: l.routeName,
    driverName: str(l.stops[0]?.raw?.driverName) || str(l.stops[0]?.raw?.driverUserName) || null,
    stopCount: l.stopCount,
    expectedPieces: l.expectedPieces,
  }));
}

/**
 * The sequence that decides DELIVERY order — the key the existing sort uses.
 *
 * Measured Aug 4 2026: `loadStopSeq` is never populated on live loads, so this
 * is `routeSeq` in practice, running 1..N with no nulls. Keeping the fallback
 * means loadSeq stays the exact inverse of delivery order even if NuVizz ever
 * starts sending loadStopSeq — the two orders can never drift apart.
 */
export function deliverySeq(s: { loadStopSeq?: number | null; routeSeq?: number | null }): number | null {
  return s?.loadStopSeq ?? s?.routeSeq ?? null;
}

/**
 * Stamp each stop with its LOADING position — the reverse of delivery order.
 *
 * A trailer is unloaded from the doors forward, so the last stop delivered has
 * to go on first, at the nose. loadSeq 1 is that stop.
 *
 * ── CO-LOCATED STOPS ────────────────────────────────────────────────────────
 *
 * Several orders can share one address, and they arrive as separate stops
 * sharing a routeSeq. Measured Aug 4 2026: BEN 1 has one shared pair, DENIS
 * SALKIC has 17 stops across 15 sequence numbers. They come off the trailer at
 * one place, so they go on at one place: stops sharing a delivery seq get the
 * SAME loadSeq and must never be split apart on the screen.
 *
 * So loadSeq ranks DISTINCT sequence values, not stops — a 17-stop load over 15
 * sequences has loadSeq 1..15, not 1..17.
 *
 * This only ADDS a field. The array itself stays in delivery order, because
 * every other consumer of the manifest reads it that way.
 */
export function assignLoadSeq<T extends { loadStopSeq?: number | null; routeSeq?: number | null }>(
  stops: T[],
): Array<T & { loadSeq: number | null }> {
  const distinct = [...new Set((stops || []).map(deliverySeq).filter((n): n is number => n != null))].sort(
    (a, b) => a - b,
  );
  // Reverse rank: the highest delivery seq (last stop delivered) becomes 1.
  const rank = new Map(distinct.map((seq, i) => [seq, distinct.length - i]));
  return (stops || []).map((s) => {
    const d = deliverySeq(s);
    return { ...s, loadSeq: d == null ? null : (rank.get(d) ?? null) };
  });
}

/** How many distinct trailer positions a load has — the "of 13" in "Load 1 of 13". */
export function loadGroupCount(stops: Array<{ loadSeq?: number | null }>): number {
  return new Set((stops || []).map((s) => s.loadSeq).filter((v) => v != null)).size;
}

/**
 * A fingerprint of the sequence a load was built against.
 *
 * If dispatch resequences the route after the truck is loaded, the freight on
 * the trailer is physically wrong and nothing else would notice. Comparing this
 * against the stored one turns a silent renumbering into a visible alarm.
 */
export function sequenceFingerprint(stops: Array<{ stopNbr?: string; loadStopSeq?: number | null; routeSeq?: number | null }>): string {
  return (stops || [])
    .map((s) => `${s.stopNbr ?? ''}:${deliverySeq(s) ?? ''}`)
    .sort()
    .join('|');
}

/** Group manifest stops into loads, summing expected pieces per load. */
export function groupIntoLoads(stops: ManifestStop[], roster?: any[]): Array<{
  loadNbr: string;
  routeName: string | null;
  /**
   * The genuine per-day identity, joined from the roster. Null when the roster
   * is cold or the route name is ambiguous — never guessed. `loadNbr` above
   * stays the ROUTE NAME so every existing consumer is unchanged; these are an
   * addition, not a rename.
   */
  loadId: string | null;
  loadNbrReal: string | null;
  loadIdAmbiguous: boolean;
  stopCount: number;
  loadGroupCount: number;
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
    .map(([loadNbr, list]) => {
      // Delivery order, exactly as before — every other consumer reads this
      // array that way. loadSeq is stamped on as a field, never a re-sort.
      const inDeliveryOrder = assignLoadSeq(
        list.slice().sort((a, b) => (deliverySeq(a) ?? 0) - (deliverySeq(b) ?? 0)),
      ) as ManifestStop[];
      const ident = resolveLoadIdentity(roster || [], loadNbr);
      return {
        loadNbr,
        routeName: list[0]?.routeName ?? null,
        loadId: ident.loadId,
        loadNbrReal: ident.loadNbr,
        loadIdAmbiguous: ident.ambiguous,
        stopCount: list.length,
        loadGroupCount: loadGroupCount(inDeliveryOrder),
        expectedPieces: list.reduce((sum, s) => sum + s.expectedPieces, 0),
        stops: inDeliveryOrder,
      };
    })
    .sort((a, b) => a.loadNbr.localeCompare(b.loadNbr));
}

/**
 * The genuine load identity for a route name, from the day's roster.
 *
 * A stop's `loadNbr` is the ROUTE NAME (nuvizz-list.mts:268 overwrites it), so
 * "STEVEN" is not a load — it is the same truck's name every day he works. The
 * roster carries what the stop does not: a per-day `loadNbr` (DAVIS000201463)
 * and the `loadId` NuVizz itself accepts for writes.
 *
 * REFUSES TO GUESS. Two loads in one day can share a route name — a cancelled
 * STEVEN load once put a red badge on the live one — so a name appearing more
 * than once resolves to nothing. Silently attaching a scan to the wrong truck is
 * worse than not resolving, and the caller can fall back to name + date, which
 * is exactly as good as what it had before.
 */
export function resolveLoadIdentity(roster: any[], routeName: string): {
  loadId: string | null;
  loadNbr: string | null;
  ambiguous: boolean;
} {
  const want = String(routeName ?? '').trim().toUpperCase();
  if (!want) return { loadId: null, loadNbr: null, ambiguous: false };

  const hits = (roster || []).filter((l) => String(l?.name ?? '').trim().toUpperCase() === want);
  if (hits.length !== 1) {
    // 0 = not on this day's roster; >1 = two trucks share the name today.
    return { loadId: null, loadNbr: null, ambiguous: hits.length > 1 };
  }
  return {
    loadId: String(hits[0]?.loadId ?? '') || null,
    loadNbr: String(hits[0]?.loadNbr ?? '') || null,
    ambiguous: false,
  };
}
