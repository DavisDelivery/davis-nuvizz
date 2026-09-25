// lib/driver-class.mts — WHICH TRUCK A DRIVER RUNS: the MarginIQ employees roster, then the one pin.
//
// Moved here, unchanged, from routing-plan-core.mts (v1.69.0) so the Claude shadow can use the SAME
// rule the learned engine uses without importing the engine's whole graph — routing-plan-core
// reaches setDoc, history-store and tractor-flags, none of which the shadow's isolation guard may
// admit. routing-plan-core re-exports both names, so every existing caller is untouched, and
// test/driver-class.test.mjs pins that the two are the same objects.
//
// PURE: no I/O, no imports.

// Phase 2.9 — PURE: employees roster → driver_key → truck class. Joined on the
// same fold the engine keys everything by (NuVizz alias, else fullName,
// else first+last; explicit aliases too), so Chad's MarginIQ Vehicle Type edits
// flow straight into class gating and the per-class skid caps.
export function employeeClassMap(employees: any[]): Map<string, string> {
  const fold = (s: any) => String(s || '').trim().toUpperCase().replace(/\s+/g, '_');
  const out = new Map<string, string>();
  for (const e of employees || []) {
    const vt = String(e?.vehicleType || '').toLowerCase();
    if (vt !== 'tractor' && vt !== 'box_truck') continue;
    const names = new Set<string>([
      (e?.externalIds || {})?.nuvizz, e?.fullName,
      `${e?.firstName || ''} ${e?.lastName || ''}`.trim(),
      ...(Array.isArray(e?.aliases) ? e.aliases : []),
    ].filter(Boolean).map(fold));
    for (const k of names) if (k && !out.has(k)) out.set(k, vt);
  }
  return out;
}

// Fallback truck-class pin for drivers without an employees-roster record.
export const CLASS_OVERRIDE = new Map<string, string>([['JUNIOR_THOMAS', 'tractor']]);
