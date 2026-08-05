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
/**
 * One frame's decode, resolved the way the WMS scanner does it — because that
 * one demonstrably works on the same phones and the same labels.
 *
 * ── WHY THIS CHANGED ────────────────────────────────────────────────────────
 *
 * This app used to require BOTH barcodes before it would record anything: a
 * Code 39 PRO and a Code 128 OG, paired inside a 1.5s window. The WMS needs
 * only the PRO, and it reads reliably. Demanding a pair while autofocus hunts
 * across a big label is a much harder problem, and on the dock it simply did
 * not complete — the driver got "point at a label" while pointing at one.
 *
 * So: A PRO ALONE IS A PIECE. The OG is an upgrade, not a requirement. When it
 * lands in the same frame it is used, and dedup is then exact per physical
 * piece. When it does not, the piece still counts.
 *
 * An OG with no PRO cannot identify a stop, so it is held briefly in case the
 * PRO arrives in the next frame.
 */
export function createScanResolver({ ogHoldMs = 1200 } = {}) {
  let heldOg = null;
  let heldAt = 0;

  return {
    /** Feed one frame. Returns {pro, og|null} when there is something to record. */
    push(rawValues, now = Date.now()) {
      const frame = pairFrame(rawValues);

      if (frame.pro) {
        const fresh = heldOg && now - heldAt <= ogHoldMs ? heldOg : null;
        const og = frame.og || fresh;
        heldOg = null;
        heldAt = 0;
        return { pro: frame.pro, og: og || null };
      }

      if (frame.og) {
        heldOg = frame.og;
        heldAt = now;
      }
      return null;
    },
    state(now = Date.now()) {
      return { pro: null, og: heldOg && now - heldAt <= ogHoldMs ? heldOg : null };
    },
    reset() {
      heldOg = null;
      heldAt = 0;
    },
  };
}

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
/**
 * Stops in the order they go ON the trailer — the reverse of delivery order.
 *
 * loadSeq 1 is the nose (loaded first, delivered last). Stops that share a
 * loadSeq are co-located: one address, several orders. They stay adjacent,
 * ordered by stop number so the screen is stable between refreshes.
 */
export function loadOrder(stops) {
  return (stops || []).slice().sort((a, b) => {
    const av = a.loadSeq == null ? Infinity : a.loadSeq;
    const bv = b.loadSeq == null ? Infinity : b.loadSeq;
    if (av !== bv) return av - bv;
    return String(a.stopNbr).localeCompare(String(b.stopNbr));
  });
}

/** Distinct trailer positions — the "of 13" in "Load 1 of 13". */
export function loadGroupCount(stops) {
  return new Set((stops || []).map((s) => s.loadSeq).filter((v) => v != null)).size;
}

/** Delivery-order sequence for a stop. Kept identical to the server's key. */
export function deliverySeq(s) {
  return s?.loadStopSeq ?? s?.routeSeq ?? null;
}

/**
 * Fingerprint of the sequence a load was built against — see the resequence
 * guard in App.jsx. Must match the server's sequenceFingerprint exactly.
 */
export function sequenceFingerprint(stops) {
  return (stops || [])
    .map((s) => `${s.stopNbr ?? ''}:${deliverySeq(s) ?? ''}`)
    .sort()
    .join('|');
}

export function stopProgress(stop, scans, handConfirms = []) {
  const pros = new Set(stop.pros || []);
  const ogs = new Set(
    (scans || []).filter((s) => pros.has(normalizePro(s.pro))).map((s) => String(s.og).toUpperCase()),
  );
  const expected = Number(stop.expectedPieces || 0);

  // A hand-confirm is per STOP and all-or-nothing: there is no piece barcode to
  // count, so the driver is asserting the whole stop is on the truck. It counts
  // toward the load but never pretends to be a scan — `handConfirmed` rides all
  // the way into the session record so completeness can tell them apart.
  const hand = (handConfirms || []).find((h) => String(h.stopNbr) === String(stop.stopNbr)) || null;
  const scannedPieces = ogs.size;
  const confirmedPieces = hand ? Math.max(0, expected - scannedPieces) : 0;
  const scanned = scannedPieces + confirmedPieces;

  return {
    stopNbr: stop.stopNbr,
    expected,
    scanned,
    scannedPieces,
    confirmedPieces,
    handConfirmed: !!hand,
    short: Math.max(0, expected - scanned),
    over: Math.max(0, scanned - expected),
    complete: expected > 0 && scanned === expected,
    ogs: [...ogs],
  };
}

export function loadProgress(stops, scans, handConfirms = []) {
  const per = (stops || []).map((s) => stopProgress(s, scans, handConfirms));
  const expected = per.reduce((n, p) => n + p.expected, 0);
  // Distinct OGs across the load, plus whatever the hand-confirms vouch for.
  const scannedPieces = new Set((scans || []).map((s) => String(s.og).toUpperCase())).size;
  const confirmedPieces = per.reduce((n, p) => n + p.confirmedPieces, 0);
  const scanned = scannedPieces + confirmedPieces;
  return {
    perStop: per,
    expected,
    scanned,
    scannedPieces,
    confirmedPieces,
    handConfirmedStops: per.filter((p) => p.handConfirmed).map((p) => p.stopNbr),
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


/**
 * The gate that decides whether a decode becomes a piece.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * On the dock a 2-skid stop recorded 3/2 — more pieces than the order contains,
 * which is not physically possible. The scanner was not at fault: it read the
 * label 64 times, correctly, in about a second.
 *
 * The fault was timing. `record` closed over React's `scans` array, and Quagga
 * delivers ~20 frames a second, so several calls ran before a re-render. Every
 * one of them saw the same stale array, concluded "nothing scanned for this PRO
 * yet", and booked a piece.
 *
 * State cannot fix that, because the whole problem is that state has not caught
 * up. This gate holds its own answer and updates it synchronously, so the second
 * frame of a burst sees what the first one did.
 *
 * `cooldownMs` covers the walk-away: a pallet stays in frame for a beat after
 * the decode lands, and the loader is still moving. Those frames are the same
 * piece.
 */
export function createScanGate({ cooldownMs = 3000 } = {}) {
  let lastPro = null;
  let lastAt = 0;

  return {
    /** True if this decode should become a piece. Records the decision. */
    allow(pro, now = Date.now()) {
      if (lastPro === pro && now - lastAt < cooldownMs) return false;
      lastPro = pro;
      lastAt = now;
      return true;
    },
    /** Let the next read of `pro` through immediately (after a deliberate tap). */
    clear() {
      lastPro = null;
      lastAt = 0;
    },
  };
}

/**
 * Loading order, with finished stops pushed to the bottom.
 *
 * The list is the loader's worklist. A completed stop still sitting at the top
 * pushes the NEXT one to load off the screen, which is the opposite of what the
 * list is for. Done work drops away; the order among unfinished stops, and among
 * finished ones, is otherwise untouched.
 */
export function sortForLoading(rows) {
  return [...rows].sort((a, b) => {
    const ad = a.progress.complete ? 1 : 0;
    const bd = b.progress.complete ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return (a.stop.loadSeq ?? 1e9) - (b.stop.loadSeq ?? 1e9);
  });
}
