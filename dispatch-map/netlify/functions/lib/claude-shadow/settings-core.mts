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
export interface NormalizedChange { loosePerSkid?: number | null; caps: CapChange[]; ceilings?: { ceilingBox?: number | null; ceilingTractor?: number | null } }

// THE CEILINGS (v1.75.0). Chad, 2026-09-26: "there are times where we can get 46 pallets on a truck
// but its when its certain very stackable freight like corregated boxes. So i like hard caps on
// even the learned behavior and a ui to adjust them all against their learned behaviors." A learned
// cap says what a driver or route HAS carried; on Sep 23, 58 of 61 loads carried a learned cap
// above the truck's rating (TRAILER 6 at 46.4 on a 28-skid trailer, from a raise that history
// cannot tell was one trip or two). So a ceiling per truck class holds every learned cap down,
// and a cap a person sets for a driver or a route is that person's number and may sit above it —
// that is the "adjust them all against their learned behaviors". The defaults are the learned
// engine's own hard caps (routing-engine-config.mts skid_cap_box_hard / skid_cap_tractor_hard,
// from ~900 real trips: box p95 22, tractor p95 37); pinned to them by a test. The truck RATINGS
// (14 / 28) are not the defaults: Sep 23 carried 1,230 spots on 61 loads against 1,148 rated,
// so ratings as ceilings would make a real day unplannable.
export const DEFAULT_CEILINGS: Record<'box_truck' | 'tractor', number> = { box_truck: 22, tractor: 37 };
export const CEILING_FIELDS = { ceilingBox: 'box_truck', ceilingTractor: 'tractor' } as const;
export const CEILING_NAMES = { ceilingBox: 'box-truck ceiling', ceilingTractor: 'tractor ceiling' } as const;

/** The ceilings in force from the settings document: a stored number in range, else the default. */
export function ceilingsInForce(settings: any): { box_truck: number; tractor: number; sources: { box_truck: 'yours' | 'default'; tractor: 'yours' | 'default' } } {
  // Only a number, or a plain decimal string, is a ceiling: num() would read `true` as 1, `[5]` as 5
  // and '0x10' as 16 — values the validator refuses — so a malformed stored field falls to the default.
  const pick = (v: any) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && DECIMAL_RE.test(v) ? Number(v) : null;
    return n != null && Number.isFinite(n) && n >= CAP_BOUNDS[0] && n <= CAP_BOUNDS[1] ? n : null;
  };
  const b = pick(settings?.ceilingBox), t = pick(settings?.ceilingTractor);
  return { box_truck: b ?? DEFAULT_CEILINGS.box_truck, tractor: t ?? DEFAULT_CEILINGS.tractor, sources: { box_truck: b != null ? 'yours' : 'default', tractor: t != null ? 'yours' : 'default' } };
}

/**
 * A driver's truck class for the capacity card, in the backtest's own order (buildBacktestProblem):
 * the employees roster, then the one pinned class (CLASS_OVERRIDE). Null when the roster could not
 * be read — the card then says no class is known rather than guessing box truck.
 */
export function classOfFrom(empClass: Map<string, string> | null, override: Map<string, string>) {
  if (!empClass) return null;
  const fold = (x: any) => String(x || '').trim().toUpperCase().replace(/\s+/g, '_');
  return (key: string, name?: string): 'box_truck' | 'tractor' | null => {
    const c = empClass.get(fold(name ?? key)) || empClass.get(fold(key)) || override.get(fold(name ?? key)) || override.get(fold(key));
    return c === 'tractor' ? 'tractor' : c === 'box_truck' ? 'box_truck' : null;
  };
}

/** A learned cap held to its class ceiling; a cap a person set is never touched; no class, no ceiling. */
export function clipCap(cap: number | null, source: 'yours' | 'learned' | null, cls: 'box_truck' | 'tractor' | null, ceilings: { box_truck: number; tractor: number } | null): { cap: number | null; clipped: boolean; ceiling: number | null } {
  const ceiling = cls && ceilings ? ceilings[cls] ?? null : null;
  if (cap == null || source !== 'learned' || ceiling == null || cap <= ceiling) return { cap, clipped: false, ceiling };
  return { cap: ceiling, clipped: true, ceiling };
}

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
  for (const k of ['ceilingBox', 'ceilingTractor'] as const) {
    if (!(k in change)) continue;
    const r = readNumber(change[k], CAP_BOUNDS, `the ${CEILING_NAMES[k]}`);
    if (r.error) { errors.push(r.error); continue; }
    normalized.ceilings = { ...(normalized.ceilings || {}), [k]: r.value ?? null };
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
  if (!('loosePerSkid' in normalized) && !normalized.caps.length && !normalized.ceilings && !errors.length) errors.push('nothing to change');
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
export function withOverrides(
  model: any, caps: { drivers: Record<string, any>; routes: Record<string, any> } | null, opts: { unknown?: boolean } = {},
  // v1.75.0: the ceilings and each driver's truck class, so a row can say the cap the backtest will
  // actually hold it to. A route pools every truck that ran it, so its class — and its ceiling —
  // is only known when a day is built; its row shows the learned cap and says so.
  ceilings: { box_truck: number; tractor: number } | null = null, classOf: ((key: string, name?: string) => 'box_truck' | 'tractor' | null) | null = null,
) {
  if (!model) return model;
  const od = caps?.drivers || {};
  const or = caps?.routes || {};
  const resolve = (row: any, bucket: any, kind: CapKind) => {
    const cls = kind === 'driver' && classOf ? classOf(row.key, row.name) : null;
    if (opts.unknown) return { ...row, cls, yourCap: null, yourCapBy: null, yourCapAt: null, capUsed: null, capSource: 'unknown', clipped: false, ceiling: null };
    const o = bucket[row.key] || null;
    const yours = o ? num(o.cap) : null;
    const source: 'yours' | 'learned' | null = yours != null ? 'yours' : row.cap != null ? 'learned' : null;
    const held = clipCap(yours ?? row.cap ?? null, source, cls, ceilings);
    return {
      ...row,
      cls,
      yourCap: yours,
      yourCapBy: o ? o.by ?? null : null,
      yourCapAt: o ? o.at ?? null : null,
      capUsed: held.cap,
      capSource: source,
      clipped: held.clipped,
      ceiling: held.ceiling,
      // A route row's class is only known when a day is built, so its row carries BOTH ceilings: the
      // screen says what the number will be held to on each truck (a typed route cap too, v1.75.0).
      routeCeilings: kind === 'route' && ceilings ? { box_truck: ceilings.box_truck, tractor: ceilings.tractor } : null,
    };
  };
  const drivers = (Array.isArray(model.drivers) ? model.drivers : []).map((r: any) => resolve(r, od, 'driver'));
  const routes = (Array.isArray(model.routes) ? model.routes : []).map((r: any) => resolve(r, or, 'route'));
  // A cap for a driver or route with no learned trips yet (a new hire, a new route) is still shown,
  // so it can be seen, changed and cleared.
  const orphans = (bucket: any, rows: any[]) => {
    const known = new Set(rows.map((r) => r.key));
    return Object.entries(bucket)
      .filter(([k]) => !known.has(k))
      .map(([k, o]: [string, any]) => ({ key: k, name: o.name, cap: null, trips: 0, noHistory: true, cls: null, yourCap: num(o.cap), yourCapBy: o.by ?? null, yourCapAt: o.at ?? null, capUsed: num(o.cap), capSource: 'yours', clipped: false, ceiling: null }));
  };
  return {
    ...model,
    drivers: opts.unknown ? drivers : [...drivers, ...orphans(od, drivers)].sort((a, b) => a.name.localeCompare(b.name)),
    routes: opts.unknown ? routes : [...routes, ...orphans(or, routes)].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
