// scan-activity.mts
//
// GET ?date=YYYY-MM-DD (defaults to today, ET) -> the dispatcher's daily view.
//
// Answers the questions a dispatcher actually asks each morning:
//   - which trucks has nobody touched?          (loads on the board, no session)
//   - who is halfway through?                   (open sessions)
//   - which closed short, or over?
//   - are the loaders and drivers using the app at all?
//   - which trucks did each person actually load?
//
// Reads the pre-built stop index and the scan-session docs. ZERO NuVizz calls.
//
// Dispatcher role required — it is a staff activity report.

import { listDocs, readStops, isFirestoreEnabled } from './lib/firestore.mts';
import { DRIVER_AUTH, authenticate, liveClaims, normalizeRole } from './lib/auth.mts';
import { toManifestStop, groupIntoLoads } from './lib/manifest.mts';
import { buildActivity } from './lib/activity.mts';
import { ok, bad, unauthorized, forbidden, etDayString, DATE_RE, viaProxy } from './lib/http.mts';

const TENANT = 'davis';
const SESSIONS = 'nuvizz_load_scans';

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return bad('GET only', 405);

  const gate = await liveClaims(authenticate(req));
  if (!gate.ok) {
    // A credential that was deactivated or demoted stops working on the NEXT
    // request, not at token expiry three months later.
    if (gate.reason === 'inactive') return forbidden('credential is not active');
    if (gate.reason === 'store-error') return bad('not configured', 503);
    return unauthorized();
  }
  const claims = gate.claims;
  if (!isFirestoreEnabled()) return bad('not configured', 503);
  if (claims.role !== 'dispatcher') return forbidden('dispatcher role required');

  const url = new URL(req.url);
  const date = String(url.searchParams.get('date') || etDayString());
  if (!DATE_RE.test(date)) return bad('date must be YYYY-MM-DD');

  console.log(`[scan-activity] ${date} via ${viaProxy(req) ? 'dispatch-map-proxy' : 'load-scan-direct'} by ${claims.sub}`);

  // The board first: loads come from here, not from the sessions, so a truck
  // nobody scanned is still on the list. That absence is the whole point.
  let stops: any[] = [];
  try {
    stops = await readStops(TENANT, date, {});
  } catch {
    stops = [];
  }
  const warn = () => {};
  const loads = groupIntoLoads(stops.map((s: any) => toManifestStop(s, warn))).map((l) => ({
    loadNbr: l.loadNbr,
    routeName: l.routeName,
    driverName: l.stops[0]?.raw?.driverName || l.stops[0]?.raw?.driverUserName || null,
    expectedPieces: l.expectedPieces,
    stopCount: l.stopCount,
    // The per-stop skeleton the drill-down reconciles against. Just what a
    // dispatcher needs to name a stop and judge it — not the whole cached row.
    stops: (l.stops || []).map((s: any) => ({
      stopNbr: s.stopNbr,
      businessName: s.businessName,
      expectedPieces: s.expectedPieces,
      isPickup: s.isPickup,
    })),
  }));

  const [allSessions, credDocs] = await Promise.all([listDocs(SESSIONS), listDocs(DRIVER_AUTH)]);
  const sessions = (allSessions || []).filter((s: any) => String(s?.date) === date && String(s?.tenant || TENANT) === TENANT);
  const creds = (credDocs || []).map((d: any) => ({
    driverNumber: String(d?._id ?? d?.driverNumber ?? ''),
    displayName: String(d?.displayName || ''),
    role: normalizeRole(d?.role),
    active: d?.active !== false,
    lastLoginAt: d?.lastLoginAt || null,
  }));

  return ok(buildActivity({ date, loads, sessions, creds }));
};
