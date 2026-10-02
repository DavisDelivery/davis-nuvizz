// lib/note-carry.mts — A PUSH THAT RE-KEYS AN ORDER TAKES ITS CUSTOMER NOTE WITH IT.
//
// Chad, on two proposals — the second "don't lose a hand-placed pin when pushing: keep the pin on
// the order a push corrects": "yes do 1 and 2".
//
// THE MECHANISM, FROM THE CODE. A customer note (customer_notes: the hand-placed pin, receiving
// hours, closed days, equipment and vehicle restrictions, contacts, the comms opt-out) is keyed by
// normalizeMatchKey(name, line 1, city, ZIP) of the ORDER as NuVizz holds it — lib/customer-key.mts
// on the server, App.jsx where the board loads, both off the list scan's destination fields. So an
// address push that moves line 1 ("DOCK 32" → "1200 NORTHBROOK PKWY STE 180") re-keys that order
// on the next scan and the note stops joining it. Measured on the real order: DESIGN PRINT BANNER
// 007183435, pushed 2026-09-28, sealed on 09-29 under
// design_print_banner__1200_northbrook_pkwy_ste_180__suwanee__30024 with no note at all — while
// the customer's note sat under design_print_banner__dock_32__suwanee__30024.
//
// WHAT THIS DOES. After a push whose address LANDED, copy the note from the order's old key to the
// key its NuVizz address now makes. The new key is computed from the address NuVizz STORED (the
// push's read-back), because that is what the next scan keys it by: for 007183435 the key computed
// from the read-back and the key the scan sealed are the same string.
//
// ONLY INTO AN EMPTY PLACE. The copy is created only when no note exists under the new key —
// currentDocument.exists:false, so it is atomic. A note already there is never touched: merging
// two notes field by field means deciding, per field, whose receiving hours and whose opt-out win,
// and the notes editor saves explicit blank defaults (comms_opt_out:false, empty hours) that would
// make "fill only what is missing" quietly keep a blank over a real value. That case copies
// nothing and says so, in the write log, where it can be counted.
//
// NOT COPIED:
//   • address_override / address_override_at. NuVizz now holds the address, and the order reads
//     it straight off itself. Copied, it would also put every order on the new key back on the
//     Problem addresses list as "Not in NuVizz" the first time NuVizz spells a line its own way.
//   • THE PIN, WHEN IT IS OLDER THAN THE ADDRESS CORRECTION (pinIsStale — the queue's own rule).
//     That pin is on the OLD building; carried without the override, nothing would flag it again.
//   • match_key, raw_address, updated_by, last_updated — they describe the old document.
// Everything else is copied EXACTLY as stored — typed values, every timestamp verbatim (see
// getDocFieldsRaw for why that needs saying) — plus where it came from: carried_from, carried_for
// (the order), carried_at.
//
// NEVER FAILS THE PUSH. The address is on the order whatever happens here. Every outcome is an
// answer on the push's result (`carry`), which the write log keeps — never a throw.
//
// ADDRESS_PUSH_CARRY_NOTE=off turns it off. House shape: default ON, an explicit off-word turns it
// off, anything malformed leaves it ON.

import { normalizeMatchKey } from '../../../src/lib/matchKey.js';
import { pinIsStale } from './address-queue.mts';
import { createDocIfAbsentRaw, getDocFieldsRaw, isFirestoreEnabled } from './firestore.mts';

export function noteCarryEnabled(env: any = process.env): boolean {
  const v = String(env?.ADDRESS_PUSH_CARRY_NOTE ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** Fields that describe the OLD document, or that NuVizz now holds — never copied. */
export const NOT_CARRIED = new Set([
  'match_key', 'address_override', 'address_override_at', 'raw_address', 'updated_by', 'last_updated',
  'carried_from', 'carried_for', 'carried_at',
]);
/** What this module writes about the copy itself — reported apart from what was carried. */
const PROVENANCE = new Set(['match_key', 'carried_from', 'carried_for', 'carried_at', 'last_updated']);

const keyOf = (name: string, a: any) => normalizeMatchKey(name, String(a?.addr1 ?? ''), String(a?.city ?? ''), String(a?.zip ?? ''));

/**
 * PURE: the two keys a landed push moves an order between — or why there is nothing to carry.
 *
 * THE OLD KEY IS PROVEN, NOT TRUSTED. The caller names the note the board joined to this order
 * (`matchKey`); it is accepted only when the address NuVizz held BEFORE the write produces that
 * same key. A board that was stale, or a caller that sent the wrong key, copies nothing — rather
 * than one customer's pin and receiving hours onto another's address.
 */
export function carryKeys(payload: any, result: any): { from: string; to: string } | { skip: string } {
  if (!result || !(result.ok === true || result.addressLanded === true)) return { skip: 'the address did not land on the order' };
  if (result.side !== 'to') return { skip: 'only a delivery address is keyed by its customer' };
  const matchKey = String(payload?.matchKey ?? '').trim();
  const name = String(payload?.businessName ?? '').trim();
  if (!matchKey || !name) return { skip: 'the push did not say which customer note the order is on' };
  if (!result.wasAddress || !result.nowAddress) return { skip: 'the push did not report the address NuVizz stored' };
  const from = keyOf(name, result.wasAddress);
  if (from !== matchKey) return { skip: `the board's key (${matchKey}) is not the key of this order's address in NuVizz (${from})` };
  const to = keyOf(name, result.nowAddress);
  if (to === from) return { skip: 'the customer key did not change' };
  return { from, to };
}

const rawTime = (v: any): string | null => (v && typeof v === 'object' ? (v.timestampValue ?? v.stringValue ?? null) : null);
const rawNumber = (v: any): number | null => {
  const n = v && typeof v === 'object' ? Number(v.doubleValue ?? v.integerValue) : NaN;
  return Number.isFinite(n) ? n : null;
};
function rawLatLng(v: any): { lat: number; lng: number } | null {
  const f = v?.mapValue?.fields;
  const lat = rawNumber(f?.lat), lng = rawNumber(f?.lng);
  return lat === null || lng === null ? null : { lat, lng };
}

/** PURE: a stored value with nothing in it — null, blank text, false, or a list/map of those. */
export function rawEmpty(v: any): boolean {
  if (!v || typeof v !== 'object' || 'nullValue' in v) return true;
  if ('stringValue' in v) return String(v.stringValue).trim() === '';
  if ('booleanValue' in v) return v.booleanValue !== true;
  if ('arrayValue' in v) return (v.arrayValue?.values || []).every(rawEmpty);
  if ('mapValue' in v) return Object.values(v.mapValue?.fields || {}).every(rawEmpty);
  return false;   // a number, a timestamp, a geo point … is a value
}

/**
 * PURE: the stored fields of the copy, or null when the note holds nothing worth carrying.
 * `src` is the old note as Firestore stores it (getDocFieldsRaw) and is not modified.
 */
export function carriedFields(
  src: Record<string, any>,
  ctx: { from: string; to: string; stopNbr: string; at: string },
): Record<string, any> | null {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(src || {})) if (!NOT_CARRIED.has(k)) out[k] = v;
  const pin = rawLatLng(src?.location_override);
  const stale = pinIsStale({
    address_override_at: rawTime(src?.address_override_at),
    location_override: pin,
    location_override_at: rawTime(src?.location_override_at),
  });
  if (!pin || stale) { delete out.location_override; delete out.location_override_at; }
  // The business name alone is not a note. Neither is a page of the editor's blank defaults.
  if (!Object.entries(out).some(([k, v]) => k !== 'raw_name' && !rawEmpty(v))) return null;
  return {
    ...out,
    match_key: { stringValue: ctx.to },
    carried_from: { stringValue: ctx.from },
    carried_for: { stringValue: ctx.stopNbr },
    carried_at: { timestampValue: ctx.at },
    last_updated: { timestampValue: ctx.at },
  };
}

export type CarryDeps = {
  env: any;
  firestoreEnabled: () => boolean;
  getRaw: (path: string) => Promise<Record<string, any> | null>;
  createIfAbsentRaw: (path: string, fields: Record<string, any>) => Promise<boolean>;
  now: () => Date;
};
const LIVE_DEPS: CarryDeps = {
  env: process.env,
  firestoreEnabled: isFirestoreEnabled,
  getRaw: getDocFieldsRaw,
  createIfAbsentRaw: createDocIfAbsentRaw,
  now: () => new Date(),
};

/**
 * After an address push: carry the order's customer note to the key the order now has. Returns
 * what happened — { carried: [fields], from, to } | { skipped: why, from?, to? } | { error, from, to }
 * — and never throws.
 */
export async function carryNoteAfterPush(payload: any, result: any, deps: Partial<CarryDeps> = {}): Promise<Record<string, any>> {
  const d: CarryDeps = { ...LIVE_DEPS, ...deps };
  if (!noteCarryEnabled(d.env)) return { skipped: 'switched off (ADDRESS_PUSH_CARRY_NOTE=off)' };
  const keys = carryKeys(payload, result);
  if ('skip' in keys) return { skipped: keys.skip };
  const { from, to } = keys;
  try {
    if (!d.firestoreEnabled()) return { skipped: 'Firestore is not configured on this server', from, to };
    const src = await d.getRaw(`customer_notes/${from}`);
    if (!src) return { skipped: "no note under the board's key", from, to };
    const stopNbr = String(result?.stopNbr ?? payload?.stopNbr ?? '');
    const fields = carriedFields(src, { from, to, stopNbr, at: d.now().toISOString() });
    if (!fields) return { skipped: 'the note holds nothing to carry', from, to };
    const created = await d.createIfAbsentRaw(`customer_notes/${to}`, fields);
    if (!created) return { skipped: 'the corrected address already has its own note — nothing copied', from, to };
    return { carried: Object.keys(fields).filter((k) => !PROVENANCE.has(k)).sort(), from, to };
  } catch (e: any) {
    return { error: String(e?.message || e).slice(0, 300), from, to };
  }
}
