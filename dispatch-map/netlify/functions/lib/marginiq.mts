// lib/marginiq.mts
//
// Resolves a driver's mobile number from MarginIQ's `employees` collection in the
// shared Firestore, so "Text driver" can send without the phone ever reaching the
// browser. Matches by normalized name across fullName / first+last / aliases.
//
// employees doc shape (discovered): { fullName, firstName, lastName, aliases[],
//   phone (10-digit), role ("driver"/"owner…"), status ("active"), externalIds{…} }.

import { listDocs } from './firestore.mts';
import { normalizePhone, validUsPhone } from './sms.mts';

const COLLECTION = process.env.MARGINIQ_EMPLOYEES_COLLECTION || 'employees';
const TTL_MS = 10 * 60 * 1000;
let __cache: { at: number; map: Map<string, string> } | null = null;
let __rosterCache: { at: number; rows: EmployeeContact[] } | null = null;

// A messageable person from the employee roster. `group` separates the contact
// list into Drivers vs Contractors (owner-operators / carriers) vs office Team,
// so the Messages contact picker can show them in labeled sections.
export type ContactGroup = 'driver' | 'contractor' | 'team';
export interface EmployeeContact {
  id: string;
  name: string;
  phone: string;   // normalized 10-digit
  role: string;    // raw role string from the roster
  group: ContactGroup;
}

// Normalize a name for matching: lowercase, strip punctuation, collapse spaces,
// and sort tokens so "Smith, Tony" and "Tony Smith" match.
function normName(s: any): string {
  const t = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return t.sort().join(' ');
}

// Bucket a raw role string into a contact group. Drivers are employees who drive;
// owner-operators / contractors / carriers are external; everyone else is "team".
export function employeeGroup(role: any): ContactGroup {
  const r = String(role ?? '').toLowerCase();
  if (r.includes('driver')) return 'driver';
  if (r.includes('owner') || r.includes('operator') || r.includes('contractor') || r.includes('carrier') || r.includes('vendor')) return 'contractor';
  return 'team';
}

// Best-name for a roster row: explicit fullName, else first+last.
function rowName(e: any): string {
  return String(e?.fullName || [e?.firstName, e?.lastName].filter(Boolean).join(' ') || '').trim();
}

// A roster row counts as messageable if it's active (or status unknown) and has a
// valid 10-digit phone. Deactivated/terminated employees are dropped.
function isMessageable(e: any): boolean {
  const status = String(e?.status ?? 'active').toLowerCase();
  return status === '' || status === 'active' || status === 'enabled' || status === 'available';
}

async function loadMap(): Promise<Map<string, string>> {
  if (__cache && Date.now() - __cache.at < TTL_MS) return __cache.map;
  const map = new Map<string, string>();
  try {
    const rows = await listDocs(COLLECTION);
    for (const e of rows) {
      const phone = normalizePhone(e?.phone);
      if (!validUsPhone(phone)) continue;
      const names = [
        e?.fullName,
        [e?.firstName, e?.lastName].filter(Boolean).join(' '),
        ...(Array.isArray(e?.aliases) ? e.aliases : []),
      ];
      for (const n of names) { const k = normName(n); if (k && !map.has(k)) map.set(k, phone); }
    }
  } catch (e: any) { console.warn(`[marginiq] employees load failed: ${e?.message}`); }
  __cache = { at: Date.now(), map };
  return map;
}

// Phone for a driver name, or null if no employee match / no valid phone.
export async function resolveDriverPhone(name: string): Promise<string | null> {
  const k = normName(name);
  if (!k) return null;
  const map = await loadMap();
  return map.get(k) || null;
}

// The full messageable roster (drivers + contractors + team), grouped and sorted
// by name. Powers the Messages contact picker so the dispatcher can start a new
// text to anyone on the roster without first knowing their number. Cached briefly
// per function instance — a roster changes rarely.
export async function listEmployees(): Promise<EmployeeContact[]> {
  if (__rosterCache && Date.now() - __rosterCache.at < TTL_MS) return __rosterCache.rows;
  const out: EmployeeContact[] = [];
  try {
    const rows = await listDocs(COLLECTION);
    const seen = new Set<string>();
    for (const e of rows) {
      if (!isMessageable(e)) continue;
      const phone = normalizePhone(e?.phone);
      if (!validUsPhone(phone) || seen.has(phone)) continue;
      const name = rowName(e);
      if (!name) continue;
      seen.add(phone);
      out.push({ id: String(e?._id || phone), name, phone, role: String(e?.role || ''), group: employeeGroup(e?.role) });
    }
  } catch (e: any) { console.warn(`[marginiq] listEmployees failed: ${e?.message}`); }
  out.sort((a, b) => a.name.localeCompare(b.name));
  __rosterCache = { at: Date.now(), rows: out };
  return out;
}

// ── EVERY NAME A DRIVER HAS BEEN KNOWN BY → ONE KEY ─────────────────────────
//
// Chad, asked whether two spellings were one man: "Yes same man."
//
// NuVizz renamed Brenton Byrd from "Brent  Boyd" to "Brent  Bryd" on 2026-08-27. Anything keyed
// on the name then sees two people: on the driver-area sheet that is one man with half a
// territory twice, and — worse — the retired spelling reads as somebody who stopped running, so
// he gets dropped for inactivity as well. One typo, two wrong answers.
//
// THE ANSWER IS NOT A HARDCODED PAIR. His employees card already carries it: alias
// "Brent Bryd" with "Brent Boyd" kept in aliases[], put there on purpose by a person. Three
// joins in this repo already read that list (resolveDriverPhone, routing-plan-core,
// routing-draft-core). Reading it here means the NEXT rename is fixed by editing the card, the
// way the last one was, instead of by a deploy — and it means nobody has to remember to tell me.
//
// The canonical name is externalIds.nuvizz where present, because that is the spelling the
// dispatch board shows: a trainee must learn the name they will actually see, not the one on
// the payroll. PURE half, so the rule is testable without Firestore.
export function buildDriverAliases(employees: any[]): Array<{ from: string; to: string }> {
  const key = (n: any) => String(n ?? '').trim().toUpperCase().replace(/\s+/g, '_');
  const out: Array<{ from: string; to: string }> = [];
  for (const e of employees || []) {
    const canonical = key(e?.externalIds?.nuvizz) || key(e?.fullName);
    if (!canonical) continue;
    const known = new Set<string>();
    for (const n of [e?.fullName, [e?.firstName, e?.lastName].filter(Boolean).join(' '), ...(Array.isArray(e?.aliases) ? e.aliases : [])]) {
      const k = key(n);
      // A name that IS the canonical one is not an alias of itself, and an empty one is noise.
      if (k && k !== canonical) known.add(k);
    }
    for (const from of known) out.push({ from, to: canonical });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** The alias pairs from the employees roster. Best-effort: a read failure means no folding. */
export async function driverAliases(): Promise<Array<{ from: string; to: string }>> {
  try { return buildDriverAliases(await listDocs(COLLECTION)); }
  catch (e: any) { console.warn(`[marginiq] driver aliases unavailable: ${e?.message}`); return []; }
}
