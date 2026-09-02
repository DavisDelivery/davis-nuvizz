// nuvizz-attempts.mts  (Attempts — read endpoint for the driver scorecard)
//
// Fast, CORS-enabled read of the per-day attempts list written by the evening scan
// (nuvizz-att-scan-background). Returns instantly from Firestore — no NuVizz traffic.
// Consumed by the EXTERNAL driver-scorecard site (davis-driver-scorecard.netlify.app),
// so it sends a permissive Access-Control-Allow-Origin like the other read feeds.
//
// Query params:
//   date=YYYY-MM-DD   optional; defaults to today (ET). Browse history by passing a date.
//   driver=NAME       optional; filter to one driver (matches original driver
//                     userName OR name, case-insensitive substring).
//
// Response: { ok, date, generated, manifest, count, attempts[] }
//   attempts[] items: { stopNbr, shipmentNbr, originalDriverName, originalDriverUserName,
//                       originalLoadNbr, routeName, businessName, addr1, city, state, zip,
//                       currentStatus, currentlyUnplanned, matched, detectedAt }

import { isFirestoreEnabled, etDayString } from './lib/firestore.mts';
import { requireUser } from './lib/require-user.mts';
import { getAttemptsManifest, listAttemptItems, deleteAttemptItem } from './lib/attempts-store.mts';

const TENANT = 'davis';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The stopNbr on a delete becomes a Firestore document path (attempts/{day}/items/{stopNbr}).
// Real stop numbers are digits (zero-padded PROs) or short carrier keys like AVRT-0028093763;
// anything with a '/', '?', or '..' in it is not a stop number, it is a path. Exported for tests.
export const STOP_NBR_RE = /^[A-Za-z0-9._-]{1,64}$/;

export default async (req: Request): Promise<Response> => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    // 'Authorization' added because WITHOUT IT THE GATE BELOW IS UNREACHABLE FROM OFF-SITE.
    // The non-GET gate has shipped since the auth work started, but the preflight only ever
    // allowed Content-Type — so a cross-origin DELETE carrying a bearer token was refused by
    // the BROWSER before it left, and that would have been "delete does nothing and the console
    // says CORS", the hardest kind of failure to diagnose from a screenshot.
    //
    // NECESSARY, NOT SUFFICIENT — do not read this line as "the scorecard's delete is fixed".
    // It opens the door; nothing walks through it yet. The scorecard's own delete
    // (docs/scorecard-attempts/AttemptsCard.jsx:92) is a bare `fetch(url, {method:'DELETE'})`
    // with no header, and that site holds no dispatch-map session it could put in one. So the
    // DELETE still 401s the day AUTH_REQUIRED flips. See the block below for the decision that
    // has to be made first, and when.
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });

  // Deleting a row is a dispatcher's act; reading the day is not gated.
  //
  // THE GET STAYS OPEN, ON PURPOSE, AND THIS IS THE ONE ENDPOINT HERE WITH AN OUTSIDE CONSUMER.
  // davis-driver-scorecard.netlify.app reads this day feed cross-origin (its client lives in
  // this repo at docs/scorecard-attempts/AttemptsCard.jsx), and that site holds no dispatch-map
  // session — there is no account for it to sign in as. So gating the GET would not tighten a
  // door, it would break the driver scorecard.
  //
  // ── OPEN DECISION — OWNER: CHAD. DUE BEFORE AUTH_REQUIRED=true IS SET. ──────────────
  //
  // This is not a settled state and it is not open-ended: it has a deadline, and the deadline
  // is the switch itself, because the day it flips BOTH of these break on the other site with
  // no error anybody over there will see:
  //   • the DELETE (AttemptsCard.jsx:92) sends no credential at all → 401, and the row a
  //     dispatcher removed on the scorecard silently stays;
  //   • the GET keeps working only for as long as it stays ungated — and it is the one feed
  //     here that names customers, addresses and drivers to the open internet.
  //
  // The two ways to close it, either of which settles both halves:
  //   (a) GIVE THE SCORECARD A CREDENTIAL — a machine account with the dispatcher role, or a
  //       shared key checked here — and change AttemptsCard.jsx to send it. Keeps the feed
  //       private and keeps delete working.
  //   (b) ACCEPT THE FEED AS PUBLIC, and then trim the response to what a public feed may
  //       say (drop customer name, address and driver identity) and move the delete into the
  //       dispatch app, where there IS a session.
  //
  // Do NOT flip AUTH_REQUIRED before one of those has been done. Put it on the flip checklist,
  // not on a list of things to look at afterwards: after the flip the failure is silent, on a
  // site nobody in this repo is watching.
  if (req.method !== 'GET') {
    const gate = await requireUser(req, { role: 'dispatcher' });
    if (!gate.ok) return gate.response;
  }
  const url = new URL(req.url);
  const qDate = url.searchParams.get('date');
  const date = qDate && DATE_RE.test(qDate) ? qDate : etDayString();
  const driver = (url.searchParams.get('driver') || '').trim().toLowerCase();

  // ── delete a row ────────────────────────────────────────────────────────────
  // DELETE ?date=…&stopNbr=…   (the REST verb)         or, curl/browser-friendly,
  // POST   ?date=…&delete=…    (?delete=<stopNbr>).    Removes one item from the
  // day's attempts list and recomputes the manifest counts.
  const delStop = (req.method === 'DELETE'
    ? (url.searchParams.get('stopNbr') || url.searchParams.get('stop'))
    : (req.method === 'POST' ? url.searchParams.get('delete') : null)) || '';
  if (delStop) {
    if (!STOP_NBR_RE.test(String(delStop).trim())) {
      return new Response(JSON.stringify({ ok: false, error: 'stopNbr must be 1-64 of A-Z a-z 0-9 . _ -' }), { status: 400, headers: cors });
    }
    if (!isFirestoreEnabled()) {
      return new Response(JSON.stringify({ ok: false, error: 'firestore-disabled' }), { status: 200, headers: cors });
    }
    try {
      const res = await deleteAttemptItem(TENANT, date, String(delStop).trim());
      return new Response(JSON.stringify({ ok: true, date, stopNbr: String(delStop).trim(), ...res }), {
        status: 200, headers: cors,
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ ok: false, date, error: e?.message || 'delete failed' }), {
        status: 500, headers: cors,
      });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ ok: false, error: 'method not allowed (DELETE needs ?stopNbr=, POST needs ?delete=)' }), {
      status: 405, headers: cors,
    });
  }

  try {
    if (!isFirestoreEnabled()) {
      return new Response(JSON.stringify({
        ok: true, date, generated: new Date().toISOString(),
        manifest: null, count: 0, attempts: [], note: 'firestore-disabled',
      }), { status: 200, headers: cors });
    }

    const [manifest, items] = await Promise.all([
      getAttemptsManifest(TENANT, date),
      listAttemptItems(TENANT, date),
    ]);

    // Strip the internal _id; sort newest-detected first then by driver for a stable,
    // readable order. Optional driver filter for a per-driver scorecard view.
    let attempts = items
      .map(({ _id, ...rest }) => rest)
      .sort((a: any, b: any) =>
        String(b.detectedAt || '').localeCompare(String(a.detectedAt || '')) ||
        String(a.originalDriverName || '').localeCompare(String(b.originalDriverName || '')));
    if (driver) {
      attempts = attempts.filter((a: any) =>
        String(a.originalDriverUserName || '').toLowerCase().includes(driver) ||
        String(a.originalDriverName || '').toLowerCase().includes(driver));
    }

    return new Response(JSON.stringify({
      ok: true,
      date,
      generated: new Date().toISOString(),
      manifest: manifest || null,
      count: attempts.length,
      attempts,
    }), { status: 200, headers: cors });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, date, error: e?.message || 'error' }), {
      status: 500, headers: cors,
    });
  }
};
