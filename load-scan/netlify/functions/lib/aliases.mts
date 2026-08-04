// aliases.mts — driver identity resolution.
//
// WHY THIS IS NOT AN EQUALITY CHECK
//
// The stop index's driverUserName field carries two different kinds of value
// depending on where the stop came from:
//
//   - A NuVizz list scan writes a stable short code ("VINCENT"). See
//     dispatch-map nuvizz-driver-route.mts, which prefers driverUserName over
//     driverName precisely because NuVizz returns full names with inconsistent
//     internal whitespace ("VINCENT  BONZO").
//   - dispatch-map's own boardWritePlannedFields writes `driverUserName:
//     driverName` — a FULL NAME — on engine-planned stops.
//   - nuvizz-list.mts carries a firstNonHashName guard because driverId
//     ObjectIds have historically leaked into the name slot (#254).
//
// So one driver legitimately appears under several spellings, and the set is
// maintained BY HAND (nuvizzAliases on the credential doc). There are no
// matching heuristics here on purpose: a plausible wrong load at 5am puts a
// driver on the wrong truck, which is the exact failure this app exists to stop.

/**
 * Alias normalizer. Byte-for-byte the same algorithm as normalizeDriverAlias in
 * dispatch-map/netlify/functions/lib/tractor-flags.mts — trim, collapse internal
 * whitespace, uppercase. Duplicated rather than imported because Netlify builds
 * this site with base = "load-scan" and nothing outside that tree exists at build
 * time. It is the same scheme, not a second one; change both together.
 */
export function normalizeDriverAlias(s: any): string {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export interface DriverCred {
  driverNumber: string;
  displayName?: string;
  nuvizzAliases?: string[];
  active?: boolean;
}

export type Resolution =
  | { status: 'resolved'; driverNumber: string; matchedAlias: string }
  | { status: 'unresolved'; reason: 'no_match' | 'ambiguous'; alias: string; claimedBy: string[] };

/**
 * Resolve one stop's driverUserName to exactly one driver.
 *
 * Exactly one driver claiming the normalized alias = resolved. Zero, or more
 * than one, = UNRESOLVED. Never nearest-name, never first-match-wins.
 */
export function resolveDriverForAlias(rawAlias: any, creds: DriverCred[]): Resolution {
  const alias = normalizeDriverAlias(rawAlias);
  if (!alias) return { status: 'unresolved', reason: 'no_match', alias: '', claimedBy: [] };

  const claimedBy = creds
    .filter((c) => (c.nuvizzAliases || []).some((a) => normalizeDriverAlias(a) === alias))
    .map((c) => String(c.driverNumber));

  if (claimedBy.length === 1) return { status: 'resolved', driverNumber: claimedBy[0], matchedAlias: alias };
  return {
    status: 'unresolved',
    reason: claimedBy.length === 0 ? 'no_match' : 'ambiguous',
    alias,
    claimedBy,
  };
}

/**
 * The inverse, and the one the manifest endpoint actually uses: does this stop
 * belong to this driver? True only when the stop's alias is in the driver's set.
 */
export function stopBelongsToDriver(stop: any, cred: DriverCred): boolean {
  const set = new Set((cred.nuvizzAliases || []).map(normalizeDriverAlias).filter(Boolean));
  if (!set.size) return false;
  // Check both fields: driverUserName is the preferred key, but engine-planned
  // stops copy the full name into it and NuVizz-scanned stops keep the code, so
  // a hand-seeded set may legitimately match either column.
  return set.has(normalizeDriverAlias(stop?.driverUserName)) || set.has(normalizeDriverAlias(stop?.driverName));
}

/**
 * Resolve what a driver typed on the sign-in screen to exactly one credential.
 *
 * All digits is a driver number, used as-is. Anything else is the name off the
 * board, matched against displayName and the hand-seeded alias set under the
 * same rule as stop resolution: exactly one claimant resolves, zero or several
 * is a refusal. Never a nearest-name guess — a plausible wrong credential at
 * 5am signs a driver into somebody else's PIN lockout counter.
 */
export function resolveLoginIdentifier(
  rawInput: any,
  creds: DriverCred[],
):
  | { kind: 'number'; driverNumber: string }
  | { kind: 'name'; status: 'resolved'; driverNumber: string }
  | { kind: 'name'; status: 'unresolved'; reason: 'no_match' | 'ambiguous'; claimedBy: string[] } {
  const input = normalizeDriverAlias(rawInput);
  if (!input) return { kind: 'name', status: 'unresolved', reason: 'no_match', claimedBy: [] };
  if (/^\d+$/.test(input)) return { kind: 'number', driverNumber: input };

  const claimedBy = [
    ...new Set(
      creds
        .filter(
          (c) =>
            normalizeDriverAlias(c.displayName) === input ||
            (c.nuvizzAliases || []).some((a) => normalizeDriverAlias(a) === input),
        )
        .map((c) => String(c.driverNumber)),
    ),
  ];

  if (claimedBy.length === 1) return { kind: 'name', status: 'resolved', driverNumber: claimedBy[0] };
  return {
    kind: 'name',
    status: 'unresolved',
    reason: claimedBy.length === 0 ? 'no_match' : 'ambiguous',
    claimedBy,
  };
}

/** Aliases claimed by more than one driver — a seeding mistake worth surfacing. */
export function findAmbiguousAliases(creds: DriverCred[]): Array<{ alias: string; driverNumbers: string[] }> {
  const map = new Map<string, string[]>();
  for (const c of creds) {
    for (const a of c.nuvizzAliases || []) {
      const k = normalizeDriverAlias(a);
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(String(c.driverNumber));
    }
  }
  return [...map.entries()]
    .filter(([, list]) => new Set(list).size > 1)
    .map(([alias, driverNumbers]) => ({ alias, driverNumbers: [...new Set(driverNumbers)] }));
}
