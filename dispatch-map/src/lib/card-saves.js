// src/lib/card-saves.js — has this LOAD been saved to NuVizz before? (PURE)
//
// Chad, 2026-09-30: "I want saved route to always carry a green check mark if it has saved
// previously say if a route was closed out and re brought up but keep the message as is for a
// route that just saved."
//
// WHY THE CARD FORGOT. The ✓ SENT mark (v1.37.0) reads savedAtByKey, which lives in the
// workbench's memory and is pruned the moment a card closes — deliberately, because a reopened
// card is rebuilt from the board and "✓ SENT 7:42 AM" says the card MATCHES what was sent. So a
// route saved at 7:42, closed and brought back at 9:00 read exactly like one nobody ever sent.
//
// WHAT THIS KEEPS. One record per LOAD, written only where the ✓ SENT stamp itself is earned
// (markSaved — a confirmed write) and where the ✗ is earned (markSaveFailed — a refusal read
// back off the result). The card that just saved keeps its "✓ SENT 7:42 AM" message exactly as
// it was; this record only speaks for a card that has NO stamp of its own this session — the
// closed-and-reopened one.
//
// KEYED BY THE LOAD, NEVER BY ITS NAME. Route names repeat every day: Friday's MARCUS
// (DAVIS000204535) and Monday's MARCUS (DAVIS000204645) read the same. A record under the name
// would put Friday's check on Monday's route. The load id and the real load NUMBER are unique
// per load, so a check can only ever land on the load that was actually saved.
//
// IT ONLY SPEAKS FOR A CARD THAT STILL SHOWS WHAT WAS SENT. The record keeps the order the save
// carried, and the reopened card earns its ✓ only while it shows those stops in that order
// (sameRunOrder) — the same promise "✓ SENT" makes. A portal edit the board has picked up, a board
// that missed the save's write-through, a stop now staged on another card: each changes what the
// reopened card shows, and the ✓ is withheld rather than vouching for a card nobody sent.
//
// A ROUTE A SAVE CANCELLED IS NOT SAVED. Emptying a card and saving cancels the load in NuVizz and
// reports ok; it is recorded as a cancellation, which outranks any earlier save of that load.
//
// THE LOAD NUMBER IS THE ONE NUVIZZ WROTE. After a recurring-instance retarget the write lands on
// the same-named twin, and the result names it (nuvizz-write.mts: p.result.loadNbr = srcNbr). The
// caller passes the RESULT's identity, and only that is recorded — never the empty twin the card
// was opened on.
//
// WHAT IT DOES NOT KNOW. It lives in this browser — every tab of it, merged on each write — but a
// route saved on another dispatcher's device carries no check here. That is the cheap direction to
// be wrong in: a missing check costs a re-send, which is idempotent; a check on a load NuVizz does
// not hold is freight nobody drives.

import { looksLikeLoadNbr } from './route-identity.js';

export const CARD_SAVES_KEY = 'dispatchMap.cardSaves';
// Long enough for tomorrow's routes built tonight and a weekend between; short enough that the
// record never grows without bound. Load ids are unique, so age is only housekeeping.
export const CARD_SAVES_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const stampOf = (v) => { const t = Number(v); return Number.isFinite(t) && t > 0 ? t : 0; };

/** The keys a load is known by: its id and its real load number. A route NAME is never one. */
export function cardSaveIds(card) {
  const out = [];
  const id = String(card?.loadId ?? '').trim();
  if (id && id !== 'null' && id !== 'undefined') out.push(`id:${id}`);
  const nbr = String(card?.loadNbr ?? '').trim();
  if (nbr && looksLikeLoadNbr(nbr)) out.push(`nbr:${nbr.toUpperCase()}`);
  return out;
}

const FIELD = { saved: 'savedAt', failed: 'failedAt', cancelled: 'cancelledAt' };
const cleanOrder = (order) => (Array.isArray(order) ? order.map((x) => String(x ?? '')).filter(Boolean) : null);

/**
 * A new record map with this outcome stamped under every id. Never mutates `map`.
 * kind: 'saved' (with the `order` the save carried) | 'failed' (a refusal read back) |
 * 'cancelled' (the save emptied and cancelled the load). Each field keeps its latest stamp, so two
 * tabs merging their writes can only ever add information, never lose a refusal.
 */
export function recordCardOutcome(map, ids, kind, at, order = null) {
  const t = stampOf(at);
  const field = FIELD[kind] || null;
  const base = map && typeof map === 'object' ? map : {};
  if (!t || !field || !Array.isArray(ids) || !ids.length) return base;
  const sent = kind === 'saved' ? cleanOrder(order) : null;
  if (kind === 'saved' && !sent) return base;   // a save we cannot compare against claims nothing
  const next = { ...base };
  for (const k of ids) {
    const cur = next[k] && typeof next[k] === 'object' ? next[k] : {};
    const newer = t >= stampOf(cur[field]);
    next[k] = { ...cur, [field]: Math.max(stampOf(cur[field]), t), ...(sent && newer ? { order: sent } : {}) };
  }
  return next;
}

/** Two records merged field by field — the latest of each stamp wins (two tabs, one device). */
export function mergeCardSaves(a, b) {
  const out = {};
  for (const src of [a, b]) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (!v || typeof v !== 'object') continue;
      const cur = out[k] || {};
      const next = { ...cur };
      for (const f of Object.values(FIELD)) if (stampOf(v[f]) > stampOf(cur[f])) next[f] = stampOf(v[f]);
      if (stampOf(v.savedAt) && stampOf(v.savedAt) >= stampOf(cur.savedAt) && cleanOrder(v.order)) next.order = cleanOrder(v.order);
      out[k] = next;
    }
  }
  return out;
}

/** Records younger than the TTL; anything malformed goes. */
export function pruneCardSaves(map, now = Date.now(), ttlMs = CARD_SAVES_TTL_MS) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [k, v] of Object.entries(map)) {
    if (!v || typeof v !== 'object') continue;
    const latest = Math.max(stampOf(v.savedAt), stampOf(v.failedAt), stampOf(v.cancelledAt));
    if (!latest || now - latest >= ttlMs) continue;
    const e = {};
    for (const f of Object.values(FIELD)) if (stampOf(v[f])) e[f] = stampOf(v[f]);
    if (e.savedAt && cleanOrder(v.order)) e.order = cleanOrder(v.order);
    out[k] = e;
  }
  return out;
}

/**
 * The latest save (with the order it carried) and the latest outcome that was NOT a holdable save —
 * a refusal or a cancellation — on record for a load, across every id it is known by.
 */
export function earlierOutcome(map, ids) {
  let savedAt = 0;
  let failedAt = 0;
  let order = null;
  if (map && typeof map === 'object' && Array.isArray(ids)) {
    for (const k of ids) {
      const v = map[k];
      if (!v || typeof v !== 'object') continue;
      if (stampOf(v.savedAt) > savedAt) { savedAt = stampOf(v.savedAt); order = cleanOrder(v.order); }
      failedAt = Math.max(failedAt, stampOf(v.failedAt), stampOf(v.cancelledAt));
    }
  }
  return { savedAt: savedAt || null, failedAt: failedAt || null, order };
}

/**
 * PURE: does the card show the stops the save carried, in the order it carried them?
 *
 * Orders at one dock may come back from a scan in either order — NuVizz gives them one stop
 * number, and the board breaks the tie its own way — so a run of consecutive stops at the same
 * dock (dockOf) is compared as a set. Everything else must match position for position.
 */
export function sameRunOrder(sent, shown, dockOf = (id) => id) {
  const a = cleanOrder(sent);
  const b = cleanOrder(shown);
  if (!a || !b || !a.length || a.length !== b.length) return false;
  const runs = (list) => {
    const out = [];
    for (const id of list) {
      const dock = String(dockOf(id) ?? id);
      const last = out[out.length - 1];
      if (last && last.dock === dock) last.ids.push(id);
      else out.push({ dock, ids: [id] });
    }
    return out.map((r) => r.ids.slice().sort().join('|'));
  };
  const ra = runs(a);
  const rb = runs(b);
  return ra.length === rb.length && ra.every((r, i) => r === rb[i]);
}
