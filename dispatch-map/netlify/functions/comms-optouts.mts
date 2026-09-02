// comms-optouts.mts — who has asked us to stop sending delivery emails.
//
// Chad: "have somewhere... that shows us all the customers that have unsubscribed to these
// emails." Until now the flag was per-customer and invisible in aggregate: you could see it
// on one customer's notes card if you happened to open that customer, and nowhere else. So
// "who have we stopped emailing, and did they ask us to?" had no answer.
//
//   GET /api/comms-optouts        everyone currently suppressed, newest first
//
// A FILTERED QUERY, not a listing of customer_notes. That collection has a document per
// customer we have ever delivered to — thousands — and pulling all of them to find a few
// dozen would be slow, expensive, and would get slower every month. comms_opt_out is a
// single field, and Firestore indexes single fields automatically, so no composite index
// has to be created for this to work.
//
// Read-only. ZERO NuVizz calls, and it writes nothing.
import { isFirestoreEnabled, runQuery } from './lib/firestore.mts';
import { optOutRow, sortOptOuts } from './lib/unsubscribe.mts';
import { requireUser } from './lib/require-user.mts';

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), {
    status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  // Gate at viewer: this lists every customer who has opted OUT of delivery texts —
  // names and match keys — which is a mailing list of Davis's customers to anyone who
  // guesses the URL. Inert until AUTH_REQUIRED=true (lib/require-user.mts).
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;

  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    const url = new URL(req.url);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 500) || 500));

    const docs = await runQuery({
      from: [{ collectionId: 'customer_notes' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'comms_opt_out' },
          op: 'EQUAL',
          value: { booleanValue: true },
        },
      },
      limit,
    });

    const rows = sortOptOuts((docs || []).map(optOutRow));
    return J({
      ok: true,
      count: rows.length,
      // Split out because they are different facts. A customer who unsubscribed themselves
      // is a preference we must honour; one a dispatcher switched off is a decision Davis
      // made and may want to revisit. Reporting them as one number would hide both.
      byCustomer: rows.filter((r) => r.source === 'customer').length,
      byDispatcher: rows.filter((r) => r.source === 'dispatcher').length,
      // Set before this feature existed, so nothing recorded who did it. Counted separately
      // rather than guessed into either column — the list must never invent a customer
      // request that may not have happened.
      unrecorded: rows.filter((r) => !r.source).length,
      capped: rows.length >= limit,
      rows,
    });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
