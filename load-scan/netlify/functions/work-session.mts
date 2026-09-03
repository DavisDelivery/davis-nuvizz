// work-session.mts
//
// POST {events:[{kind:'start'|'finish', worker, loadNbr, at, ...}]}
//
// The clock on the dock. A phone posts 'start' when a loader picks up a truck
// and 'finish' when they close it out, and both go into the shift day's worklog.
//
// IDEMPOTENT by (worker, loadNbr) — see mergeSession. The queue replays, so this
// endpoint is called with the same events repeatedly and must converge on the
// same answer every time.
//
// The SHIFT DAY IS DERIVED SERVER-SIDE from each event's own timestamp. A phone
// that has been offline since 7:50pm and flushes at 8:05pm must file its work
// under the shift it actually happened in, not the one it reconnected in.
// Because of that a single request can legitimately touch two shift-day docs,
// so events are grouped by shift day before writing.
//
// ZERO NuVizz calls.

import { updateDocSafely, isFirestoreEnabled } from './lib/firestore.mts';
import { authenticate, liveClaims } from './lib/auth.mts';
import { mergeSession, normalizeEvent, type WorkSession } from './lib/worklog.mts';
import { ok, bad, json, unauthorized, forbidden, readJson } from './lib/http.mts';

const WORKLOG = 'loadscan_worklog';
const TENANT = 'davis';

const docPath = (shiftDay: string) => `${WORKLOG}/${TENANT}__${shiftDay}`;

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return bad('POST only', 405);

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

  const body = await readJson(req);
  const incoming: any[] = Array.isArray(body?.events) ? body.events : [body];

  // Group by shift day first: one flush can straddle the 8pm rollover.
  const byDay = new Map<string, Array<Partial<WorkSession>>>();
  const rejected: Array<{ raw: any; reason: string }> = [];

  for (const raw of incoming) {
    // The worker is taken from the TOKEN, never from the body. A phone cannot
    // file work under someone else's number, by accident or otherwise.
    const { session, shiftDay, reason } = normalizeEvent({
      ...raw,
      worker: claims.sub,
      workerName: raw?.workerName || claims.name || '',
      role: claims.role,
    });
    if (!session || !shiftDay) {
      rejected.push({ raw, reason: reason || 'unknown' });
      continue;
    }
    const list = byDay.get(shiftDay) ?? [];
    list.push(session);
    byDay.set(shiftDay, list);
  }

  // ONE document holds the whole shift's clock-ins, so two people starting a
  // truck at the same moment both read it, both merged only their own event, and
  // the second write erased the first: a start that was never recorded, and no
  // way to tell afterwards. Compare-and-swap, and merge into whoever won.
  const written: string[] = [];
  const conflicted: string[] = [];
  for (const [shiftDay, events] of byDay) {
    const outcome = await updateDocSafely(docPath(shiftDay), (doc) => {
      let sessions: WorkSession[] = Array.isArray(doc?.sessions) ? doc.sessions : [];
      for (const e of events) sessions = mergeSession(sessions, e);
      return { tenant: TENANT, shiftDay, sessions, updatedAt: new Date().toISOString() };
    });
    if (outcome === 'written') written.push(shiftDay);
    else conflicted.push(shiftDay);
  }

  // Never a silent success: the phone retries what did not land.
  if (conflicted.length) {
    return json({ ok: false, error: 'busy — another write for this shift landed first; retry', retryable: true, conflicted, shiftDays: written }, 409);
  }
  return ok({ ok: true, shiftDays: written, accepted: incoming.length - rejected.length, rejected });
};
