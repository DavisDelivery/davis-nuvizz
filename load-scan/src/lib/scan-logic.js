// scan-logic.js — pure barcode classification, pairing, match and close-out math.
//
// No DOM, no camera, no network: every rule a driver depends on at 5am is a plain
// function here so it can be tested without a phone.
//
// ── THE LABEL ────────────────────────────────────────────────────────────────
// A Uline label carries TWO barcodes:
//   bottom, marked PRO   Code 39,  bare 7-digit PRO      e.g. 7152411
//   upper, under "N of M" Code 128, "OG" + 10 digits     e.g. OG6028479182
//
// The OG is unique per PHYSICAL PIECE — pieces 1/2/3 of PRO 7152411 are
// OG6028479182/183/184. NuVizz does not store it (palletID is empty on every
// product line), so nothing may depend on the vendor supplying piece IDs.
//
// The "2 of 3" piece index is printed as human-readable text ONLY. It is in
// neither barcode, so it cannot be used for completeness.

/** Match key: last 7 digits. Same rule as the WMS scanner and dispatch-map normalizePro. */
export function normalizePro(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits ? digits.slice(-7) : '';
}

/** A PRO barcode is Code 39, exactly 7 digits, all numeric. */
export function isProBarcode(raw) {
  return /^\d{7}$/.test(String(raw ?? '').trim());
}

/** A piece ID is Code 128: literal "OG" then exactly 10 digits. */
export function isOgBarcode(raw) {
  return /^OG\d{10}$/.test(String(raw ?? '').trim().toUpperCase());
}

export function classifyBarcode(raw) {
  const v = String(raw ?? '').trim();
  if (isProBarcode(v)) return { kind: 'pro', value: v };
  if (isOgBarcode(v)) return { kind: 'og', value: v.toUpperCase() };
  return { kind: 'unknown', value: v };
}

/**
 * Pair the barcodes seen in one camera frame into a complete piece scan.
 *
 * A frame yielding both a PRO and an OG is one piece. A frame with only one of
 * them is incomplete and returns null — the caller keeps the partial and waits,
 * rather than recording half a piece.
 */
export function pairFrame(rawValues) {
  let pro = null;
  let og = null;
  const unknown = [];
  for (const raw of rawValues || []) {
    const c = classifyBarcode(raw);
    if (c.kind === 'pro' && !pro) pro = c.value;
    else if (c.kind === 'og' && !og) og = c.value;
    else if (c.kind === 'unknown' && c.value) unknown.push(c.value);
  }
  return { pro, og, unknown, complete: !!(pro && og) };
}

/**
 * Accumulate frames until a PRO and an OG have both been seen.
 *
 * Even on a phone that can hold both barcodes in view, autofocus drops one of
 * them between frames constantly. `windowMs` bounds how long a lone half-scan
 * stays eligible for pairing, so a PRO from one label can never marry an OG from
 * the next.
 */
export function createPairBuffer({ windowMs = 2500 } = {}) {
  let pending = { pro: null, og: null, at: 0 };

  const expired = (now) => pending.at && now - pending.at > windowMs;

  return {
    /** Feed one frame's raw values. Returns a complete pair, or null. */
    push(rawValues, now = Date.now()) {
      const frame = pairFrame(rawValues);
      if (frame.complete) {
        pending = { pro: null, og: null, at: 0 };
        return { pro: frame.pro, og: frame.og };
      }
      if (expired(now)) pending = { pro: null, og: null, at: 0 };

      if (frame.pro) pending = { ...pending, pro: frame.pro, at: now };
      if (frame.og) pending = { ...pending, og: frame.og, at: now };

      if (pending.pro && pending.og) {
        const out = { pro: pending.pro, og: pending.og };
        pending = { pro: null, og: null, at: 0 };
        return out;
      }
      return null;
    },
    /** What is still half-captured — drives the "hold steady" hint. */
    state(now = Date.now()) {
      if (expired(now)) return { pro: null, og: null };
      return { pro: pending.pro, og: pending.og };
    },
    reset() {
      pending = { pro: null, og: null, at: 0 };
    },
  };
}

// ── Match outcomes ───────────────────────────────────────────────────────────
//
//   GREEN   PRO is on this load, OG is new, no appointment flag
//   AMBER   PRO is on this load but the stop needs an appointment. Never green.
//           Does not block loading.
//   RED     PRO is not on this load.
//   SILENT  this exact OG was already scanned in this session.

export const OUTCOME = { GREEN: 'green', AMBER: 'amber', RED: 'red', SILENT: 'silent' };

/**
 * @param pair          {pro, og}
 * @param manifestStops ManifestStop[] for the ACTIVE load
 * @param scannedOgs    Set of OGs already recorded this session
 * @param otherLoads    optional [{loadNbr, driverName, stops}] for naming a red PRO's owner
 */
export function evaluateScan(pair, manifestStops, scannedOgs, otherLoads = []) {
  const pro = normalizePro(pair?.pro);
  const og = String(pair?.og ?? '').toUpperCase();

  if (scannedOgs && scannedOgs.has(og)) {
    return { outcome: OUTCOME.SILENT, pro, og, stop: null };
  }

  const stop = (manifestStops || []).find((s) => (s.pros || []).includes(pro)) || null;

  if (!stop) {
    // Name the owning load when the index can tell us — "this belongs to Brad's
    // 197184" is actionable on a dock, "wrong load" is not.
    let owner = null;
    for (const l of otherLoads) {
      const hit = (l.stops || []).find((s) => (s.pros || []).includes(pro));
      if (hit) {
        owner = { loadNbr: l.loadNbr, driverName: l.driverName || null, businessName: hit.businessName || null };
        break;
      }
    }
    return { outcome: OUTCOME.RED, pro, og, stop: null, owner };
  }

  return {
    outcome: stop.appointmentRequired ? OUTCOME.AMBER : OUTCOME.GREEN,
    pro,
    og,
    stop,
    instructions: stop.appointmentRequired ? stop.instructions || '' : '',
  };
}

// ── Completeness ─────────────────────────────────────────────────────────────

/**
 * Per-stop progress.
 *
 * Completeness is DISTINCT OG COUNT against expectedPieces. Never gap detection:
 * the OG counter is global to the Uline facility, so a wave pick, split shipment
 * or label reprint breaks an otherwise contiguous run. A gap is a hint for a
 * human, never an input to this number.
 */
export function stopProgress(stop, scans) {
  const pros = new Set(stop.pros || []);
  const ogs = new Set(
    (scans || []).filter((s) => pros.has(normalizePro(s.pro))).map((s) => String(s.og).toUpperCase()),
  );
  const scanned = ogs.size;
  const expected = Number(stop.expectedPieces || 0);
  return {
    stopNbr: stop.stopNbr,
    expected,
    scanned,
    short: Math.max(0, expected - scanned),
    over: Math.max(0, scanned - expected),
    complete: expected > 0 && scanned === expected,
    ogs: [...ogs],
  };
}

export function loadProgress(stops, scans) {
  const per = (stops || []).map((s) => stopProgress(s, scans));
  const expected = per.reduce((n, p) => n + p.expected, 0);
  const scanned = new Set((scans || []).map((s) => String(s.og).toUpperCase())).size;
  return {
    perStop: per,
    expected,
    scanned,
    short: Math.max(0, expected - scanned),
    over: Math.max(0, scanned - expected),
    // A load may only close cleanly when every stop reconciles.
    clean: per.length > 0 && per.every((p) => p.complete),
    stopsWithGap: per.filter((p) => !p.complete),
  };
}

/**
 * Contiguity hint, UI ONLY.
 *
 * Surfaces "there is a numeric gap in this stop's OGs" so a driver can go look on
 * the dock. It is explicitly NOT wired into completeness — see stopProgress.
 */
export function ogGapHint(ogs) {
  const nums = (ogs || [])
    .map((o) => Number(String(o).replace(/^OG/i, '')))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (nums.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < nums.length; i++) {
    const delta = nums[i] - nums[i - 1];
    if (delta > 1 && delta <= 20) {
      for (let m = nums[i - 1] + 1; m < nums[i]; m++) gaps.push(`OG${String(m).padStart(10, '0')}`);
    }
  }
  return gaps.length ? gaps.slice(0, 10) : null;
}
