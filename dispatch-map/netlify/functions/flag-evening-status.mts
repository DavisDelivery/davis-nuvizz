// flag-evening-status.mts — DID ANYTHING TEXT LAST NIGHT?
//
// The evening sweep runs while nobody is watching, so the only honest way to trust it is
// to be able to ask what it did. It writes nuvizz_ops/flag_evening_status__<date> on every
// fire and claims eta_flag_sms/{tenant}__{date}__{stopNbr} before each send; this reads
// both back over plain HTTP so "did my phone buzz, and about what" is one URL rather than
// a Firestore console trip.
//
//   GET ?date=YYYY-MM-DD   (default: today ET)
//
// The status doc is OVERWRITTEN each fire, so it reflects the LAST sweep — which is why
// the claims are read too: a claim is written once per stop per board day and survives
// every later sweep, so the claim list is the durable record of what was actually texted.
// A stop that texted at 2am and cleared by 6am appears in `claims` and NOT in the latest
// status — exactly the case worth being able to see.
//
// No cron on purpose: a scheduled Netlify function is not reachable over plain HTTP.
// Read-only, Firestore only, ZERO NuVizz calls. Never sends anything.
import { isFirestoreEnabled, getDoc, listDocs, etDayString } from './lib/firestore.mts';
import { CLAIM_COLLECTION } from './lib/flag-sms.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date') || etDayString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return J({ ok: false, error: 'bad ?date' }, 400);

    const status = await getDoc(`nuvizz_ops/flag_evening_status__${date}`).catch(() => null);

    // Claims are a flat collection keyed {tenant}__{date}__{stopNbr}; filter by that prefix
    // rather than assuming the collection only ever holds one day.
    const prefix = `${TENANT}__${date}__`;
    let claims: any[] = [];
    try {
      const all = await listDocs(CLAIM_COLLECTION);
      claims = (all || [])
        .filter((d: any) => String(d?._id || '').startsWith(prefix))
        .map((d: any) => ({ stopNbr: String(d._id).slice(prefix.length), ...d, _id: undefined }));
    } catch { /* a missing collection is the ordinary case on a quiet night */ }

    return J({
      ok: true, date,
      texted: claims.length,
      claims,
      lastSweep: status || null,
      note: status
        ? 'lastSweep is the MOST RECENT fire only; `claims` is the durable record of what texted'
        : 'no sweep has written a status doc for this date yet',
    });
  } catch (err: any) {
    return J({ ok: false, error: String(err?.message || err) }, 500);
  }
};
