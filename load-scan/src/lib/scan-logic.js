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

// The camera used to have its own resolver here (createScanResolver) that
// returned a PRO the INSTANT it decoded, with og:null when no OG was in hand.
// That rule — a PRO alone is a piece, the way the WMS scans — is correct and is
// kept. Booking it on the FIRST PRO FRAME was not. Quagga is deliberately
// multiple:false, so on an iPhone the two barcodes of one label always arrive
// on separate frames; whenever the PRO decoded a beat before the piece id, the
// phantom booked, the green flash ended the aim, and the OG that landed anyway
// booked as a SECOND piece. DASAN USA read 3/3 off two scans; GEM SHOPPING
// credited 10 of 11. The camera now drives createPairBuffer below, exactly like
// the gun: both barcodes marry in either order inside the window, and a PRO
// alone becomes a piece when the window closes — not before.

export function createPairBuffer({ windowMs = 2500, onAbandon } = {}) {
  let pending = { pro: null, og: null, at: 0 };

  const expired = (now) => pending.at && now - pending.at > windowMs;

  /**
   * Drop the half-label being held, and SAY SO.
   *
   * This used to happen silently, which is how a whole load went wrong without
   * anyone noticing: the lone survivor was quietly dropped or quietly
   * overwritten, and the only clue was a count that did not add up hours later.
   */
  const abandon = (reason, now) => {
    const half = pending.pro
      ? { kind: 'pro', value: pending.pro }
      : pending.og
        ? { kind: 'og', value: pending.og }
        : null;
    pending = { pro: null, og: null, at: 0 };
    if (half) onAbandon?.({ ...half, reason, at: now });
    return half;
  };

  return {
    /** Feed one frame's raw values. Returns a complete pair, or null. */
    push(rawValues, now = Date.now()) {
      const frame = pairFrame(rawValues);

      // Both barcodes in one read is unambiguously ONE label. Anything still
      // held belonged to a different label and never completed.
      if (frame.complete) {
        abandon('superseded', now);
        return { pro: frame.pro, og: frame.og };
      }

      if (expired(now)) abandon('expired', now);

      // A RE-READ of the half already pending is NOT an abandonment. The camera
      // decodes the same barcode on every frame while the loader holds aim, and
      // a gun can double-fire one pull. Deliberately does not refresh the
      // timestamp either: a steady aim at a label whose other barcode will not
      // read must still reach the fallback at the window, not defer it forever.
      if (frame.pro && !frame.og && pending.pro === frame.pro) return null;
      if (frame.og && !frame.pro && pending.og === frame.og) return null;

      // TWO OF THE SAME TYPE IN A ROW means a label was abandoned mid-pair — the
      // operator moved on. The old half must be discarded, never silently
      // overwritten, or the survivor marries the NEXT label's other barcode and
      // books a piece against the wrong stop.
      if (frame.pro && pending.pro) abandon('superseded', now);
      if (frame.og && pending.og) abandon('superseded', now);

      if (frame.pro) pending = { ...pending, pro: frame.pro, at: now };
      if (frame.og) pending = { ...pending, og: frame.og, at: now };

      if (pending.pro && pending.og) {
        const out = { pro: pending.pro, og: pending.og };
        pending = { pro: null, og: null, at: 0 };
        return out;
      }
      return null;
    },
    /**
     * Expire a half-pair on the clock alone.
     *
     * push() only runs when another barcode arrives. An operator who scans one
     * barcode and then stops never pushes again, so without this the half-pair
     * sits unreported until the next label — which is exactly the moment it does
     * damage. The UI ticks this.
     */
    tick(now = Date.now()) {
      if (expired(now)) return abandon('expired', now);
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

  // Which stop it is ALREADY on. Resolved before the duplicate check so the
  // "already scanned" verdict can name it.
  //
  // It used to return stop:null, so a loader re-reading a label was told only
  // "ALREADY SCANNED" with no clue WHOSE it was. On Mandi's truck that turned a
  // one-second answer into a night of work: a skid was scanned again and again
  // expecting ONE DIVERSIFIED, and the label on it was CENTRICSIT's — already
  // aboard. The app knew that the whole time and would not say the name.
  const owner = (manifestStops || []).find((s) => (s.pros || []).includes(pro)) || null;

  if (scannedOgs && scannedOgs.has(og)) {
    return { outcome: OUTCOME.SILENT, pro, og, stop: owner };
  }

  const stop = owner;

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

/**
 * Close the gaps a removed pickup leaves in the trailer positions.
 *
 * Positions come from the route, so a pickup sitting at position 1 leaves the
 * deliveries numbered 2 and 3. Dropping the pickup from the list without
 * renumbering printed "Load 3 of 2" — a position outside its own count, which is
 * nonsense to read at 5am.
 *
 * Stops SHARING a position keep sharing it: two orders for one address are one
 * drop in the trailer, and splitting them would send a loader looking for a
 * second place to put freight that belongs in the first.
 */
export function renumberPositions(orderedStops) {
  let next = 0;
  let lastSeen = null;
  return (orderedStops || []).map((s) => {
    if (s.loadSeq == null) return s;
    if (s.loadSeq !== lastSeen) {
      lastSeen = s.loadSeq;
      next += 1;
    }
    return { ...s, loadSeq: next };
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
 * Should the screen keep showing the OLD route order?
 *
 * Only while freight is physically aboard. The freeze exists because a trailer
 * is a physical record of one particular route order: renumbering the screen
 * under a half-loaded truck would hide freight that is already in the wrong
 * place. That reasoning applies to loaded freight and to NOTHING ELSE.
 *
 * An empty trailer has no order to protect, so it always shows the newest one.
 * Mandi's Aug 10 load sat at 0/14 wearing "the route was resequenced after
 * loading started" — loading had not started, and the stale order it was
 * defending was a previous day's, inherited through a stamp key that carried no
 * date. A loader was being told to distrust a screen that was simply correct.
 */
export function shouldFreezeSequence({ loadedSeq, stops, piecesAboard }) {
  if (!piecesAboard) return false;
  if (!loadedSeq?.fingerprint) return false;
  return loadedSeq.fingerprint !== sequenceFingerprint(stops);
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

/**
 * A scan the loader took back.
 *
 * Voids are TOMBSTONED, never deleted. The queue is also the sync source: a scan
 * that already reached the server and is then dropped from the phone leaves the
 * server still counting it, and the dock and the office disagree forever. A row
 * that stays, marked, can be pushed like any other and reconciles both ends.
 * It is also the honest record — somebody scanned that piece, and then somebody
 * un-scanned it.
 */
export const isVoided = (s) => !!(s && s.voidedAt);

/** Scans that still count. The only place voiding is allowed to matter. */
export const activeScans = (scans) => (scans || []).filter((s) => !isVoided(s));

export function stopProgress(stop, scans, handConfirms = []) {
  const pros = new Set(stop.pros || []);

  // First scan of an OG wins, so a piece marked damaged after the fact keeps its
  // flag rather than being overwritten by a re-read of the same label.
  const byOg = new Map();
  for (const s of activeScans(scans)) {
    if (!pros.has(normalizePro(s.pro))) continue;
    const og = String(s.og).toUpperCase();
    if (!byOg.has(og)) byOg.set(og, s);
  }
  const ogs = new Set(byOg.keys());
  const expected = Number(stop.expectedPieces || 0);

  // A hand-confirm is per STOP and all-or-nothing: there is no piece barcode to
  // count, so the driver is asserting the whole stop is on the truck. It counts
  // toward the load but never pretends to be a scan — `handConfirmed` rides all
  // the way into the session record so completeness can tell them apart.
  const hand = (handConfirms || []).find((h) => String(h.stopNbr) === String(stop.stopNbr)) || null;
  const scannedPieces = ogs.size;
  const confirmedPieces = hand ? Math.max(0, expected - scannedPieces) : 0;
  const scanned = scannedPieces + confirmedPieces;

  // Damaged freight still WENT ON THE TRUCK, so it counts exactly like any other
  // piece — the trailer is full either way, and a load that reads short because
  // someone flagged a crushed carton would send a loader hunting for freight that
  // is already aboard. What it needs is to be visible: the piece rides into the
  // session record so the office can raise the claim.
  const damaged = [...byOg.entries()].filter(([, s]) => s.damaged);

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
    // Enough for the UI to list the pieces and act on one of them.
    pieces: [...byOg.entries()].map(([og, s]) => ({
      og,
      pro: normalizePro(s.pro),
      damaged: !!s.damaged,
      damageNote: s.damageNote || '',
    })),
    damagedOgs: damaged.map(([og]) => og),
    damagedCount: damaged.length,
  };
}

/**
 * Split a load into what gets loaded and what does not.
 *
 * A PICKUP is on the route because the driver collects freight there. Nothing
 * about it happens at the dock. Counting its pieces toward the load total made
 * the truck unfinishable — the loader would work every real stop and still be
 * short by a number nobody could scan.
 */
export function splitPickups(stops) {
  const all = stops || [];
  return {
    loading: all.filter((s) => !s.isPickup),
    pickups: all.filter((s) => s.isPickup),
  };
}

export function loadProgress(stops, scans, handConfirms = []) {
  // Pickups never count toward what has to go on the truck.
  const per = splitPickups(stops).loading.map((s) => stopProgress(s, scans, handConfirms));
  const expected = per.reduce((n, p) => n + p.expected, 0);
  // Distinct OGs across the load, plus whatever the hand-confirms vouch for.
  // Voided scans drop out here too, or the load total would keep counting a piece
  // the stop total has already let go of and the two would never agree.
  const scannedPieces = new Set(activeScans(scans).map((s) => String(s.og).toUpperCase())).size;
  const confirmedPieces = per.reduce((n, p) => n + p.confirmedPieces, 0);
  const scanned = scannedPieces + confirmedPieces;
  return {
    perStop: per,
    expected,
    scanned,
    scannedPieces,
    confirmedPieces,
    handConfirmedStops: per.filter((p) => p.handConfirmed).map((p) => p.stopNbr),
    // Every damaged piece on the truck, so closeout can hand the office one list
    // rather than making someone reopen each stop to find them.
    damagedOgs: per.flatMap((p) => p.damagedOgs),
    damagedCount: per.reduce((n, p) => n + p.damagedCount, 0),
    stopsWithDamage: per.filter((p) => p.damagedCount > 0).map((p) => p.stopNbr),
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
  let lastCode = null;
  let lastAt = 0;

  return {
    /**
     * True if this decode should be acted on. Records the decision.
     *
     * Keyed on the EXACT barcode, not on the PRO behind it. Keying on the PRO
     * meant the two barcodes of a single label counted as the same thing, so
     * reading the piece ID straight after its PRO was suppressed and a loader
     * had to pause between them. They are different barcodes; only an identical
     * one repeating is a repeat. This is what lets the two be scanned back to
     * back while a label re-read by a hovering camera is still ignored.
     */
    allow(code, now = Date.now()) {
      if (lastCode === code && now - lastAt < cooldownMs) return false;
      lastCode = code;
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
