// load-assign.mts
//
// GET  ?shiftDay=YYYY-MM-DD  -> the assignments for a shift
// POST {shiftDay, loadNbr, loaders[]} -> assign or un-assign one load
//
// WHO SEES WHAT
//   dispatcher  every assignment, and the only role that may change one
//   loader      their own assignments — so the app can open on "your trucks"
//   driver      their own, for the same reason
//
// A loader with NO assignments still gets the full board from load-manifest.
// Assignment steers the work, it does not gate it: a truck that has to go out at
// 3am must never be un-loadable because nobody handed it out.
//
// ZERO NuVizz calls.

import { getDoc, updateDocSafely, isFirestoreEnabled } from './lib/firestore.mts';
import { authenticate, liveClaims } from './lib/auth.mts';
import { applyAssignment, loadsFor, type Assignment } from './lib/worklog.mts';
import { shiftDayString } from './lib/shift.mts';
import { ok, bad, json, unauthorized, forbidden, readJson, DATE_RE } from './lib/http.mts';

const ASSIGNMENTS = 'loadscan_assignments';
const TENANT = 'davis';

const docPath = (shiftDay: string) => `${ASSIGNMENTS}/${TENANT}__${shiftDay}`;

/** The map as stored, or an empty one — shared by the read path and the writer. */
const normalizeAssignments = (raw: any): Record<string, Assignment> =>
  raw && typeof raw === 'object' ? (raw as Record<string, Assignment>) : {};

async function readAssignments(shiftDay: string): Promise<Record<string, Assignment>> {
  return normalizeAssignments((await getDoc(docPath(shiftDay)))?.assignments);
}

export default async (req: Request): Promise<Response> => {
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

  const url = new URL(req.url);

  if (req.method === 'GET') {
    const shiftDay = String(url.searchParams.get('shiftDay') || shiftDayString());
    if (!DATE_RE.test(shiftDay)) return bad('shiftDay must be YYYY-MM-DD');

    const assignments = await readAssignments(shiftDay);

    // A loader is shown their own work, not the whole board's ownership. It is
    // not a secret, it is noise on a phone at 8pm.
    if (claims.role !== 'dispatcher') {
      const mine = loadsFor(assignments, claims.sub);
      return ok({
        shiftDay,
        mine,
        assignments: Object.fromEntries(mine.map((l) => [l, assignments[l]])),
      });
    }

    return ok({ shiftDay, assignments, mine: loadsFor(assignments, claims.sub) });
  }

  if (req.method !== 'POST') return bad('GET or POST only', 405);
  if (claims.role !== 'dispatcher') return forbidden('dispatcher role required to assign loads');

  const body = await readJson(req);
  const shiftDay = String(body?.shiftDay || shiftDayString());
  if (!DATE_RE.test(shiftDay)) return bad('shiftDay must be YYYY-MM-DD');

  // One change per call, or a batch — the dispatcher screen sends a batch when
  // it hands out a whole shift at once, and a single change on a tap.
  const changes: any[] = Array.isArray(body?.changes)
    ? body.changes
    : [{ loadNbr: body?.loadNbr, loaders: body?.loaders }];

  // The dispatcher screen fires one call per tap, so two quick taps used to read
  // the same assignment map and the second write dropped the first load's
  // loaders. Build the change against the map as it is at write time, and merge
  // into whoever landed first.
  let assignments: Record<string, Assignment> = {};
  const applied: string[] = [];
  const rejected: Array<{ raw: any; reason: string }> = [];

  const outcome = await updateDocSafely(docPath(shiftDay), (doc) => {
    assignments = normalizeAssignments(doc?.assignments);
    applied.length = 0;
    rejected.length = 0;
    for (const c of changes) {
      const loadNbr = String(c?.loadNbr ?? '').trim();
      if (!loadNbr) {
        rejected.push({ raw: c, reason: 'missing loadNbr' });
        continue;
      }
      if (!Array.isArray(c?.loaders)) {
        rejected.push({ raw: c, reason: `loaders must be an array for ${loadNbr}` });
        continue;
      }
      assignments = applyAssignment(assignments, {
        loadNbr,
        loaders: c.loaders,
        assignedBy: claims.sub,
      });
      applied.push(loadNbr);
    }
    return {
      tenant: TENANT,
      shiftDay,
      assignments,
      updatedAt: new Date().toISOString(),
      updatedBy: claims.sub,
    };
  });

  // Never a silent success: a dispatcher whose tap did not land must be told, or
  // a truck goes out with nobody assigned to it and the board says otherwise.
  if (outcome !== 'written') {
    return json({ ok: false, error: 'busy — another assignment landed first; retry', retryable: true }, 409);
  }

  return ok({ shiftDay, assignments, applied, rejected });
};
