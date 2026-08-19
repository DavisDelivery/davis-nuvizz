// lib/customer-key.mts
//
// THE ONE PLACE A STOP IS TURNED INTO A CUSTOMER KEY.
//
// customer_notes — where receiving hours, opt-outs and pin overrides live — is keyed by
// normalizeMatchKey(businessName, addr1, city, zip). Several places need that key, and this
// session watched the same bug land twice because each of them decided for itself:
//
//   * the ETA back-test re-implemented the model's accessors and silently diverged;
//   * the miss ledger read a stored `customerMatchKey` field;
//   * the critical-flag alert read a stored `matchKey` field — and the LIVE stop index does
//     not carry one. Measured against a real board: 778 stops, 63 routes judged, and
//     `matchKey` null on every single row. Zero notes loaded, zero stops with receiving
//     hours, zero flags. The alert would have read a perfectly ordinary Tuesday as a day
//     with nothing wrong on it, and never sent a thing.
//
// That is the whole reason this module exists. DERIVE, never trust — the fields the key is
// built from are on every stop, in the live index and in sealed history alike, while the
// pre-computed key is on some rows and not others. A stored value is accepted only as a
// fallback, and a key with no alphanumerics is refused rather than used to fetch a garbage
// document.
import { normalizeMatchKey } from '../../../src/lib/matchKey.js';

export function stopCustomerKey(s: any): string | null {
  const derived = normalizeMatchKey(s?.businessName, s?.addr1, s?.city, s?.zip);
  const key = /[a-z0-9]/i.test(String(derived || ''))
    ? derived
    : (s?.customerMatchKey || s?.matchKey || '');
  return /[a-z0-9]/i.test(String(key || '')) ? String(key) : null;
}

/**
 * A copy of the stops with `matchKey` filled in from the derivation.
 *
 * computeBoardFlags looks its notes up by `stop.matchKey` — so loading the notes correctly
 * is only half the job. If the stops still carry null, the engine finds nothing and reports
 * a clean board. Server-side callers must pass stops through this before judging them; the
 * browser's stops already carry the key, which is exactly why this was invisible on screen.
 */
export function withCustomerKeys(stops: any[]): any[] {
  return (stops || []).map((s) => {
    const k = stopCustomerKey(s);
    return k && s?.matchKey !== k ? { ...s, matchKey: k } : s;
  });
}
