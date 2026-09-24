// lib/claude-shadow/settings-core.mts — THE SHADOW'S CAPACITY SETTINGS. Pure: no I/O.
//
// Chad, 2026-09-24: "truck capacity should be learned from all the data we have and we should have
// a ui where we can customize it." The learned numbers (learn-core.mts) are what the history says;
// these are what a person says, and for that driver or route a person's number replaces the
// learned one:
//
//   loosePerSkid   how many loose pieces take the room of one skid spot (default 10). It is ONE
//                  number for every truck, and changing it rebuilds every learned number.
//   caps           a cap in skid spots for one DRIVER or one ROUTE, typed by a dispatcher.
//
// WHERE THEY LIVE, AND WHY IN PIECES (after review). One settings document rewritten whole on every
// save is a lost update by construction: two dispatchers saving different drivers at the same
// moment each read, merge and replace, and one of them is told "saved" about a cap that is gone.
// So each cap is its OWN document — claude_shadow_caps/{driver|route}__{id} — and a save only ever
// writes the documents it names; the ratio is three fields on claude_shadow_settings/davis written
// field-masked (value, when, who). Every accepted change, a cleared cap included, is appended to
// claude_shadow_settings_log, so "who set Ben to 14, and who took BEN 1's cap off" can be answered.
//
// A BLANK IS NOT A NUMBER. `Number('')` is 0 and 0 is finite, so a cleared box read naively would
// save a cap of 0 — a truck that holds nothing. A change must say what it means: a number in
// range, or `null` to remove a cap (or put the ratio back to its default). `true`, `[5]`, `'0x1A'`
// and the like are refused, not coerced. A refused change writes nothing at all.
//
// WHICH CAP A LOAD IS HELD TO when its driver and its route both have one is NOT decided here —
// nothing plans with these numbers yet, and that rule is Chad's to set. This module resolves a
// driver's cap and a route's cap separately and says so.

import { keyOf, tidy, num, DEFAULT_LOOSE_PER_SKID } from './learn-core.mts';

export const CAPS_COLLECTION = 'claude_shadow_caps';
export const SETTINGS_LOG_COLLECTION = 'claude_shadow_settings_log';
export const LOOSE_PER_SKID_BOUNDS: [number, number] = [1, 100];
// Skid spots. The learned engine's own hard caps are 22 (box) and 37 (tractor); 60 leaves room for
// anything real and refuses a typo like 180.
export const CAP_BOUNDS: [number, number] = [1, 60];
export const MAX_NAME_LENGTH = 120;

export type CapKind = 'driver' | 'route';
export interface CapChange { kind: CapKind; key: string; name: string; cap: number | null }
export interface NormalizedChange { loosePerSkid?: number | null; caps: CapChange[] }

const DECIMAL_RE = /^\s*\d+(\.\d+)?\s*$/;

/** A typed value → a number, `null` (clear), or an error. Only a finite number or a plain decimal
 *  string is a number here; only `null` clears. */
function readNumber(v: any, [lo, hi]: [number, number], what: string): { value?: number | null; error?: string } {
  if (v === null) return { value: null };
  let n: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) n = v;
  else if (typeof v === 'string') {
    if (v.trim() === '') return { error: `${what} is blank — type a number, or clear it` };
    if (DECIMAL_RE.test(v)) n = Number(v);
  }
  if (n == null) return { error: `${what} is not a number (${JSON.stringify(String(v).slice(0, 20))})` };
  if (n < lo || n > hi) return { error: `${what} must be between ${lo} and ${hi} (got ${n})` };
  return { value: Math.round(n * 10) / 10 };
}

/** Check a change before anything is written. All or nothing: any error refuses the whole change. */
export function validateSettingsChange(change: any): { ok: boolean; errors: string[]; normalized: NormalizedChange } {
  const errors: string[] = [];
  const normalized: NormalizedChange = { caps: [] };
  if (!change || typeof change !== 'object' || Array.isArray(change)) return { ok: false, errors: ['no change sent'], normalized };
  if ('loosePerSkid' in change) {
    const r = readNumber(change.loosePerSkid, LOOSE_PER_SKID_BOUNDS, 'loose pieces per skid spot');
    if (r.error) errors.push(r.error); else normalized.loosePerSkid = r.value ?? null;
  }
  const list = change.caps == null ? [] : change.caps;
  if (!Array.isArray(list)) errors.push('caps must be a list');
  else {
    const seen = new Set<string>();
    for (const o of list) {
      const kind = o?.kind;
      if (kind !== 'driver' && kind !== 'route') { errors.push(`a cap must be for a driver or a route (got ${JSON.stringify(kind)})`); continue; }
      if (typeof o?.name !== 'string') { errors.push(`a ${kind} cap has no name`); continue; }
      const name = tidy(o.name);
      const key = keyOf(name);
      if (!key) { errors.push(`a ${kind} cap has no name`); continue; }
      if (key.length > MAX_NAME_LENGTH) { errors.push(`the ${kind} name "${name.slice(0, 30)}…" is too long`); continue; }
      const dup = `${kind}|${key}`;
      if (seen.has(dup)) { errors.push(`${name} appears twice in one change`); continue; }
      seen.add(dup);
      const r = readNumber(o?.cap, CAP_BOUNDS, `the cap for ${name}`);
      if (r.error) { errors.push(r.error); continue; }
      normalized.caps.push({ kind, key, name, cap: r.value ?? null });
    }
  }
  if (!('loosePerSkid' in normalized) && !normalized.caps.length && !errors.length) errors.push('nothing to change');
  return { ok: errors.length === 0, errors, normalized };
}

// A cap document's id: the kind, then the name with every character outside a plain, path-safe set
// written as (hex). Reversible, so two names can never share a document — "COLIN/DJ 1" and
// "COLIN(2f)DJ 1" stay apart because "(" and ")" are escaped too.
const SAFE_ID_CHAR = /[A-Z0-9 _.:@+\-'&,]/;
export function capDocId(kind: CapKind, key: string): string {
  let out = '';
  for (const ch of String(key)) out += SAFE_ID_CHAR.test(ch) ? ch : `(${(ch.codePointAt(0) as number).toString(16)})`;
  return `${kind}__${out}`;
}
export function capDocPath(kind: CapKind, key: string): string {
  return `${CAPS_COLLECTION}/${capDocId(kind, key)}`;
}

/** The stored cap documents → the two lookup maps withOverrides takes, keyed like the model. */
export function capsFromDocs(docs: any[]): { drivers: Record<string, any>; routes: Record<string, any> } {
  const drivers: Record<string, any> = {}, routes: Record<string, any> = {};
  for (const d of docs || []) {
    const cap = num(d?.cap);
    const key = String(d?.key ?? '');
    if (cap == null || !key) continue;
    const row = { name: String(d?.name ?? key), cap, at: d?.at ?? null, by: d?.by ?? null };
    if (d?.kind === 'driver') drivers[key] = row;
    else if (d?.kind === 'route') routes[key] = row;
  }
  return { drivers, routes };
}

/** The ratio in force from the settings document, and the one the model was built at: they differ
 *  when a save's rebuild did not land yet — which the screen must say rather than hide. */
export function ratioInForce(settings: any): number {
  const v = num(settings?.loosePerSkid);
  return v != null && v >= LOOSE_PER_SKID_BOUNDS[0] && v <= LOOSE_PER_SKID_BOUNDS[1] ? v : DEFAULT_LOOSE_PER_SKID;
}

/**
 * The learned model with each driver's and route's cap RESOLVED: yours when you set one, else the
 * learned cap, else none — and which of the two it is. `caps` null with `unknown` true means the
 * caps could not be read: every row then says so, instead of presenting "no cap of yours" as fact.
 */
export function withOverrides(model: any, caps: { drivers: Record<string, any>; routes: Record<string, any> } | null, opts: { unknown?: boolean } = {}) {
  if (!model) return model;
  const od = caps?.drivers || {};
  const or = caps?.routes || {};
  const resolve = (row: any, bucket: any) => {
    if (opts.unknown) return { ...row, yourCap: null, yourCapBy: null, yourCapAt: null, capUsed: null, capSource: 'unknown' };
    const o = bucket[row.key] || null;
    const yours = o ? num(o.cap) : null;
    return {
      ...row,
      yourCap: yours,
      yourCapBy: o ? o.by ?? null : null,
      yourCapAt: o ? o.at ?? null : null,
      capUsed: yours ?? row.cap ?? null,
      capSource: yours != null ? 'yours' : row.cap != null ? 'learned' : null,
    };
  };
  const drivers = (Array.isArray(model.drivers) ? model.drivers : []).map((r: any) => resolve(r, od));
  const routes = (Array.isArray(model.routes) ? model.routes : []).map((r: any) => resolve(r, or));
  // A cap for a driver or route with no learned trips yet (a new hire, a new route) is still shown,
  // so it can be seen, changed and cleared.
  const orphans = (bucket: any, rows: any[]) => {
    const known = new Set(rows.map((r) => r.key));
    return Object.entries(bucket)
      .filter(([k]) => !known.has(k))
      .map(([k, o]: [string, any]) => ({ key: k, name: o.name, cap: null, trips: 0, noHistory: true, yourCap: num(o.cap), yourCapBy: o.by ?? null, yourCapAt: o.at ?? null, capUsed: num(o.cap), capSource: 'yours' }));
  };
  return {
    ...model,
    drivers: opts.unknown ? drivers : [...drivers, ...orphans(od, drivers)].sort((a, b) => a.name.localeCompare(b.name)),
    routes: opts.unknown ? routes : [...routes, ...orphans(or, routes)].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
