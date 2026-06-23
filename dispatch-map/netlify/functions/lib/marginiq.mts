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

// Normalize a name for matching: lowercase, strip punctuation, collapse spaces,
// and sort tokens so "Smith, Tony" and "Tony Smith" match.
function normName(s: any): string {
  const t = String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return t.sort().join(' ');
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
