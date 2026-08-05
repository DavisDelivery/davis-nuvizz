// driver-ids.mts — the internal key for a credential.
//
// ── DAVIS DRIVERS DO NOT HAVE DRIVER NUMBERS ────────────────────────────────
//
// They sign in with the NAME ON THE BOARD and a PIN, which is the last four of
// their cell. There is no number on their paperwork to type in. The dispatcher
// screen used to demand one to create a credential, which meant the Save button
// could never enable and a driver could not be added at all.
//
// The number still exists as the Firestore document id and the JWT subject, so
// it cannot simply be dropped — that would be a data migration across every
// session token in the field. It becomes what it always really was: an internal
// key, generated here, and never something a human has to know or supply.
//
// Sequential rather than random so the ids stay short, sorted and human-readable
// in the credential table, which matters when someone does have to read one out.

const FLOOR = 1000;

/**
 * The next free number, given every id already in use.
 *
 * Non-numeric ids are ignored rather than rejected: the bootstrap dispatcher and
 * any hand-seeded credential may use anything, and they must not break creation.
 */
export function nextDriverNumber(existing: Array<string | number | null | undefined>): string {
  let max = FLOOR - 1;
  for (const raw of existing || []) {
    const s = String(raw ?? '').trim();
    if (!/^\d+$/.test(s)) continue;
    const n = Number(s);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return String(max + 1);
}

/**
 * A PIN from a phone number: the last four digits.
 *
 * Accepts whatever a dispatcher pastes — "(678) 226-2099", "678-226-2099", or
 * just "2099" — because the number gets copied off a contact card, not typed
 * carefully. Returns '' when there are not four digits to take, so the caller
 * refuses rather than setting a short PIN nobody can guess back.
 */
export function pinFromPhone(raw: any): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}
