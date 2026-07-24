// src/lib/presence.js
//
// Pure helpers for the multi-dispatcher presence layer (v0.51.0). Two dispatchers
// working the board at once used to be invisible to each other: every in-progress
// edit (Compare cards, staged stops, selections) is local React state, so both
// could grab the SAME unplanned stop onto different loads and the later Save
// silently won. The presence layer publishes a tiny heartbeat doc per device to
// Firestore (`dispatch_presence/{deviceId}`) — who's online, which screen, which
// stops their Compare cards are staging — so the other device can see the work,
// keep its selection tools off those stops, and warn on a colliding Save.
//
// This module is PURE (no Firebase, no React) so the staleness / claims / label
// logic is unit-testable; App.jsx owns the Firestore read/write wiring.

// A peer doc older than this is treated as gone (closed laptop, dead tab). The
// heartbeat republishes at PRESENCE_HEARTBEAT_MS, so ~3 missed beats = stale.
export const PRESENCE_STALE_MS = 75000;
export const PRESENCE_HEARTBEAT_MS = 25000;

const ID_KEY = 'dispatchMap.deviceId';
const NAME_KEY = 'dispatchMap.deviceName';

export function newDeviceId(rand = Math.random) {
  return `d${rand().toString(36).slice(2, 10)}${rand().toString(36).slice(2, 6)}`;
}

// Friendly default before the dispatcher names the device — "Dispatcher 4F2A".
export function defaultDeviceName(id) {
  return `Dispatcher ${String(id || '').slice(-4).toUpperCase() || '??'}`;
}

// Read-or-create this device's stable identity. `storage` is localStorage-shaped
// (injected so tests don't need a browser); a broken/absent storage still returns
// a usable in-memory identity — presence just won't survive a reload there.
export function loadDeviceIdentity(storage) {
  let id = null, name = null;
  try { id = storage?.getItem(ID_KEY) || null; } catch { /* ignore */ }
  try { name = storage?.getItem(NAME_KEY) || null; } catch { /* ignore */ }
  if (!id) {
    id = newDeviceId();
    try { storage?.setItem(ID_KEY, id); } catch { /* ignore */ }
  }
  return { id, name: (name || '').trim() || defaultDeviceName(id) };
}

export function saveDeviceName(storage, name) {
  try { storage?.setItem(NAME_KEY, String(name || '').trim()); } catch { /* ignore */ }
}

// Other devices' docs that are alive: not us, and heartbeat within the staleness
// window. Malformed docs (no deviceId / no numeric updatedAt) are dropped.
export function activePeers(docs, selfId, nowMs, staleMs = PRESENCE_STALE_MS) {
  return (docs || []).filter((d) => {
    if (!d || !d.deviceId || d.deviceId === selfId) return false;
    const at = Number(d.updatedAt);
    return Number.isFinite(at) && nowMs - at < staleMs;
  });
}

// stopNbr → peer name, for every stop a live peer is staging on Compare cards for
// the SAME board date. Different-date staging never claims (yesterday's leftover
// cards on another device must not lock today's board). First peer wins a tie.
export function buildPeerClaims(peers, date) {
  const m = new Map();
  for (const p of peers || []) {
    if (!p || String(p.stagedDate || '') !== String(date || '')) continue;
    for (const nbr of p.staged || []) {
      const k = String(nbr);
      if (k && !m.has(k)) m.set(k, p.name || 'another dispatcher');
    }
  }
  return m;
}

const SCREEN_LABELS = { map: 'Map', routing: 'Routing', neworder: 'New Order', quote: 'Quote', diag: 'Diagnostics' };

// One-line chip label, or null when nobody else is on.
export function peerChipLabel(peers) {
  const list = peers || [];
  if (!list.length) return null;
  if (list.length === 1) {
    const p = list[0];
    const where = SCREEN_LABELS[p.screen] || null;
    const n = Array.isArray(p.staged) ? p.staged.length : 0;
    return `${p.name || 'Another dispatcher'} is on${where ? ` · ${where}` : ''}${n ? ` · staging ${n} stop${n === 1 ? '' : 's'}` : ''}`;
  }
  return `${list.length} other dispatchers on`;
}

// Newest confirmed-save stamp across peers (0 when none) — the "someone else just
// saved, silently re-read the board" trigger.
export function latestPeerSaveAt(peers) {
  let t = 0;
  for (const p of peers || []) {
    const v = Number(p?.saveAt);
    if (Number.isFinite(v) && v > t) t = v;
  }
  return t;
}
