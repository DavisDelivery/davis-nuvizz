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
// WHAT IT DOES NOT KNOW. It lives in this browser: a route saved on another dispatcher's device
// carries no check here. That is the cheap direction to be wrong in — a missing check costs a
// re-send, which is idempotent; a check on a load NuVizz does not hold is freight nobody drives.

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

/** A new record map with this outcome stamped under every id. Never mutates `map`. */
export function recordCardOutcome(map, ids, kind, at) {
  const t = stampOf(at);
  const field = kind === 'saved' ? 'savedAt' : kind === 'failed' ? 'failedAt' : null;
  const base = map && typeof map === 'object' ? map : {};
  if (!t || !field || !Array.isArray(ids) || !ids.length) return base;
  const next = { ...base };
  for (const k of ids) {
    const cur = next[k] && typeof next[k] === 'object' ? next[k] : {};
    next[k] = { ...cur, [field]: Math.max(stampOf(cur[field]), t) };
  }
  return next;
}

/** Records younger than the TTL; anything malformed goes. */
export function pruneCardSaves(map, now = Date.now(), ttlMs = CARD_SAVES_TTL_MS) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [k, v] of Object.entries(map)) {
    if (!v || typeof v !== 'object') continue;
    const latest = Math.max(stampOf(v.savedAt), stampOf(v.failedAt));
    if (latest && now - latest < ttlMs) out[k] = { ...(stampOf(v.savedAt) ? { savedAt: stampOf(v.savedAt) } : {}), ...(stampOf(v.failedAt) ? { failedAt: stampOf(v.failedAt) } : {}) };
  }
  return out;
}

/** The latest save and latest refusal on record for a load, across every id it is known by. */
export function earlierOutcome(map, ids) {
  let savedAt = 0;
  let failedAt = 0;
  if (map && typeof map === 'object' && Array.isArray(ids)) {
    for (const k of ids) {
      const v = map[k];
      if (!v || typeof v !== 'object') continue;
      savedAt = Math.max(savedAt, stampOf(v.savedAt));
      failedAt = Math.max(failedAt, stampOf(v.failedAt));
    }
  }
  return { savedAt: savedAt || null, failedAt: failedAt || null };
}
