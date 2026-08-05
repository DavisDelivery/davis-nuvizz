// activity.mts — what actually happened on the dock today.
//
// The dispatcher's daily question is not "is the data consistent" but "is
// anything going wrong right now": which trucks nobody has touched, who is
// halfway through, who closed short, and whether the loaders and drivers are
// using the app at all. Everything here is derived from the pre-built stop
// index and the scan-session docs. ZERO NuVizz calls.

export interface Worker {
  driverNumber: string;
  role: string;
  pieces: number;
  firstAt: string;
  lastAt: string;
}

/**
 * Record that someone touched this load, keeping everyone who did.
 *
 * The session doc used to carry a single `driverNumber`, overwritten on every
 * push — so when a loader loaded a truck and the driver later scanned it, the
 * loader vanished from the record and "which trucks did my loaders do" had no
 * answer. Each person is kept once, with their role, their first and last
 * touch, and a running piece count.
 */
export function mergeWorker(existing: any, entry: { driverNumber: string; role: string; pieces: number; at: string }): Worker[] {
  const list: Worker[] = Array.isArray(existing) ? existing.map((w) => ({ ...w })) : [];
  const key = String(entry.driverNumber);
  if (!key) return list;

  const found = list.find((w) => String(w.driverNumber) === key);
  if (found) {
    found.pieces = Number(found.pieces || 0) + Number(entry.pieces || 0);
    // Role can legitimately change between pushes (promoted mid-shift); the
    // latest is the truthful one for "who was doing what".
    found.role = entry.role || found.role;
    if (entry.at > String(found.lastAt || '')) found.lastAt = entry.at;
    if (!found.firstAt || entry.at < found.firstAt) found.firstAt = entry.at;
    return list;
  }
  list.push({
    driverNumber: key,
    role: entry.role || 'driver',
    pieces: Number(entry.pieces || 0),
    firstAt: entry.at,
    lastAt: entry.at,
  });
  return list;
}

export type LoadStatus = 'not_started' | 'in_progress' | 'closed_clean' | 'closed_short' | 'closed_over';

/**
 * One load's state, in the terms a dispatcher acts on.
 *
 * `not_started` is the one that matters most and is the easiest to miss: it
 * exists only as an absence — a load on the board with no session at all. A
 * screen built from sessions alone cannot show it, which is exactly the truck
 * that rolls out unscanned.
 */
export function loadStatus(session: any, expectedPieces: number): LoadStatus {
  if (!session) return 'not_started';
  const scanned = Number(session.scannedCount || 0);
  if (!session.closedAt) return 'in_progress';
  if (scanned < expectedPieces) return 'closed_short';
  if (scanned > expectedPieces) return 'closed_over';
  return 'closed_clean';
}

const nameOf = (creds: any[], driverNumber: string) => {
  const c = (creds || []).find((x) => String(x?.driverNumber) === String(driverNumber));
  return c?.displayName || driverNumber;
};

/**
 * Fold the board, the sessions and the credential list into one day's picture.
 *
 * Loads come from the BOARD, not from the sessions, so a truck nobody scanned
 * still appears. People come from the credential list, so a driver who never
 * opened the app still appears — silence is the signal, and a view built only
 * from activity would render both invisible.
 */
export function buildActivity({
  date,
  loads,
  sessions,
  creds,
}: {
  date: string;
  loads: Array<{ loadNbr: string; routeName?: string | null; driverName?: string | null; expectedPieces: number; stopCount: number }>;
  sessions: any[];
  creds: any[];
}) {
  const byLoad = new Map<string, any>();
  for (const s of sessions || []) {
    if (!s?.loadNbr) continue;
    byLoad.set(String(s.loadNbr), s);
  }

  const rows = (loads || []).map((l) => {
    const s = byLoad.get(String(l.loadNbr)) || null;
    const expected = Number(l.expectedPieces || 0);
    const scannedPieces = Number(s?.scannedPieces ?? s?.scannedCount ?? 0);
    const confirmedPieces = Number(s?.confirmedPieces || 0);
    const scannedCount = Number(s?.scannedCount || 0);
    const workers: Worker[] = Array.isArray(s?.workedBy) ? s.workedBy : [];

    return {
      loadNbr: String(l.loadNbr),
      routeName: l.routeName ?? null,
      driverName: l.driverName ?? null,
      stopCount: Number(l.stopCount || 0),
      expectedPieces: expected,
      scannedPieces,
      confirmedPieces,
      scannedCount,
      short: Math.max(0, expected - scannedCount),
      over: Math.max(0, scannedCount - expected),
      startedAt: s?.startedAt || null,
      closedAt: s?.closedAt || null,
      updatedAt: s?.updatedAt || null,
      sequenceChanged: s?.sequenceChanged === true,
      status: loadStatus(s, expected),
      workedBy: workers.map((w) => ({ ...w, displayName: nameOf(creds, w.driverNumber) })),
    };
  });

  // Who used the app today, and who did not. Built from the credential list so
  // the absentees are visible rather than merely missing.
  const workedByPerson = new Map<string, { loads: string[]; pieces: number; role: string }>();
  for (const r of rows) {
    for (const w of r.workedBy) {
      const k = String(w.driverNumber);
      if (!workedByPerson.has(k)) workedByPerson.set(k, { loads: [], pieces: 0, role: w.role });
      const e = workedByPerson.get(k)!;
      e.loads.push(r.loadNbr);
      e.pieces += Number(w.pieces || 0);
      e.role = w.role || e.role;
    }
  }

  const people = (creds || [])
    .filter((c) => c?.active !== false)
    .map((c) => {
      const w = workedByPerson.get(String(c.driverNumber));
      return {
        driverNumber: String(c.driverNumber),
        displayName: c.displayName || String(c.driverNumber),
        role: w?.role || c.role || 'driver',
        lastLoginAt: c.lastLoginAt || null,
        signedInToday: String(c.lastLoginAt || '').slice(0, 10) === date,
        usedAppToday: !!w,
        loads: w?.loads || [],
        pieces: w?.pieces || 0,
      };
    })
    .sort((a, b) => Number(b.usedAppToday) - Number(a.usedAppToday) || b.pieces - a.pieces || a.displayName.localeCompare(b.displayName));

  const count = (s: LoadStatus) => rows.filter((r) => r.status === s).length;

  return {
    date,
    loads: rows.sort((a, b) => a.loadNbr.localeCompare(b.loadNbr)),
    people,
    totals: {
      loadsOnBoard: rows.length,
      notStarted: count('not_started'),
      inProgress: count('in_progress'),
      closedClean: count('closed_clean'),
      closedShort: count('closed_short'),
      closedOver: count('closed_over'),
      piecesExpected: rows.reduce((n, r) => n + r.expectedPieces, 0),
      piecesScanned: rows.reduce((n, r) => n + r.scannedPieces, 0),
      piecesConfirmed: rows.reduce((n, r) => n + r.confirmedPieces, 0),
      peopleUsedApp: people.filter((p) => p.usedAppToday).length,
      loadersUsedApp: people.filter((p) => p.usedAppToday && p.role === 'loader').length,
      driversUsedApp: people.filter((p) => p.usedAppToday && p.role === 'driver').length,
      resequenced: rows.filter((r) => r.sequenceChanged).length,
    },
  };
}
