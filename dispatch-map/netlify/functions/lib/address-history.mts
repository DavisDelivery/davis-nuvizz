// lib/address-history.mts — EVERY ADDRESS THAT MOVED AFTER WE FIRST SAW IT.
//
// Chad, 2026-09-11, after asking whether we had changed the address on delivery 007174397:
// "can we start having a log of every address that gets changed from the initial
// scan/enrichment".
//
// THE QUESTION THAT COULD NOT BE ANSWERED. That delivery arrived as "5965 PEACHTREE STREET"
// and our own sealed history for the same customer, three months earlier, read "5965
// PEACHTREE CORS E STE B3" — same house number, same zip, no suite. Answering "did it
// change, and who changed it" took a dozen file reads and five endpoint calls, and half of
// it could not be answered at all, because NOTHING IN THIS SYSTEM WRITES DOWN AN ADDRESS
// CHANGE. The scan detects one (to decide whether to re-enrich) and throws the finding away:
// `reconsigned` and `reconsignedNbrs` in refresh-stops-core.mts are local variables that die
// with the run.
//
// ── WHY THIS DOES NOT REUSE addrListSig ──────────────────────────────────────
//
// The scan's existing detector is `addrListSig` = `zip5|streetNumber`, and it is coarse ON
// PURPOSE: firing it costs a /stop/info re-enrichment per stop, so it must not trip on the
// formatting drift between the saved-search list and /stop/info ("St" vs "Street", a padded
// zip). Both LED ENERGY PLUS addresses hash to "30071|5965", so the detector was right to
// stay quiet and the change was still real.
//
// A LOG COSTS NOTHING TO WRITE, so its threshold is free to be the honest one: any material
// text change. This module therefore NEVER feeds the re-enrichment decision — it only
// observes. Wiring it into that decision would re-open the non-converging loop addrListSig's
// own comment warns about, and would spend vendor calls on a feature that exists to save
// someone reading a screen.
//
// ── WHAT A DISPATCHER DOES WITH EACH KIND ────────────────────────────────────
//
// Ordered by what it costs to be wrong about, because that is the order the screen sorts in:
//
//   moved      the house number or the zip changed → A DIFFERENT BUILDING. If the stop was
//              already on a route, the truck is loaded for the old one. Act now.
//   renamed    same number and zip, different street line (the LED ENERGY PLUS case). Almost
//              always the same dock re-typed by the shipper — but "almost always" is not a
//              thing to assume about a delivery, and the pin may have been geocoded from the
//              old text.
//   suite      only the unit/suite token moved. Reads as small and is not: a dropped STE B3
//              on an inside delivery is a driver standing in a lobby with five pallets.
//   region     city or state changed with the street intact — usually a vendor correcting a
//              misspelled city (NIORCROSS → NORCROSS), occasionally a real re-route.
//   filled     we had no street line and now we do.
//   cleared    we had a street line and now we do not. Nothing should ever do this; if it
//              appears, something upstream is deleting data.
//   formatting the text moved and the freight did not — the suite migrating between addr1 and
//              addr2 (our own "Fix & move pin" does exactly that swap), a contact name
//              appearing in addr2. Recorded so the log is complete, hidden by default.
//
// AND A THIRD TIER ABOVE ALL OF THEM: an address that NORMALISES IDENTICAL produces no row at
// all. "1770 Satellite Blvd." vs "1770 SATELLITE BOULEVARD" with a +4 on the zip is the same
// address, and the saved-search list and /stop/info disagree like that on a large share of
// 700 stops every scan. Logging it would bury the six rows that matter under six hundred that
// do not, which is the same failure as an alert nobody reads.
//
// PURE. No Firestore, no network, no clock — callers pass `at`. Unit-tested directly by
// test/address-history.test.mjs, which pins the real deliveries rather than invented strings.

import { normStreetOf } from '../../../src/lib/matchKey.js';

export type AddressChangeKind =
  | 'moved' | 'renamed' | 'suite' | 'region' | 'filled' | 'cleared' | 'formatting';

/** How we came to see the change. */
export type AddressChangeSource =
  /** the scheduled scan: the stored board row vs what this scan is about to write */
  | 'scan'
  /** a dispatcher saved an address on the stop card (customer_notes.address_override) */
  | 'override'
  /** a dispatcher cleared that override, putting the customer back on NuVizz's address */
  | 'override-reset';

export interface AddressParts {
  addr1?: string | null;
  addr2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface AddressChangeRow {
  /** ISO instant the change was OBSERVED (the scan's stamp, or the save's) */
  at: string;
  /** board day the stop sat on when it changed */
  date: string;
  stopNbr: string;
  businessName: string | null;
  source: AddressChangeSource;
  kind: AddressChangeKind;
  before: AddressParts;
  after: AddressParts;
  /** which of addr1/addr2/city/state/zip actually differ */
  fields: string[];
  /** the route it was on at the moment it changed, and whether it was planned at all —
   *  an address that moves AFTER the truck is built is a different problem from one that
   *  moves while the order is still unplanned. */
  route: string | null;
  planned: boolean;
  /** customer key the change belongs to; an override is filed against the customer, not the order */
  matchKey: string | null;
  /** who saved it, for an override. null for anything the scan observed. */
  actor: string | null;
}

/** Kinds worth a dispatcher's attention by default. `formatting` is recorded and hidden. */
export const NOISY_KINDS: AddressChangeKind[] = ['formatting'];

/** Severity order — the screen sorts on this, not on the clock alone. */
export const KIND_RANK: Record<AddressChangeKind, number> = {
  moved: 0, cleared: 1, renamed: 2, suite: 3, region: 4, filled: 5, formatting: 6,
};

const s = (v: any) => (v == null ? '' : String(v).trim());
const zip5 = (v: any) => s(v).replace(/\D/g, '').slice(0, 5);
const streetNum = (v: any) => s(v).match(/\d+/)?.[0] || '';
const flat = (v: any) => s(v).toLowerCase().replace(/[^a-z0-9]+/g, '');

// THE UNIT TOKENS, AND THE TWO TRAPS IN MATCHING THEM.
//
// (1) \b DOES NOT WORK HERE. normStreetOf has already collapsed spaces to underscores, and
//     `_` is a word character — so /\bbldg/ never matches inside "industrial_access_rd_bldg_400".
//     The first cut of this used \b and silently recognised NOTHING but suites: "BLDG 400" →
//     "BLDG 200" came out `renamed` (a different street) instead of `suite`. It was visible
//     only by running the function, which is why it is pinned by a test now.
//
// (2) A UNIT WORD IS NOT ALWAYS A UNIT. "100 GATE CITY BLVD" is a real Atlanta street, and
//     "gate" leading a segment would eat it. Unit designators are numbered in practice —
//     BLDG 400, DOCK 7, FL 2, RM 101 — so the segment after the word must CONTAIN A DIGIT.
//     Street names do not. `ste_` is exempt: it only ever arises from suite/ste/unit/apt in
//     normStreetOf, so it is unambiguous even as "STE A".
const UNIT_RE = /ste_[a-z0-9]+|(?:^|_)(?:bldg|building|dock|fl|floor|rm|room|lot|spc|space|gate)_(?=[a-z0-9]*\d)[a-z0-9]+/g;

/** The unit/suite tokens carried anywhere in the address, normalised and order-independent.
 *  addr2 counts: NuVizz puts the suite in either line and moving it between them is not a
 *  change to where the freight goes. */
export function unitTokensOf(parts: AddressParts): string {
  const joined = `${normStreetOf(parts?.addr1)}_${normStreetOf(parts?.addr2)}`;
  const hits = (joined.match(UNIT_RE) || []).map((h) => h.replace(/^_/, ''));
  return [...new Set(hits)].sort().join('|');
}

/** The street line with its house number and its unit tokens taken out — what is left is the
 *  STREET ITSELF, which is the part that says whether this is a different road. */
export function streetBodyOf(addr1: any): string {
  let b = normStreetOf(addr1);
  b = b.replace(/^_*\d+_*/, '');                                   // leading house number
  b = b.replace(UNIT_RE, '');
  return b.replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/**
 * LEARNING A FIELD IS NOT CHANGING IT.
 *
 * Our own sealed record for 007138079 carries `state: null` beside a perfectly good GA
 * address, because the saved-search list omits the column on some rows. A later row that
 * carries "GA" has not moved the freight one inch — and reading it as a change would file a
 * row against every such stop on every scan, which is how a log becomes something nobody
 * opens. So a field going from EMPTY to a value is "learned" and not reported.
 *
 * LOSING one still is: a value that disappears is either a vendor deleting data or us
 * dropping it, and both are worth a row. (An addr1 that empties is its own kind, `cleared`.)
 */
function materialDiff(beforeNorm: string, afterNorm: string): boolean {
  if (!beforeNorm && !afterNorm) return false;
  if (!beforeNorm) return false;          // learned
  return beforeNorm !== afterNorm;        // changed, or lost
}

/** Which of the five fields really differ once formatting is normalised away. */
export function changedFields(before: AddressParts, after: AddressParts): string[] {
  const out: string[] = [];
  if (materialDiff(normStreetOf(before?.addr1), normStreetOf(after?.addr1))) out.push('addr1');
  if (materialDiff(normStreetOf(before?.addr2), normStreetOf(after?.addr2))) out.push('addr2');
  if (materialDiff(flat(before?.city), flat(after?.city))) out.push('city');
  if (materialDiff(flat(before?.state), flat(after?.state))) out.push('state');
  if (materialDiff(zip5(before?.zip), zip5(after?.zip))) out.push('zip');
  return out;
}

/**
 * What KIND of change this is, or null when the two describe the same address.
 *
 * The ladder is ordered by consequence, and the first rung that matches wins — a change that
 * is both a rename and a dropped suite is reported as the rename, because that is the bigger
 * thing to look at and a row can only carry one headline.
 *
 * A STATE THAT APPEARS FROM NOWHERE IS NOT A CHANGE OF STATE. The saved-search list omits
 * `state` on some rows (our own sealed record for 007138079 has state:null beside a perfectly
 * good GA address), so a later row that carries "GA" would otherwise log a region change on
 * every such stop — hundreds of rows saying nothing. A field going from EMPTY to a value is
 * only a change when it is the street line itself, which is what `filled` is for.
 */
export function classifyChange(before: AddressParts, after: AddressParts): AddressChangeKind | null {
  const b1 = s(before?.addr1), a1 = s(after?.addr1);
  if (!b1 && !a1) return null;
  if (!b1 && a1) return 'filled';
  if (b1 && !a1) return 'cleared';

  const fields = changedFields(before, after);
  if (!fields.length) return null;

  // OUR OWN FIX BUTTON MUST NOT RAISE A RED FLAG.
  //
  // "Fix & move pin" (suggestAddressFix) SWAPS addr1 and addr2 when NuVizz put the suite or a
  // contact name where the street belongs — addr1 "PROPERTY MANAGER" / addr2 "2611 SPRINGDALE
  // RD SW" becomes the other way round. Run through the ladder below that reads as a house
  // number appearing from nowhere, so it classified as `moved`: the single most urgent class,
  // on the one action the app actively encourages, for a change that moves no freight at all.
  // A screen that cries wolf every time a dispatcher uses its own fix button is a screen that
  // gets ignored, and then the real `moved` row gets ignored with it.
  //
  // The two lines carrying the SAME content in the other order is not a move. It is still
  // recorded — the text did change — just as what it is.
  // A zip is only a move when BOTH sides have one — see materialDiff. Without that guard a row
  // that simply gained its zip would report as a different building. Checked FIRST and outside
  // the swap guard below: a changed zip is a different place however the lines are arranged.
  if (materialDiff(zip5(before?.zip), zip5(after?.zip))) return 'moved';

  const linePair = (p: AddressParts) => [normStreetOf(p?.addr1), normStreetOf(p?.addr2)].filter(Boolean).sort().join('|');
  // The lines must actually have MOVED for this to be a swap. Testing only that they carry
  // the same content made "nothing about the lines changed" look like a swap too, which
  // skipped the ladder for every row whose zip was the only thing that moved.
  const linesMoved = normStreetOf(before?.addr1) !== normStreetOf(after?.addr1)
    || normStreetOf(before?.addr2) !== normStreetOf(after?.addr2);
  const onlySwapped = linesMoved && linePair(before) === linePair(after);

  if (!onlySwapped) {
    if (streetNum(b1) !== streetNum(a1)) return 'moved';
    if (streetBodyOf(b1) !== streetBodyOf(a1)) return 'renamed';
    if (unitTokensOf(before) !== unitTokensOf(after)) return 'suite';
  }
  // Reachable either way: a swap that ALSO corrected the city is still a region change.
  if (fields.includes('city') || fields.includes('state')) return 'region';

  // Text moved; the freight did not. The suite migrating between addr1 and addr2 lands here
  // (our own "Fix & move pin" does exactly that swap), as does a contact name appearing in
  // addr2. Real, recorded, and filtered out of the default view.
  return 'formatting';
}

const pick = (p: AddressParts): AddressParts => ({
  addr1: s(p?.addr1) || null, addr2: s(p?.addr2) || null,
  city: s(p?.city) || null, state: s(p?.state) || null, zip: s(p?.zip) || null,
});

export interface BuildRowInput {
  at: string;
  date: string;
  stopNbr: any;
  businessName?: any;
  source: AddressChangeSource;
  before: AddressParts;
  after: AddressParts;
  route?: any;
  planned?: boolean;
  matchKey?: any;
  actor?: any;
}

/** One log row, or null when nothing changed. Callers push the non-nulls. */
export function buildAddressChangeRow(input: BuildRowInput): AddressChangeRow | null {
  const kind = classifyChange(input.before, input.after);
  if (!kind) return null;
  // A row nobody can tie back to an order is worse than no row — it can only add doubt to a
  // screen whose whole job is to settle a question.
  const stopNbr = s(input.stopNbr);
  if (!stopNbr) return null;
  return {
    at: String(input.at), date: String(input.date), stopNbr,
    businessName: s(input.businessName) || null,
    source: input.source, kind,
    before: pick(input.before), after: pick(input.after),
    fields: changedFields(input.before, input.after),
    route: s(input.route) || null,
    planned: input.planned === true,
    matchKey: s(input.matchKey) || null,
    actor: s(input.actor) || null,
  };
}

/** Compare a stored board row against the row the scan is about to write. Field names are the
 *  board's own, so a caller hands over whole stops and this takes the five it cares about. */
export function diffStopAddress(prev: any, next: any): AddressChangeKind | null {
  return classifyChange(
    { addr1: prev?.addr1, addr2: prev?.addr2, city: prev?.city, state: prev?.state, zip: prev?.zip },
    { addr1: next?.addr1, addr2: next?.addr2, city: next?.city, state: next?.state, zip: next?.zip },
  );
}

export interface AddressHistoryQuery {
  /** exact stop number; also matches the 9-digit zero-padded form NuVizz stores */
  stop?: string | null;
  kinds?: AddressChangeKind[] | null;
  source?: AddressChangeSource | null;
  /** drop `formatting` rows (the screen's default) */
  hideNoise?: boolean;
  limit?: number;
}

/** Stop numbers one typed value could be filed under — mirrors stopIdCandidates in
 *  nuvizz-stop-explain.mts so the two screens answer the same search the same way. */
export function stopCandidates(raw: any): string[] {
  const v = s(raw);
  if (!v) return [];
  const out = [v, v.toUpperCase()];
  if (/^[0-9]+$/.test(v) && v.length < 9) out.push(v.padStart(9, '0'));
  return [...new Set(out)];
}

/**
 * Filter + order a set of rows. Severity first, then newest — a `moved` from this morning
 * outranks a `formatting` from ten minutes ago, which is the whole reason the screen exists.
 * PURE, so the endpoint and the test see the same ordering.
 */
export function selectAddressChanges(all: any[], q: AddressHistoryQuery = {}): AddressChangeRow[] {
  const rows = (Array.isArray(all) ? all : []).filter((r) => r && r.at && r.stopNbr);
  const want = q.stop ? new Set(stopCandidates(q.stop).map((x) => x.toUpperCase())) : null;
  const kinds = q.kinds && q.kinds.length ? new Set(q.kinds) : null;
  const filtered = rows.filter((r) => {
    if (want && !want.has(String(r.stopNbr).toUpperCase())) return false;
    if (kinds && !kinds.has(r.kind)) return false;
    if (q.source && String(r.source) !== q.source) return false;
    if (q.hideNoise && NOISY_KINDS.includes(r.kind)) return false;
    return true;
  });
  filtered.sort((a, b) => {
    const ra = KIND_RANK[a.kind as AddressChangeKind] ?? 99;
    const rb = KIND_RANK[b.kind as AddressChangeKind] ?? 99;
    if (ra !== rb) return ra - rb;
    return String(b.at).localeCompare(String(a.at));
  });
  const lim = Number(q.limit);
  return Number.isFinite(lim) && lim > 0 ? filtered.slice(0, lim) : filtered;
}

/** Counts by kind over a row set — the screen's stat strip, computed once, server-side. */
export function summarizeAddressChanges(rows: any[]): Record<AddressChangeKind, number> & { total: number } {
  const out: any = { moved: 0, renamed: 0, suite: 0, region: 0, filled: 0, cleared: 0, formatting: 0, total: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.kind || !(r.kind in out)) continue;
    out[r.kind] += 1; out.total += 1;
  }
  return out;
}

/**
 * THE SWITCH. Default ON; an explicit off-word turns it off; anything malformed leaves it ON,
 * because a typo in an env var must never silently stop a log nobody would notice had stopped.
 * ADDRESS_HISTORY=off covers the recording AND the endpoint together — a screen asking for a
 * day nothing writes any more is a new bug wearing the old feature's name.
 */
export function addressHistoryEnabled(env: any = process.env): boolean {
  const v = String(env?.ADDRESS_HISTORY ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}
