// src/lib/route-identity.js
//
// What a route LABEL is, and when two of them name different loads. The client mirror of
// netlify/functions/lib/route-identity.mts — same three rules, same wording, so the board
// paint on screen and the board write on the server cannot drift apart about whether an
// order changed loads. (Mirrored rather than shared: the browser bundle and the functions
// bundle have no common module root in this project.)

// True for a bare DB identifier (Mongo ObjectId / long hex / 25+-char token) — i.e. NOT a human
// name. Keeps a NuVizz ObjectId / internal load-id from ever rendering as a human load/route
// NAME: a recurring load's real name is its loadNbr ("BEN 2"); loadId is a 24-hex id.
export function isHashLikeId(v) {
  const s = String(v ?? '').trim();
  if (!s || /\s/.test(s)) return false;            // human names have spaces or are short words
  if (/^[0-9a-f]{24}$/i.test(s)) return true;      // Mongo ObjectId
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;     // long hex token
  return /^[A-Za-z0-9_-]{20,}$/.test(s) && /\d/.test(s); // long id-ish token with a digit
}

// A NuVizz load NUMBER ("DAVIS000198197") — company code + zero-padded digits, or a long bare
// number. Distinguishes the real number load/info needs from the human route name ("SUW") that
// stops carry in loadNbr.
export function looksLikeLoadNbr(v) {
  const s = String(v ?? '').trim();
  return /^[A-Za-z]{2,}\d{5,}$/.test(s) || /^\d{6,}$/.test(s);
}

/**
 * PURE. TRUE only when `nextRoute` is DEMONSTRABLY a different load than `priorRoute` — i.e.
 * the order MOVED, rather than being re-sequenced on the route it was already on.
 *
 * TWO NAMESPACES ARE NOT A DISAGREEMENT. A confirmed plan can name its route with a hex card
 * key or a load number when the card has no resolvable name, while the board row holds the
 * human name — "DAVIS000203388" against "RONALD" is not evidence of a move, and treating it as
 * one would blank the driver on a route the order never left. A number-shaped or hash-shaped
 * label on either side decides nothing, and neither does a blank one: the caller keeps what it
 * had. Mirrors routeMoved in netlify/functions/lib/route-identity.mts.
 */
export function routeMoved(priorRoute, nextRoute) {
  const a = String(priorRoute ?? '').trim();
  const b = String(nextRoute ?? '').trim();
  if (!a || !b) return false;                                 // no baseline → no evidence
  if (looksLikeLoadNbr(a) || isHashLikeId(a)) return false;   // not a comparable name
  if (looksLikeLoadNbr(b) || isHashLikeId(b)) return false;
  return a.toLowerCase() !== b.toLowerCase();
}

/**
 * PURE. The driver name to paint on a row a confirmed plan is putting on `nextRoute`.
 *
 * A DRIVER BELONGS TO THE LOAD, NOT TO THE ORDER (Chad, Sep 2026 — PRO 7175976 moved off
 * COLIN 1 onto GAINESVILLE, which had nobody on it, and the board named COLIN as GAINESVILLE's
 * driver). `planDriver` is what the save confirmed — a real name when a driver was assigned in
 * the same Save, null when none was. Null used to fall back to the row's own driver, which is
 * the right answer for a re-sequence and the wrong one for a MOVE: the row's driver is a fact
 * about the load the order just left. So it is kept where the route is unchanged (or not
 * comparably named) and dropped where the order demonstrably changed loads.
 */
export function plannedDriverName(planDriver, rowDriver, priorRoute, nextRoute) {
  if (planDriver) return planDriver;
  return routeMoved(priorRoute, nextRoute) ? null : (rowDriver ?? null);
}
