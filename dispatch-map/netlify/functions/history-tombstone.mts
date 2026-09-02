// history-tombstone.mts — mark a date as deliberately having NO BOARD.
//
// THE HOLE THAT COULD NOT BE CLOSED. writeTombstone has existed since the warehouse-holes
// work and had ZERO callers — so a genuine holiday, a day Davis simply did not run, sat in
// the Capture health strip as a standing red "missing weekday" forever, with no way to say
// otherwise. The cost is not the red square. It is that a strip carrying permanent
// known-wrong reds stops being read at all, and then the REAL hole — the night the capture
// silently failed — is one more red among several nobody looks at any more.
//
// GET  ?date=YYYY-MM-DD&reason=...&dryRun=1   what would happen, writes nothing
// POST ?date=YYYY-MM-DD&reason=...            writes the tombstone
//
// POST-only for the write, and behind the same admin token as the other write endpoints.
// The dry run is deliberately open: a tool that acts on its own needs a way to ask what it
// is about to do without doing it, and that half is never the dangerous half.
//
// Firestore only. ZERO NuVizz calls.
import { isFirestoreEnabled, etDayString } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';
import { writeTombstone, tombstoneVerdict, getCaptureFailure } from './lib/history-seal.mts';
import { getManifest, listStops } from './lib/history-store.mts';
import { adminTokenOk } from './lib/customer-comms.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const J = (b: any, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);
  // User gate — inert until AUTH_REQUIRED=true on the site (lib/require-user.mts).
  const gate = await requireUser(req, { role: 'admin' });
  if (!gate.ok) return gate.response;

  try {
    const url = new URL(req.url);
    const date = String(url.searchParams.get('date') || '').trim();
    const reason = String(url.searchParams.get('reason') || '').trim();
    const dryRun = url.searchParams.get('dryRun') === '1' || req.method === 'GET';

    if (!DATE_RE.test(date)) return J({ ok: false, error: 'date=YYYY-MM-DD required' }, 400);
    // A tombstone says "this day ran with no board". Nobody can know that about a day that
    // has not happened yet — and a tombstone on a future date is read by the capture-health
    // strip as "nothing to capture", which would hide a real capture failure when that day
    // comes. Refused before the token check: the token decides who may write, not whether a
    // future day is a fact.
    if (date > etDayString()) return J({ ok: false, error: `date ${date} is in the future (ET today is ${etDayString()}) — a day that has not happened cannot be tombstoned` }, 400);

    // Read the day BEFORE deciding anything — the verdict is about what is actually there,
    // never about what the caller believes is there.
    const [manifest, stops, failure] = await Promise.all([
      getManifest(TENANT, date),
      listStops(TENANT, date),
      getCaptureFailure(TENANT, date),
    ]);
    const verdict = tombstoneVerdict(manifest, stops.length, reason);
    const found = {
      storedStops: stops.length,
      manifest: manifest ? { sealed: !!(manifest.verified || manifest.complete), no_board: !!manifest.no_board } : null,
      failureRecord: failure ? { stage: failure.stage ?? null, at: failure.at ?? null } : null,
    };

    if (dryRun) {
      return J({
        ok: true, dryRun: true, date, reason: reason || null, found,
        wouldWrite: verdict.ok,
        refusal: verdict.refusal ?? null,
      });
    }
    if (req.method !== 'POST') return J({ ok: false, error: 'POST to write a tombstone' }, 405);
    if (!adminTokenOk(req)) return J({ ok: false, error: 'not authorized' }, 403);
    if (!verdict.ok) return J({ ok: false, date, found, refusal: verdict.refusal }, 409);

    const res = await writeTombstone(TENANT, date, reason);
    // The write re-reads and re-judges, so a race between the dry run and the POST is
    // refused by the writer rather than trusted from here.
    if (!res.ok) return J({ ok: false, date, found, refusal: res.refusal }, 409);
    return J({ ok: true, date, reason, tombstoned: true, found });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
