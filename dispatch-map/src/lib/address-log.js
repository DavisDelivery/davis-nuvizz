// address-log.js — the CLIENT half of the address-change log.
//
// The scan's half is observed server-side inside writeStops, which sees every address NuVizz
// hands us. It cannot see this half. "Edit address" and "Fix & move pin" on the stop card
// write customer_notes.address_override straight from the browser with the Firestore client
// SDK and never touch a function — and that override is what the board, the pin, the routing
// engine and the customer emails actually use. A log that recorded only the vendor's side
// would answer "did WE change this address" with a confident and wrong no, which is the
// single failure this whole feature exists to stop.
//
// THREE CALL SITES, ONE DEFINITION. The override is saved from the Map stop card, the Routing
// stop card, and the address-edit modal — three copies of the same setDoc, already. Giving
// each its own logging snippet is how the log would come to disagree with itself about what
// "before" means. So both halves live here and the call sites pass their stop.
//
// NOTHING HERE MAY THROW. A failure to log must never fail the save the dispatcher just made;
// the worst outcome allowed is a missing row.

import { apiFetch } from './api.js';

const ENDPOINT = '/.netlify/functions/address-history';

const clean = (v) => (v == null ? '' : String(v).trim());

/**
 * WHAT THE BOARD IS SHOWING FOR THIS STOP RIGHT NOW — the "before" of any edit.
 *
 * This is the same precedence the stop card and the Map pin render with (App.jsx: an
 * address_override wins over the raw NuVizz fields, per-field). Getting it from anywhere else
 * would log a change FROM an address nobody was looking at: edit a customer that already has
 * an override and the row would claim the vendor's long-superseded text was on screen.
 */
export function shownAddress(stop, note) {
  const ov = note?.address_override || {};
  return {
    addr1: clean(ov.addr1 || stop?.addr1),
    addr2: clean(ov.addr2 ?? stop?.addr2),
    city: clean(ov.city ?? stop?.city),
    state: clean(ov.state ?? stop?.state),
    zip: clean(ov.zip ?? stop?.zip),
  };
}

/** The raw NuVizz address, with no override applied — where a Reset puts the customer back. */
export function vendorAddress(stop) {
  return {
    addr1: clean(stop?.addr1), addr2: clean(stop?.addr2),
    city: clean(stop?.city), state: clean(stop?.state), zip: clean(stop?.zip),
  };
}

/**
 * Record one dispatcher-made address change. Fire-and-forget by design: the caller has
 * already saved, and the row is a note about what happened, not part of the save.
 *
 * Returns true when the server said it recorded a row — used only by tests and by anyone
 * debugging the log itself. Callers in the UI ignore it and MUST NOT await it in a way that
 * can surface an error to the dispatcher.
 */
export async function logAddressOverride({ stop, before, after, source = 'override' }) {
  try {
    if (!stop || !before || !after) return false;
    const res = await apiFetch(ENDPOINT, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source,
        stopNbr: stop.stopNbr ?? stop.pro ?? null,
        businessName: stop.businessName || null,
        matchKey: stop.matchKey || null,
        // The board day the stop is sitting on, so the row files against the day a dispatcher
        // would go looking on. Falls back server-side to today when absent.
        date: stop.boardDate || stop.scheduledDate || null,
        route: stop.routeName ?? stop.loadNbr ?? null,
        planned: stop.isPlanned === true,
        before, after,
      }),
    });
    const j = await res.json().catch(() => ({}));
    return j?.recorded === true;
  } catch {
    // Swallowed on purpose — see the header. The dispatcher's address is already saved.
    return false;
  }
}
