// netlify/functions/osrm-status.mts
//
// IS THE TRUCK ROUTING SERVICE UP, AND CAN THIS SITE CALL IT? — without running a Build to find out.
//
// GET /.netlify/functions/osrm-status
//   One table call between two fixed points — the Buford terminal (DEPOT) and Lawrenceville
//   (33.9562, -83.9880) — with a 20 s timeout. It answers:
//     state       'off'    OSRM_TRUCK_URL is not set (or not an https address without a path)
//                 'ready'  the service answered; sample carries its miles and minutes
//                 'waking' it did not answer in time: Cloud Run is starting an instance. Ask again.
//                 'error'  anything else; `error` says what, in one line
//     host        the service's host name (never the token)
//     caller      the service account the token is signed for (client_email) — the account that
//                 needs Cloud Run Invoker on osrm-truck
//     httpStatus  the table call's status, when it got one
//     ms          how long the whole check took
//   A 401 says token or audience. A 403 says the caller lacks Cloud Run Invoker on osrm-truck.
//
// GET ?check=config answers { state: 'off' | 'set' } and CALLS NOTHING, so the Build Panel can ask
// on open without waking (or billing) the service.
//
// NEVER returns, logs or stores the ID token or the key. No Firestore write, no NuVizz call.
import { requireUser } from './lib/require-user.mts';
import { DEPOT } from './lib/routing-types.mts';
import { serviceAccountEmail } from './lib/google-id-token.mts';
import { osrmBaseUrl, fetchOsrmTable, OsrmError } from './lib/osrm-matrix.mts';

export const STATUS_TIMEOUT_MS = 20_000;
export const SAMPLE_POINT = Object.freeze({ lat: 33.9562, lng: -83.9880 }); // Lawrenceville

const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** PURE: one line for a failed check, in a dispatcher's words where the cause is known. */
export function statusError(e: any, caller: string | null): { state: 'waking' | 'error'; httpStatus: number | null; error: string } {
  const kind = e instanceof OsrmError ? e.kind : 'network';
  const status = e instanceof OsrmError ? e.status : null;
  if (kind === 'timeout') return { state: 'waking', httpStatus: null, error: 'No answer yet: Cloud Run is starting an instance. Ask again in a few seconds.' };
  if (kind === 'http' && status === 401) return { state: 'error', httpStatus: 401, error: 'The service refused the token (401): the token or its audience is wrong. The audience must be exactly the OSRM_TRUCK_URL address.' };
  if (kind === 'http' && status === 403) return { state: 'error', httpStatus: 403, error: `The caller lacks Cloud Run Invoker on osrm-truck (403)${caller ? `: grant it to ${caller}` : ''}.` };
  if (kind === 'token') return { state: 'error', httpStatus: null, error: String(e?.message || 'ID token exchange failed').slice(0, 160) };
  if (kind === 'http') return { state: 'error', httpStatus: status, error: `The service answered HTTP ${status}.` };
  return { state: 'error', httpStatus: kind === 'malformed' ? 200 : null, error: String(e?.message || e).slice(0, 160) };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  // User gate — inert until AUTH_REQUIRED=true on the site (lib/require-user.mts).
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  const base = osrmBaseUrl();
  const url = new URL(req.url);
  if (url.searchParams.get('check') === 'config') return json({ state: base ? 'set' : 'off' });

  const caller = serviceAccountEmail();
  if (!base) return json({ state: 'off', host: null, caller, httpStatus: null, ms: 0, sample: null, error: 'OSRM_TRUCK_URL is not set on this site (it must be an https address with no path).' });

  const host = new URL(base).host;
  const started = Date.now();
  try {
    const { answer, httpStatus } = await fetchOsrmTable({ lat: DEPOT.lat, lng: DEPOT.lng }, [SAMPLE_POINT], { timeoutMs: STATUS_TIMEOUT_MS });
    const ms = Date.now() - started;
    const sec = answer?.durations?.[0]?.[1], m = answer?.distances?.[0]?.[1];
    if (answer?.code !== 'Ok' || typeof sec !== 'number' || typeof m !== 'number' || !Number.isFinite(sec) || !Number.isFinite(m)) {
      return json({ state: 'error', host, caller, httpStatus, ms, sample: null, error: `The service answered, but not with a usable table (code ${JSON.stringify(answer?.code ?? null)}).` });
    }
    return json({ state: 'ready', host, caller, httpStatus, ms, sample: { miles: Math.round((m / 1609.344) * 10) / 10, minutes: Math.round((sec / 60) * 10) / 10 }, error: null });
  } catch (e: any) {
    const ms = Date.now() - started;
    const out = statusError(e, caller);
    console.error('osrm-status:', out.state, out.httpStatus ?? '', out.error);
    return json({ ...out, host, caller, ms, sample: null });
  }
}
