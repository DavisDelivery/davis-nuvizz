// src/lib/debug-capture-scrub.js — what a "Debug this view" capture may say about a stop (PURE).
//
// The capture is filed as a GitHub issue, and the sheet promises the dispatcher it holds
// "data only — no customer names or addresses". The scrubber kept `matchKey`, which is
// normalizeMatchKey(businessName, addr1, city, zip) — the customer's name and street in
// plain text — so every capture of a busy board broke that promise hundreds of times. The
// key is replaced by a digest: equal digests still mean the same location (the join a
// reviewer needs), and the name and street are not in the issue.

// FNV-1a over the key, twice with different seeds for 64 bits — the same construction
// shiplify-import uses, synchronous and identical in the browser and Node (the bundle is
// built synchronously, and crypto.subtle is async-only).
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** PURE. 16-hex digest of a location key, or null when there is no key. */
export function matchKeyDigest(key) {
  const s = String(key ?? '');
  if (!s) return null;
  const a = fnv1a(s, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a(s, 0x01234567).toString(16).padStart(8, '0');
  return `${a}${b}`;
}

// Customer names/addresses/contacts and the raw NuVizz payload are scrubbed.
export function scrubStop(s, seq, note) {
  if (!s) return null;
  return {
    seq: seq == null ? undefined : seq,
    stopNbr: s.stopNbr,
    pro: s.pro,
    loadNbr: s.loadNbr,
    // The ROUTE name is loadNbr on a list row; the load NUMBER for the day comes from the roster
    // (v1.82.0) — hand the agent both, labelled, so nobody has to ask which MARCUS this is.
    routeName: s.routeName,
    rosterLoadNbr: s.rosterLoadNbr,
    rosterLoadId: s.rosterLoadId,
    loadDay: s.loadDay,
    heldOn: s.heldOn && typeof s.heldOn === 'object' ? { loadNbr: s.heldOn.loadNbr, day: s.heldOn.day, route: s.heldOn.route } : undefined,
    status: s.status,
    normalizedStatus: s.normalizedStatus,
    isPlanned: s.isPlanned,
    isUnplanned: s.isUnplanned,
    isTerminal: s.isTerminal,
    carryover: s.carryover,
    driverName: s.driverName,
    driverUserName: s.driverUserName,
    routeSeq: s.routeSeq,
    loadStopSeq: s.loadStopSeq,
    plannedEtaDTTM: s.plannedEtaDTTM,
    arrivalDTTM: s.arrivalDTTM,
    deliveredDTTM: s.deliveredDTTM,
    cartons: s.cartons,
    pallets: s.pallets,
    volume: s.volume,
    weight: s.weight,
    lat: s.lat,
    lng: s.lng,
    matchKeyDigest: matchKeyDigest(s.matchKey),
    hasNote: !!note,
    flag: note?.priority_flag ?? null,
    // dropped (PII / huge): businessName, addr1, addr2, city, state, zip, matchKey
    // (it IS name+street), contact, origin, stopDetails, allComments, raw
  };
}
