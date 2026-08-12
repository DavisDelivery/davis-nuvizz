// src/lib/routing-loads.js
//
// Pure helpers for the Shared Loads view — auto-name, summary, and the standard
// date/time format ("Jun 5, 2026 2:14p"). Extracted so they're unit-testable
// without the React/Firestore shell. Time is rendered in America/New_York (the
// depot/dispatch timezone) so it's stable regardless of the device clock.

const TZ = 'America/New_York';

// Epoch ms (or Date) → "Jun 5, 2026 2:14p". Empty string on bad input.
export function formatDateTime(input) {
  if (input == null) return '';
  const d = input instanceof Date ? input : new Date(Number(input));
  if (Number.isNaN(d.getTime())) return '';
  const date = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value || '';
  const minute = parts.find((p) => p.type === 'minute')?.value || '00';
  const ap = (parts.find((p) => p.type === 'dayPeriod')?.value || '').toLowerCase().startsWith('p') ? 'p' : 'a';
  return `${date} ${hour}:${minute}${ap}`;
}

// Normalize a Firestore Timestamp / millis / Date / ISO string → epoch ms or null.
export function tsToMillis(ts) {
  if (ts == null) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  if (ts instanceof Date) return ts.getTime();
  const n = Number(ts);
  if (Number.isFinite(n)) return n;
  const p = Date.parse(ts);
  return Number.isFinite(p) ? p : null;
}

export function loadTruckCount(result) {
  return Array.isArray(result?.routes) ? result.routes.length : 0;
}

export function loadStopCount(result) {
  if (!Array.isArray(result?.routes)) return 0;
  return result.routes.reduce((a, r) => a + (Array.isArray(r.orderedStopIds) ? r.orderedStopIds.length : 0), 0);
}

// "3 trucks · 28 stops" (+ " · N spilled" when some stops couldn't be placed).
export function loadSummary(result) {
  const t = loadTruckCount(result), s = loadStopCount(result);
  const parts = [`${t} truck${t === 1 ? '' : 's'}`, `${s} stop${s === 1 ? '' : 's'}`];
  const spill = Array.isArray(result?.unassigned) ? result.unassigned.length : 0;
  if (spill) parts.push(`${spill} spilled`);
  return parts.join(' · ');
}

// Sensible default name: "Jun 5, 2026 2:14p · 3 trucks · 28 stops".
export function buildLoadAutoName(result, nowInput) {
  const t = loadTruckCount(result), s = loadStopCount(result);
  return `${formatDateTime(nowInput)} · ${t} truck${t === 1 ? '' : 's'} · ${s} stop${s === 1 ? '' : 's'}`;
}

// ── WHICH LOAD IS THIS, REALLY ────────────────────────────────────────────────
//
// Every write against a load — assign a driver, dispatch it, save a reorder — needs NuVizz's
// internal loadId, and the board does not carry one. A board stop's `loadNbr` field holds the
// route NAME ("STEVEN"), not the load number: see nuvizz-list.mts toBoardStop, which sets
// `loadNbr: hasRoute ? r.routeName : null`. The real identity lives on the day's load roster,
// where the same route name maps to a different loadId every day (STEVEN was
// 6a7987c2… on 8/10, 6a7ac732… on 8/11, 6a7c3673… on 8/12).
//
// So identity is resolved by looking the route up in that day's roster. This was written out
// by hand in four places in App.jsx; extracting it makes the one guard that actually costs
// money testable.
//
// THE GUARD: two loads on one day CAN share a name. Handing a write to the wrong one is
// silent and irreversible in NuVizz — it is the STEVEN case documented in route-status.js.
// A cancelled load next to a live one is NOT a contest (the live load owns the name), but two
// LIVE loads are, and there the answer must be "refuse", never "pick one".

/**
 * Build the name/id/number → identity index from a day's roster rows.
 * `resolveOwner` is route-status.js's resolveNameOwner, injected so this stays pure.
 */
export function buildLoadRosterIndex(rosterLoads = [], resolveOwner = null) {
  const index = new Map();
  const owners = new Map();
  const asEntry = (l) => ({
    loadId: l?.loadId ? String(l.loadId) : null,
    name: l?.name || '',
    loadNbr: l?.loadNbr ? String(l.loadNbr) : null,
  });
  for (const l of rosterLoads || []) {
    const nm = String(l?.name ?? '').trim().toLowerCase();
    const entry = asEntry(l);
    if (nm) {
      if (!owners.has(nm)) {
        owners.set(nm, resolveOwner ? resolveOwner(nm, rosterLoads) : { load: l, ambiguous: false });
      }
      const own = owners.get(nm);
      if (own?.ambiguous) index.set(nm, { ...entry, ambiguous: true });
      else index.set(nm, asEntry(own?.load || l));
    }
    if (l?.loadId) index.set(String(l.loadId), entry);
    // An empty load's grid row is keyed by its real load number, so that must resolve too.
    if (l?.loadNbr) index.set(String(l.loadNbr), entry);
  }
  return index;
}

/**
 * The identity to write against, or null when we must not write.
 *
 * Returns null — meaning REFUSE, do not guess — when the name is ambiguous (two live loads)
 * or when no loadId can be found at all (a draft/empty load whose id has not loaded yet).
 * `looksLikeLoadNbr` is injected: a stop's loadNbr is usually a route name, and sending a
 * name where NuVizz expects a number fails in a way that reads like a vendor error.
 */
export function resolveLoadIdentity(g, index, looksLikeLoadNbr = () => false) {
  const idx = index || new Map();
  const get = (k) => (k ? idx.get(String(k).trim().toLowerCase()) || idx.get(String(k).trim()) : null);
  const hit = get(g?.name) || get(g?.key) || (g?.loadId ? get(g.loadId) : null) || null;
  const entry = hit && !hit.ambiguous ? hit : null;
  const loadId = g?.loadId || entry?.loadId || null;
  if (!loadId) return null;
  const loadNbr = (g?.loadNbr && looksLikeLoadNbr(g.loadNbr)) ? g.loadNbr : (entry?.loadNbr || null);
  return { loadId: String(loadId), loadNbr: loadNbr ? String(loadNbr) : null, ambiguous: false };
}

/** Why a resolve refused — for a message a dispatcher can act on. */
export function loadIdentityRefusal(g, index) {
  const idx = index || new Map();
  const get = (k) => (k ? idx.get(String(k).trim().toLowerCase()) || idx.get(String(k).trim()) : null);
  const hit = get(g?.name) || get(g?.key) || null;
  if (hit?.ambiguous) return 'two live loads share this name — rename one in the portal first';
  return 'its NuVizz load id has not loaded yet';
}
