// driver-phone.mts
//
// Resolve ONE driver's mobile number by name, so a stop's Route block can show who
// is carrying the order and offer their number as a tap-to-text.
//
//   GET /.netlify/functions/driver-phone?name=Michael%20Frye
//   → { ok, name, phone }   phone = normalized 10 digits, or null when nobody matches
//
// Why ask the server for a number the roster endpoint already serves in bulk: the
// name on a NuVizz load is not always the name on the MarginIQ employee card ("Mike
// Frye", "Frye, Michael"), which is exactly what that card's `aliases` are for — and
// resolveDriverPhone is the one matcher that reads them. Matching in the browser
// against messaging-roster's display names would silently miss the drivers who have
// an alias, which is the case aliases exist to cover.
//
// This only feeds the LABEL. Sending still goes by NAME through send-sms, which
// resolves the number again server-side, so a stale or wrong label can never
// misdirect a message.
//
// NOTE: like send-sms and messaging-roster, there is no app-level auth yet — this is
// only as private as the app URL. Lock it behind real auth with them.

import { resolveDriverPhone } from './lib/marginiq.mts';
import { isFirestoreEnabled } from './lib/firestore.mts';

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  const name = (new URL(req.url).searchParams.get('name') || '').trim();
  const reply = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status: 200, headers: cors });

  if (!name) return reply({ ok: false, error: 'name required', phone: null });

  // Degrade quietly: no roster configured just means no number to show. The Route
  // block hides the line rather than showing an error a dispatcher can't act on.
  if (!isFirestoreEnabled()) return reply({ ok: true, name, phone: null, note: 'firestore off' });

  try {
    const phone = await resolveDriverPhone(name);
    return reply({ ok: true, name, phone: phone || null });
  } catch (e: any) {
    return reply({ ok: false, name, phone: null, error: e?.message || 'lookup failed' });
  }
};
