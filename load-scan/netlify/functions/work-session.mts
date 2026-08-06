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

import { getDoc, setDoc, isFirestoreEnabled } from './lib/firestore.mts';
import { authenticate } from './lib/auth.mts';
import { mergeSession, normalizeEvent, type WorkSession } from './lib/worklog.mts';
import { ok, bad, unauthorized, readJson } from './lib/http.mts';

const WORKLOG = 'loadscan_worklog';
const TENANT = 'davis';

const docPath = (shiftDay: string) => `${WORKLOG}/${TENANT}__${shiftDay}`;

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return bad('POST only', 405);

  const claims = authenticate(req);
  if (!claims) return unauthorized();
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

  const written: string[] = [];
  for (const [shiftDay, events] of byDay) {
    const doc = await getDoc(docPath(shiftDay));
    let sessions: WorkSession[] = Array.isArray(doc?.sessions) ? doc.sessions : [];
    for (const e of events) sessions = mergeSession(sessions, e);

    await setDoc(docPath(shiftDay), {
      tenant: TENANT,
      shiftDay,
      sessions,
      updatedAt: new Date().toISOString(),
    });
    written.push(shiftDay);
  }

  return ok({ ok: true, shiftDays: written, accepted: incoming.length - rejected.length, rejected });
};
