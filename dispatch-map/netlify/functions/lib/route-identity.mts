// lib/route-identity.mts
//
// ── What a route LABEL is, and when two of them name different loads ─────────
//
// A leaf module on purpose: firestore.mts needs the same "is this the same route?"
// judgement that nuvizz-list.mts needs, and nuvizz-list.mts already imports
// firestore.mts — so the shared rule cannot live in either of them. Nothing is
// imported here, by anyone, ever. (nuvizz-list.mts re-exports the two shape
// predicates so every existing caller keeps its import path: one definition, as
// v1.12.0 insisted, not a third copy drifting from the other two.)

// True for a bare DB identifier (Mongo ObjectId / long hex / 25+-char token) — i.e. NOT a human
// name. Used to keep a driverId from ever being shown as a driver name (#254).
export function isHashLikeId(v: any): boolean {
  const s = String(v ?? '').trim();
  if (!s || /\s/.test(s)) return false;                 // human names are short words or have spaces
  if (/^[0-9a-f]{24}$/i.test(s)) return true;           // Mongo ObjectId
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;          // long hex token
  if (/^[A-Za-z0-9_-]{20,}$/.test(s) && /\d/.test(s)) return true; // long id-ish token containing a digit
  return false;
}

// A NuVizz load NUMBER looks like the company code + zero-padded digits ("DAVIS000198197")
// or (some tenants) a long bare number — NEVER the internal hex loadId (interspersed hex) and
// NEVER a short human route name ("SUW"). Distinctive enough to VALIDATE a labelled column and,
// if the column is mislabelled/absent, to FIND the number anywhere in the row — so "the loads
// scan produces the number, just grab it" holds regardless of the saved-search column naming.
export function looksLikeLoadNbr(v: any): boolean {
  const s = String(v ?? '').trim();
  return /^[A-Za-z]{2,}\d{5,}$/.test(s) || /^\d{6,}$/.test(s);
}

/**
 * PURE. TRUE only when `nextRoute` is DEMONSTRABLY a different load than `priorRoute` —
 * i.e. the order MOVED, rather than being re-sequenced on the route it was already on.
 *
 * TWO NAMESPACES ARE NOT A DISAGREEMENT (the v1.12.0 lesson, arrived at from the other
 * direction). Both board write-through callers fall back to something that is not a route
 * name when a card has no resolvable one — the server takes the load NUMBER, the client can
 * take a hex card key — while the board row holds the human name. "DAVIS000203388" against
 * "RONALD" would read as a move for EVERY such stop, and here that would blank the driver on
 * a route the order never left. A number-shaped or hash-shaped label on either side therefore
 * decides nothing, exactly as in unplanStampOvertaken; so does a blank one. Refuse to compare,
 * and the caller keeps what it had.
 */
export function routeMoved(priorRoute: any, nextRoute: any): boolean {
  const a = String(priorRoute ?? '').trim();
  const b = String(nextRoute ?? '').trim();
  if (!a || !b) return false;                                            // no baseline → no evidence
  if (looksLikeLoadNbr(a) || isHashLikeId(a)) return false;              // not a comparable name
  if (looksLikeLoadNbr(b) || isHashLikeId(b)) return false;
  return a.toLowerCase() !== b.toLowerCase();
}

/**
 * THE SWITCH (Chad: "if it changes something I don't like I can just tell you to flip it
 * back"). MOVE_CLEARS_DRIVER=off restores the pre-v1.31.1 write exactly: a planned board
 * stamp that carries no driver leaves whatever driver the row already had, moved load or not.
 * Default ON; anything malformed leaves it ON, so a typo can never silently disable the rule.
 */
export function moveClearsDriverEnabled(env: Record<string, any> = process.env as any): boolean {
  return !/^(off|0|false|no)$/i.test(String(env?.MOVE_CLEARS_DRIVER ?? '').trim());
}
