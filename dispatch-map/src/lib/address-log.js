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
//
// THE ROWS WERE NEVER MISSING (2026-09-14, and worth recording because two sessions went the
// other way). Ten queue corrections read as an empty log and the search started here, on the
// writer. The writer was fine: every row landed, in the day document for the BOARD DAY the
// stop sat on — which was tomorrow. The reader clamped every request at today and the screen
// hid `formatting` rows by default, so ten correct writes were invisible twice over. See
// QUEUE_DAYS_AHEAD in history-range.js and the source test in selectAddressChanges. When a
// write "fails" with no error anywhere, check that the reader can ask for where it went.

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
 * `nuvizz` is the vendor half's OUTCOME, never its intent: pass true only once the write has
 * been read back as landed, false when it was attempted and did not, and leave it off when
 * nobody asked for it. A caller that logs before the push resolves is claiming an outcome the
 * system has not observed.
 *
 * Returns { recorded, outcome, detail } where outcome is 'recorded' | 'declined' | 'failed'.
 * DECLINED means the server correctly refused the row (no material change, or the day already
 * holds an identical one); FAILED means the POST did not land. One boolean could not tell a
 * correct refusal from a lost write, so a group run could only ever report a number without a
 * reason. It never throws, so a caller may await it; single-save call sites still fire and
 * forget, and none may surface a logging failure to the dispatcher as a failed save.
 */
export async function logAddressOverride({ stop, before, after, source = 'override', nuvizz = null }) {
  try {
    // Shaped like every other exit, because a bare `false` here is truthy-object's mirror
    // image: a caller reading `.recorded` off it gets undefined and counts a silent success.
    if (!stop || !before || !after) return { recorded: false, outcome: 'failed', detail: 'nothing to log' };
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
        // HOW FAR IT REACHED. true = the same edit also landed on the order in NuVizz;
        // false = we asked and the vendor refused, so the board and the driver's manifest
        // now disagree and somebody has to fix the portal; null = board-only.
        // Only a real boolean is sent — see the tri-state note on AddressChangeRow.nuvizz.
        ...(typeof nuvizz === 'boolean' ? { nuvizz } : {}),
        before, after,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (j?.recorded === true) return { recorded: true, outcome: 'recorded', detail: '' };
    // DECLINED IS NOT FAILED. The server says `recorded: false` for two completely different
    // reasons:
    // the row carried no material change, or the day already holds an identical row (the
    // scan's de-dupe, firestore.mts — keyed on stop + before/after + kind). Neither is a
    // fault, and a batch that warned about them would cry wolf on its own correct behaviour.
    if (res.ok && j?.ok !== false) {
      return { recorded: false, outcome: 'declined', detail: String(j?.reason || 'already recorded') };
    }
    return { recorded: false, outcome: 'failed', detail: String(j?.error || `HTTP ${res.status}`) };
  } catch (e) {
    // The POST still never throws at a caller — the dispatcher's address is already saved, and
    // a logging failure must never surface as a failed save. It now says WHAT went wrong so a
    // batch can report a reason instead of a bare count.
    return { recorded: false, outcome: 'failed', detail: String(e?.message || e || 'network error') };
  }
}
