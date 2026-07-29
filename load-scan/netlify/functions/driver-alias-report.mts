// driver-alias-report.mts
//
// GET ?days=14  (max 30)  -> the hand-mapping seeding table.
//
// Every DISTINCT driverUserName / driverName value on the stop index over the
// window, with how often each appeared, when it was last seen, and whether any
// credential already claims it. That is the table a dispatcher maps to driver
// numbers by hand. Nothing here auto-assigns anything — per the brief, alias
// resolution is not an algorithm in Phase 1.
//
// Reads the pre-built index only. ZERO NuVizz calls. Weekends are skipped (Davis
// does not dispatch them) so the window buys more real signal per read.
//
// Dispatcher role required — the output is effectively a staff roster.

import { readStops, listDocs, isFirestoreEnabled } from './lib/firestore.mts';
import { DRIVER_AUTH, authenticate } from './lib/auth.mts';
import { normalizeDriverAlias } from './lib/aliases.mts';
import { ok, bad, unauthorized, forbidden, etDayString } from './lib/http.mts';

const TENANT = 'davis';

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isWeekend = (dateStr: string) => {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return bad('GET only', 405);
  // Authenticate BEFORE any configuration check: a caller with no token must not
  // be able to learn whether this site is configured.
  const claims = authenticate(req);
  if (!claims) return unauthorized();

  if (!isFirestoreEnabled()) return bad('not configured', 503);
  if (claims.role !== 'dispatcher') return forbidden('dispatcher role required');

  const url = new URL(req.url);
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days') || 14) || 14));
  const anchor = etDayString();

  // alias -> stats
  const seen = new Map<string, {
    alias: string;
    count: number;
    firstSeen: string;
    lastSeen: string;
    columns: Set<string>;
    sampleLoads: Set<string>;
  }>();

  const daysRead: string[] = [];
  const daysSkipped: string[] = [];

  for (let i = 0; i < days; i++) {
    const date = addDays(anchor, -i);
    if (isWeekend(date)) {
      daysSkipped.push(date);
      continue;
    }
    let stops: any[] = [];
    try {
      stops = await readStops(TENANT, date, { mask: ['driverUserName', 'driverName', 'loadNbr'] });
    } catch {
      daysSkipped.push(date);
      continue;
    }
    if (!stops.length) {
      daysSkipped.push(date);
      continue;
    }
    daysRead.push(date);

    for (const s of stops) {
      for (const [col, val] of [['driverUserName', s?.driverUserName], ['driverName', s?.driverName]] as const) {
        const alias = normalizeDriverAlias(val);
        if (!alias) continue;
        if (!seen.has(alias)) {
          seen.set(alias, { alias, count: 0, firstSeen: date, lastSeen: date, columns: new Set(), sampleLoads: new Set() });
        }
        const e = seen.get(alias)!;
        e.count++;
        e.columns.add(col);
        if (date < e.firstSeen) e.firstSeen = date;
        if (date > e.lastSeen) e.lastSeen = date;
        if (e.sampleLoads.size < 3 && s?.loadNbr) e.sampleLoads.add(String(s.loadNbr));
      }
    }
  }

  // Which aliases are already claimed, and by whom.
  const creds = await listDocs(DRIVER_AUTH);
  const claimed = new Map<string, string[]>();
  for (const c of creds) {
    for (const a of Array.isArray(c?.nuvizzAliases) ? c.nuvizzAliases : []) {
      const k = normalizeDriverAlias(a);
      if (!k) continue;
      if (!claimed.has(k)) claimed.set(k, []);
      claimed.get(k)!.push(String(c._id || c.driverNumber || ''));
    }
  }

  const rows = [...seen.values()]
    .map((e) => ({
      alias: e.alias,
      // A value seen in driverUserName only, on a NuVizz-scanned stop, is most
      // likely the stable short code. One seen in driverName too is likely the
      // full name. Both are legitimate alias-set members; this is a hint for the
      // human doing the mapping, not a decision.
      looksLike: e.columns.has('driverUserName') && !e.columns.has('driverName')
        ? 'short_code'
        : e.columns.has('driverUserName')
          ? 'both_columns'
          : 'full_name_only',
      stops: e.count,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      sampleLoads: [...e.sampleLoads],
      claimedBy: claimed.get(e.alias) || [],
      needsMapping: !(claimed.get(e.alias) || []).length,
    }))
    .sort((a, b) => b.stops - a.stops || a.alias.localeCompare(b.alias));

  return ok({
    window: { anchor, days, daysRead, daysSkipped },
    distinctAliases: rows.length,
    needsMapping: rows.filter((r) => r.needsMapping).length,
    rows,
  });
};
