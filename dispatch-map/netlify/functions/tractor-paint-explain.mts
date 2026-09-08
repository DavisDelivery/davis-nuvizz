// tractor-paint-explain.mts — WHY IS THIS STOP NOT PAINTED LIME?
//
// Chad, on MHC KENWORTH SOUTH sitting un-highlighted in the selection panel: "i'm pretty sure
// a tractor has delivered here so it should be auto painted can you check on that and provide
// me an answer."
//
// There was no way to check. The lime is a JOIN — MarginIQ employees tagged
// vehicleType:'tractor', matched by NuVizz alias against sealed history deliveries, rolled up
// into tractor_locations — and every one of its four failure modes produces the same blank
// pin, so "no tractor has been here" and "the join dropped it" were indistinguishable from
// the outside. That is the shape of failure this repo has a rule about: a zero-cost explain
// is ten minutes of work and the first move, not the fourth.
//
// It answers, for one customer:
//   • does the tractor_locations flag exist, and what does it say
//   • WHO has actually delivered there, from the same rollup the stop card's "Recent PROs"
//     list reads, with each driver's roster verdict spelled out:
//       tractor            → tagged, alias joined; this delivery SHOULD have flagged
//       not-a-tractor      → the roster says this driver runs something else
//       unknown-to-roster  → the NuVizz name on the delivery matches no employee alias, which
//                            is the Brent Boyd/Bryd failure that has cost this repo a rule
//                            before, and it is invisible without being named
//   • whether a CONFIRMED trailer blocker is vetoing the paint even though the flag is there
//     (tractorPaintAllowed — the map's own override, run here rather than described)
//
// Read-only. Firestore only. ZERO NuVizz calls.
//
//   ?matchKey=abc__123_main_st__buford__30518
//   ?name=MHC+KENWORTH&addr1=...&city=...&zip=...     (the key is derived, same as the map)
//   ?rebuild=hint                                      (says what to re-run; never runs it)
import { isFirestoreEnabled, getDoc } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';
import { getCustomerByMatchKey } from './lib/history-customers.mts';
import { loadTractorRoster, normalizeDriverAlias, tractorLocPath } from './lib/tractor-flags.mts';
import { normalizeMatchKey } from '../../src/lib/matchKey.js';
import { tractorPaintAllowed } from '../../src/lib/map-legend.js';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b, null, 1), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=30', Vary: 'Authorization' },
  });
  // Viewer: this reads one customer's delivery history and their notes — the same facts the
  // stop card already shows whoever opened it.
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  const url = new URL(req.url);
  const q = (k: string) => (url.searchParams.get(k) || '').trim();
  // The key is derived with the SAME function the browser keys notes and pins by, so a key
  // typed by hand here and a key the map built cannot disagree about the same dock.
  const matchKey = q('matchKey')
    || (q('name') ? normalizeMatchKey(q('name'), q('addr1'), q('city'), q('zip')) : '');
  if (!matchKey) {
    return J({ ok: false, error: 'pass ?matchKey=… or ?name=…&addr1=…&city=…&zip=…' }, 400);
  }

  const [flag, customer, note, roster] = await Promise.all([
    getDoc(tractorLocPath(TENANT, matchKey)),
    getCustomerByMatchKey(TENANT, matchKey),
    getDoc(`customer_notes/${matchKey}`),
    loadTractorRoster(),
  ]);

  // Every delivery we have on file for this dock, newest first, with the roster's verdict on
  // the driver who ran it. This is the list that decides the flag, so printing it IS the
  // explanation — a count would only move the question one step back.
  const pros: any[] = Array.isArray(customer?.pros) ? customer.pros : [];
  const deliveries = pros
    .map((p: any) => {
      const driver = p?.driver ?? null;
      const alias = normalizeDriverAlias(driver);
      const known = !!alias && roster.aliasToName.has(alias);
      const isTractor = !!alias && roster.aliasSet.has(alias);
      return {
        pro: String(p?.pro ?? ''),
        date: String(p?.date ?? ''),
        driver,
        // WHY THIS DELIVERY DID OR DID NOT FLAG THE LOCATION.
        verdict: !driver ? 'no-driver-on-record'
          : isTractor ? 'tractor'
            : known ? 'not-a-tractor'
              : 'unknown-to-roster',
        rosterName: alias ? (roster.aliasToName.get(alias) ?? null) : null,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const tractorRuns = deliveries.filter((d) => d.verdict === 'tractor');
  const unknownDrivers = [...new Set(deliveries.filter((d) => d.verdict === 'unknown-to-roster').map((d) => d.driver))];

  // The map's own override, RUN rather than described: a confirmed blocker outranks proven
  // history, so a flagged location can still, correctly, not be lime.
  const restrictions: string[] = Array.isArray(note?.equipment_restrictions) ? note.equipment_restrictions : [];
  const paintAllowed = tractorPaintAllowed(note?.vehicle_eligibility ?? null, restrictions, note ?? null);

  // One sentence a person can act on. Ordered by what to DO about it, not by tidiness.
  const verdict = !flag && !deliveries.length
    ? 'No flag, and the warehouse holds no delivery at all for this match key — either nobody has delivered here since history capture began, or this dock resolves to a different match key (check the address the board is using against the one the deliveries were filed under).'
    : !flag && tractorRuns.length
      ? `The warehouse HAS ${tractorRuns.length} tractor delivery here and there is no flag — the daily pass missed it. Re-running tractor-flags-rebuild-background recomputes every location from the warehouse and would write it.`
      : !flag && unknownDrivers.length
        ? `No flag, and ${unknownDrivers.length} driver name(s) on these deliveries match no employee alias: ${unknownDrivers.join(', ')}. If any of them runs a tractor, add that NuVizz name to their employee card's aliases and re-run the rebuild — this is the Brent Boyd/Bryd failure.`
        : !flag
          ? 'No flag, and no delivery here was run by a tractor-tagged driver — the paint is correctly absent.'
          : !paintAllowed
            ? 'The location IS flagged, but a CONFIRMED trailer blocker on this customer vetoes the lime — that override is deliberate: proven history must never read as permission where somebody has said no.'
            : 'The location is flagged and nothing vetoes it — this stop should be painted. If it is not, the browser\'s tractor_locations fetch failed this session (the legend carries a Retry).';

  return J({
    ok: true,
    matchKey,
    verdict,
    flag: flag ? {
      first_tractor_date: flag.first_tractor_date ?? null,
      last_tractor_date: flag.last_tractor_date ?? null,
      tractor_drivers: flag.tractor_drivers ?? [],
      delivery_count: flag.delivery_count ?? 0,
      updated_at: flag.updated_at ?? null,
    } : null,
    paint: {
      allowed: paintAllowed,
      vehicle_eligibility: note?.vehicle_eligibility ?? null,
      equipment_restrictions: restrictions,
      manual_overrides: note?.manual_overrides ?? null,
      auto_sources: note?.auto_sources ?? null,
    },
    customer: customer ? { name: customer.name ?? null, addr1: customer.addr1 ?? null, city: customer.city ?? null, zip: customer.zip ?? null, last_date: customer.last_date ?? null } : null,
    deliveries,
    roster: {
      tractorEmployees: roster.tractorCount,
      // A tractor-tagged employee with no NuVizz alias can never join a delivery, so their
      // runs silently flag nothing. Named here because it is the one failure the join itself
      // cannot report.
      tractorTaggedWithNoAlias: roster.skippedNoAlias,
    },
    rebuild: 'POST /.netlify/functions/tractor-flags-rebuild-background (Firestore only, no NuVizz)',
  });
};
