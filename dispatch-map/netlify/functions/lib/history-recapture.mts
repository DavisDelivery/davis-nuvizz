// lib/history-recapture.mts
//
// WHAT A HAND-DRIVEN RE-CAPTURE OF A PAST DAY WOULD SEAL — asked before anything is written.
//
// The nightly capture reads the day's board index (nuvizz_stop_index/{tenant}__{date}) a few
// hours after that day's last scan and seals it "as of the last scan" — the manifest stamps
// source_scanned_at from the index meta. That holds at 02:00 ET. It stops holding later, because
// two writers keep patching a past day's index rows after its last scan WITHOUT touching the
// meta doc:
//   • the frozen-day heal (refile-core healFields) writes a stop's LATER status, route, driver
//     and deliveredDTTM onto the day it used to sit on, stamped frozen_heal_at;
//   • a dispatcher's confirmed Save (firestore.mts boardWrite*Fields) stamps board_write_at.
// Read from Firestore on 2026-09-27 (audit gap-settle-env-from-evidence-01): Sep 24's index held
// 82 rows healed after its last scan, all but one DELIVERED on Sep 25; Sep 10 held 72 heals and
// 9 board writes, Sep 11 91 and 2. None were in the nightly capture. A re-capture run today would
// seal every one of them into the origin day as if it happened there. The audit split the heals
// two ways: already archived, where the stop write REPLACES a correct nightly-time record with the
// later outcome (Sep 24: 19, Sep 10: 24, Sep 11: 25), and never saved, written for the first time
// with the later outcome (63, 48, 68; Sep 10's split covers its 72 heals, not its 9 board writes).
// The rest of the archive (588 of Sep 24's 849 are on disk) would be rewritten from rows this count
// does not flag. Running it again would not repair any of it. The dry run reports the same split
// (index.patched_already_archived / patched_not_archived) from the live data.
//
// So a re-capture that NAMES ITS DAY (?date= / ?from=&to=) now REFUSES, writing nothing, when
// either count below is non-zero, and says the numbers. What to do with those rows — drop them,
// restore them from the archive, keep them — is Chad's decision; this module does not make it
// (the policy is built in a separate change; until it lands, this refusal is what runs). The
// scheduled nightly run is not refused; it records the first count on its manifest.
//
// ONLY A RUN THAT NAMES ITS DAY IS CHECKED. A POST with no query string is the 2 AM run as far as
// the code can tell: Netlify's cron sends no query string (background-gate.mts), isManualCapture
// (history-core) keys on ?date= / ?from= / ?to= alone, and nothing reads anything else the cron
// might send. So that POST is neither refused nor checked. It re-captures ET-yesterday exactly as
// the 2 AM run does — from the index as it stands, or where the capture would scan, from a NuVizz
// scan — and overwrites every archived stop it writes again. Sent the morning after a failed
// night (the function's runbook: "No query string → captures ET-yesterday"), on the index path
// that is the failed day with the morning's heals sealed into it — the damage this module exists
// to stop. A failed night, last night included, is re-run by hand only with ?date=. Whether a
// no-query run should be checked too is Chad's call, not this module's.
//
// THIS REACHES EVERY FUTURE BAD NIGHT re-run by ?date=, not only Sep 10/11/24: a night that fails
// partway (a 429, or the ten-minute retry deadline in history-store) leaves a partial archive, so
// a re-run that names its day is refused on the archive count alone until that policy is built.
// AND IT IS NOT ONLY PARTLY-SAVED DAYS: the changed-rows count refuses on its own, archive or no
// archive, and the heal patches a past day's rows after its last scan — the audit's Firestore
// reads counted 72 to 91 heals after the day's nightly capture on each of the four days read
// (Sep 10: 72, Sep 11: 91, Sep 23: 83, Sep 24: 82). So a night that saves nothing at all
// (Firestore refusing every write until the deadline, or a scan-path night stopped by
// scanIncomplete) is refused on a re-run that names its day once the heal has patched its rows —
// on every one of those four days that count alone would have refused it. A refusal writes
// nothing, so the capture-health strip keeps showing the day's old state; the reason is in the
// function log and in history-capture-health?recapture=YYYY-MM-DD.
//
// WHAT IT CAN SEE: the two stamps above, and — from the meta it already reads — how many rows
// the index gained or lost since the last scan. What it CANNOT see (a removed row's identity,
// unstamped patches, note refreshes) is listed in NOT_COUNTED and printed in every dry run, so a
// "would proceed" says what was checked and nothing more.
//
// Firestore READS only. It imports no NuVizz module and makes no write.
//
// THE WAY BACK: HISTORY_RECAPTURE_GUARD. House shape — on unless off/0/false/no, malformed stays
// ON. Off puts back the old behaviour for a re-capture that names its day: no refusal, the index
// is copied as it stands and archived stops are overwritten. The dry run keeps reporting either way.

import { readStops } from './firestore.mts';
import { getManifest, listStops, histDocId, historyWriteRetryEnabled } from './history-store.mts';

export function recaptureGuardEnabled(env: any = process.env): boolean {
  const v = String(env?.HISTORY_RECAPTURE_GUARD ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

// The same test history-core has always used for lean discovery — no trim, exact 'on' — so the
// dry run and the capture cannot disagree about which path a day takes.
export function leanHistoryOn(env: any = process.env): boolean {
  return String(env?.NUVIZZ_LEAN_DISCOVERY || '').toLowerCase() === 'on';
}

/** PURE: is this index read one the capture may copy instead of scanning NuVizz? Exactly
 *  history-core's rule: non-empty, has a last scan, and that scan was not halted. */
export function indexUsable(idx: { meta?: any; stops?: any[] } | null | undefined): boolean {
  return !!(idx && Array.isArray(idx.stops) && idx.stops.length && idx.meta?.last_scanned_at && !idx.meta?.scanState?.halted);
}

// The call estimate for the scan path, as the capture's own file states it — NOT measured. The
// same file also says ~1,200 for a weekend day and CLAUDE.md puts a cold full scan at ~3,000;
// which one a given day would cost is not knowable without running it.
export const SCAN_CALL_ESTIMATE = '~690 NuVizz calls (the estimate history-core.mts states for the nightly scan; not measured — the same file says ~1,200 for a weekend day, CLAUDE.md ~3,000 for a cold full scan)';

// WHEN A RUN WOULD SCAN, THE ONE-LINE ANSWER SAYS SO. nuvizz_calls_if_run already carried the
// estimate, but the verdict is the sentence a person reads before deciding, and "WOULD PROCEED"
// on its own left out the one thing that path spends. Said on every forecast of a run that would
// go ahead on the scan path — a proceed, the guard-off forecast, and the nightly / no-query
// forecast — and never on a refusal, which stops before the scan and spends nothing. The
// permission is the repo's rule (CLAUDE.md, the NuVizz cost rule), not something this code checks.
export const SCAN_NOTE = ` This run would scan NuVizz: ${SCAN_CALL_ESTIMATE}. Started by hand, that scan needs Chad's per-request permission (CLAUDE.md's NuVizz cost rule), and what it returns for the day cannot be known without running it.`;

// A refusal forecast is the answer for a run that NAMES the day. A POST with no query string is
// the 2 AM run as far as the code can tell and is not checked (see the header), so "WOULD BE
// REFUSED" must not read as covering every way a person can re-run the day.
export const NAMED_DAY_NOTE = ` Only a run that names its day (?date=) is checked: a POST with no query string is the 2 AM run as far as the code can tell, and it is not.`;

const present = (v: any) => v !== undefined && v !== null && String(v).trim() !== '';

// A stamp is a time only if it is an ISO-8601 date-time, which is what every writer of these
// fields stores (new Date().toISOString(): the scan's scannedAt that the heal stamps, and every
// patchBoardPlan caller's `at`). Date.parse alone is too forgiving to be the test — it reads
// "Sept 25" as 2001-09-25, which would make a mangled stamp look EARLIER than the scan and let
// its row be sealed as clean.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
export function isoTimeMs(v: any): number {
  if (typeof v !== 'string' || !ISO_TIME.test(v.trim())) return NaN;
  return Date.parse(v.trim());
}

export interface PatchCount {
  rows: number;              // index rows the capture would write (those with a stopNbr)
  lastScannedAt: string | null;
  known: boolean;            // false = no readable last scan time, so "after it" cannot be told
  patched: number;           // rows changed after the last scan, by either writer
  byFrozenHeal: number;
  byBoardWrite: number;
  unreadable: number;        // rows carrying a stamp that is not a readable time
  sample: string[];          // up to 10 stop numbers, for a person to look up
  ids: string[];             // every patched row's stop number (for the archived / not-archived split)
}

/**
 * PURE. How many of the rows a capture would write were changed on the index AFTER that day's
 * last scan — frozen_heal_at or board_write_at later than meta.last_scanned_at. A row counts once
 * even when both stamps are late. A missing stamp is not a patch; a stamp that is present but
 * not a time is counted as unreadable (it cannot be shown to be earlier), never as zero.
 */
export function patchedAfterLastScan(stops: any[], lastScannedAt: any): PatchCount {
  const rows = (Array.isArray(stops) ? stops : []).filter((s) => s && present(s.stopNbr));
  const scanMs = present(lastScannedAt) ? isoTimeMs(lastScannedAt) : NaN;
  const out: PatchCount = {
    rows: rows.length, lastScannedAt: present(lastScannedAt) ? String(lastScannedAt) : null,
    known: Number.isFinite(scanMs), patched: 0, byFrozenHeal: 0, byBoardWrite: 0, unreadable: 0, sample: [], ids: [],
  };
  if (!out.known) return out;
  for (const s of rows) {
    let late = false, bad = false;
    for (const [field, key] of [['frozen_heal_at', 'byFrozenHeal'], ['board_write_at', 'byBoardWrite']] as const) {
      if (!present(s[field])) continue;
      const t = isoTimeMs(s[field]);
      if (!Number.isFinite(t)) { bad = true; continue; }
      if (t > scanMs) { out[key]++; late = true; }
    }
    if (bad) out.unreadable++;
    if (late) {
      out.patched++;
      out.ids.push(String(s.stopNbr));
      if (out.sample.length < 10) out.sample.push(String(s.stopNbr));
    }
  }
  return out;
}

/**
 * PURE. What the capture records as `patched_after_last_scan`, decided by where its rows came
 * from. On the index path the count is the stamp count above (null when the last scan time
 * cannot be read — never 0). On the SCAN path the rows came from NuVizz, not the index, so the
 * question does not apply and the answer is null: recording 0 there would put "nothing was
 * changed" on a permanent manifest about rows nobody looked at (Number(null) is 0 is the same
 * lie). `patched` is the full count for the re-capture guard; null on the scan path.
 */
export function patchedForCapture(
  source: 'firestore-index' | 'scan', stops: any[], sourceScannedAt: any,
): { patched: PatchCount | null; count: number | null } {
  if (source !== 'firestore-index') return { patched: null, count: null };
  const patched = patchedAfterLastScan(stops, sourceScannedAt);
  return { patched, count: patched.known ? patched.patched : null };
}

export interface RowCount {
  atLastScan: number | null;   // meta.count — the rows the day's last scan left on the index; null = not readable
  now: number;                 // the rows the index holds now
  difference: number | null;   // now − atLastScan; negative = rows gone since; null = cannot be told
}

/**
 * PURE. Rows added to or removed from the day's index since its last scan — for ZERO extra
 * reads, from the meta doc the guard already reads. writeStops (firestore.mts) writes the meta
 * LAST, with count = the rows that scan wrote + the rows it kept (the rest it deleted), so at
 * that moment count is the rows on the index. Nothing else on production rewrites count:
 * markScanState copies the old meta forward, markCompletedScan patches one other field (uat-seed
 * recounts it, on the mirror database only, which production cannot reach). A row removed afterwards
 * leaves no stamp on the day it left — moveBoardStopDay (a confirmed date change) DELETES the
 * row from its old day, and the stamp count cannot see a row that is gone. On the four days read
 * on 2026-09-26 (Sep 10, 11, 23, 24) count equalled the rows (850, 900, 906, 849).
 * A difference is REPORTED, never refused on: a moved stop leaves no stamp, and the count says
 * how many rows left or joined the day, not which. Two rows with one stop number in a single scan
 * would also count twice against one document; the code does not show whether a scan can hand
 * writeStops that, so a difference is "changed since the last scan, or a duplicate at it", not
 * proof of which.
 */
export function rowCountSinceLastScan(meta: any, stops: any[]): RowCount {
  const now = Array.isArray(stops) ? stops.length : 0;
  const raw = meta?.count;
  const n = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
  const atLastScan = Number.isInteger(n) && n >= 0 ? n : null;
  return { atLastScan, now, difference: atLastScan == null ? null : now - atLastScan };
}

/**
 * PURE. The rows changed after the last scan, split by whether the day's archive already holds
 * them — the two groups a re-run would damage differently. `alreadyArchived`: a correct
 * nightly-time record is on disk and a re-run would REPLACE it with the later outcome.
 * `notArchived`: never saved, so a re-run would write it for the FIRST time, with the later
 * outcome. Ids compared the way the stop writer keys them; a stop number twice is one document.
 */
export function splitPatchedByArchive(patchedIds: string[], archivedIds: Iterable<string>): { alreadyArchived: number; notArchived: number } {
  const have = new Set(Array.from(archivedIds || [], (x) => String(x)));
  const docs = new Set((Array.isArray(patchedIds) ? patchedIds : []).filter(present).map((n) => histDocId(String(n))));
  let alreadyArchived = 0;
  for (const id of docs) if (have.has(id)) alreadyArchived++;
  return { alreadyArchived, notArchived: docs.size - alreadyArchived };
}

/** PURE. How many archived stop docs a capture writing `rows` would REPLACE. Ids compared the
 *  way the stop writer keys them (histDocId of the stopNbr). */
export function archivedOverwrites(rows: any[], archivedIds: Iterable<string>): number {
  const have = new Set(Array.from(archivedIds || [], (x) => String(x)));
  const seen = new Set<string>();
  for (const s of Array.isArray(rows) ? rows : []) {
    if (!s || !present(s.stopNbr)) continue;
    const id = histDocId(String(s.stopNbr));
    if (have.has(id)) seen.add(id);
  }
  return seen.size;
}

/**
 * `message` is what a REAL run says — the refusal captureDate logs and returns, written after it
 * has stopped. `forecast` is what a DRY RUN says about a run that has not happened: it may never
 * claim a refusal took place or that anything "was written" or not (CLAUDE.md, never report an
 * intent as an outcome — the dry run is read by a person deciding whether to run it).
 */
export interface RecaptureVerdict { refuse: boolean; reasons: string[]; message: string; forecast: string }

// What the guard actually checked, in words — the only thing a "would proceed" may claim.
const CHECKED = 'no index row carries a frozen-day-heal or board-write stamp later than the last scan, and no archived stop would be overwritten';

/** The row-count sentence both texts carry when there is something to say (see rowCountSinceLastScan). */
function rowCountNote(rc: RowCount | null | undefined): string {
  if (!rc) return '';
  if (rc.difference == null) return ` The day's index meta carries no readable row count, so rows added to or removed from the day since its last scan cannot be told.`;
  if (rc.difference === 0) return '';
  const d = rc.difference;
  return ` The index holds ${rc.now} row(s) where the day's last scan left ${rc.atLastScan}: ${Math.abs(d)} ${d < 0 ? 'fewer' : 'more'} since, which the stamp count cannot see (a confirmed date move deletes the row from its old day and stamps nothing there). That difference is reported here, not refused on.`;
}

/**
 * PURE. Whether a re-capture that NAMES ITS DAY (?date= / ?from=&to=) must stop before its first
 * write — the only kind the guard sees (a no-query POST is the 2 AM run to the code). Refuses when
 * any row was changed after the last scan (or that cannot be told), or when any archived stop
 * would be replaced. `wouldOverwrite` null means the capture would scan NuVizz, and what a scan
 * returns cannot be known without spending it — so every archived stop is counted as at risk.
 * It picks no policy for those rows; it names the numbers and stops. `rowCount` only adds a
 * sentence; it never refuses.
 *
 * `path` is the path the capture would take, and it changes WHAT THE CHANGED-ROWS REASON MAY
 * CLAIM, never whether it refuses. On the index path the capture copies those rows as they stand
 * (history-core.mts, `stops = idx.stops`), so "would seal them as they stand now" is what the code
 * does. On the scan path it writes scanDate's rows and copies nothing from the index
 * (`stops = scan.stops`), so that sentence would be false beside the archive reason's "this
 * re-capture would scan NuVizz" — what a scan returns for those stops is only known by spending
 * it. The refusal on the count stands on both paths (the task: refuse when either count is
 * non-zero). Absent, the path is read the way `wouldOverwrite` already says it: null = scan.
 */
export function recaptureVerdict(date: string, v: {
  patched: PatchCount | null; archivedStops: number; wouldOverwrite: number | null; rowCount?: RowCount | null;
  path?: 'firestore-index' | 'scan';
}): RecaptureVerdict {
  const reasons: string[] = [];
  const p = v.patched;
  const scanPath = v.path ? v.path === 'scan' : v.wouldOverwrite == null;
  if (p && p.rows > 0) {
    if (!p.known) {
      reasons.push(`the index has ${p.rows} row(s) but no readable last-scan time, so it cannot be told which were changed after the last scan`);
    } else {
      if (p.patched > 0) {
        const changed = `${p.patched} of the day's ${p.rows} index row(s) were changed after that day's last scan (${p.lastScannedAt}) — ${p.byFrozenHeal} by the frozen-day heal (the stop as a later day's scan saw it), ${p.byBoardWrite} by a dispatcher board write made after that scan`;
        reasons.push(scanPath
          ? `${changed}; this re-capture would scan NuVizz instead of copying the index, and whether that scan returns those stops as they stand now or as they stood at the last scan cannot be known without running it`
          : `${changed}; a re-capture would seal those rows into ${date} as they stand now, not as they stood at the last scan`);
      }
      if (p.unreadable > 0) reasons.push(`${p.unreadable} index row(s) carry a heal or board-write stamp that is not a readable time`);
    }
  }
  const atRisk = v.wouldOverwrite ?? v.archivedStops;
  if (atRisk > 0) {
    reasons.push(v.wouldOverwrite == null
      ? `${v.archivedStops} stop(s) are already archived for ${date}; this re-capture would scan NuVizz, and which of them a scan would overwrite cannot be known without running it`
      : `${v.wouldOverwrite} of the ${v.archivedStops} stop(s) already archived for ${date} would be overwritten`);
  }
  const refuse = reasons.length > 0;
  const note = rowCountNote(v.rowCount);
  const policy = `What to do with those rows is Chad's decision; nothing here decides it. (HISTORY_RECAPTURE_GUARD=off removes this refusal.)`;
  const message = refuse
    ? `Re-capture of ${date} REFUSED — nothing was written. ${reasons.join('. ')}.${note} ${policy}`
    : `Re-capture of ${date} would proceed: ${CHECKED}.${note}`;
  // A refusal stops before the scan, so it carries no scan cost; a proceed on the scan path does.
  const forecast = refuse
    ? `DRY RUN — a hand-driven re-capture of ${date} WOULD BE REFUSED, before any write: ${reasons.join('. ')}.${note} ${policy}${NAMED_DAY_NOTE}`
    : `DRY RUN — a hand-driven re-capture of ${date} WOULD PROCEED: ${CHECKED}.${note}${scanPath ? SCAN_NOTE : ''}`;
  return { refuse, reasons, message, forecast };
}

// The changes a past day's index can take after its last scan that the stamp count does not
// see — each read from the writer's code. Listed in every dry run so "no stamp later than the
// last scan" is never read as "nothing changed".
export const NOT_COUNTED: string[] = [
  "rows removed from the day after its last scan by moveBoardStopDay (firestore.mts): a confirmed date change deletes the row from its old day and stamps nothing there — rows_difference_since_last_scan shows how many rows are gone, not which",
  "rows patched by nuvizz-write recordFinishedHolder (a completionPatch through patchStopFields; it stamps nothing)",
  "note refreshes by writeStopNotes (firestore.mts, from nuvizz-pro-lookup): the note fields only, stamped notes_refreshed_at, which this count does not read",
  "same-day completion patches by the completed-feed overlay (applyCompletionPatches, today's board only): they stamp the row's own last_scanned_at, which the index read strips",
];

// ── the one Firestore read, shared by the dry run and the capture's own guard ──────────────────

export interface RecaptureIO {
  readIndex: (tenant: string, date: string) => Promise<{ meta: any; stops: any[] }>;
  listArchivedStopIds: (tenant: string, date: string) => Promise<string[]>;
  getManifest: (tenant: string, date: string) => Promise<any | null>;
}
const INDEX_MASK = ['stopNbr', 'frozen_heal_at', 'board_write_at'];
const LIVE_IO: RecaptureIO = {
  // Masked reads: the stamps and the stop number, not the ~5 KB raw NuVizz object per stop.
  readIndex: (t, d) => readStops(t, d, { mask: INDEX_MASK }),
  listArchivedStopIds: async (t, d) => (await listStops(t, d, { mask: ['stopNbr'] })).map((x) => String(x._id)),
  getManifest,
};

export interface RecaptureOpts {
  tenant: string; manual: boolean; firestoreOn: boolean; scansOn?: boolean; env?: any; io?: Partial<RecaptureIO>;
}

/**
 * What a capture of `date` would do, with ZERO writes and ZERO NuVizz calls: which path it takes,
 * what that path costs in NuVizz calls, the two counts, and — for a run that names its day —
 * whether the guard would refuse it. Firestore bills one read per document returned: the index
 * meta (1), each index row (masked), each archived stop id (masked) and the manifest (1) —
 * `firestore_reads` in the plan. The REQUESTS are fewer: listDocs pages at 300 (firestore.mts),
 * so a day of 849 rows with 588 archived is 1 + 3 + 2 + 1 = 7. On an instance that holds no
 * Google token yet, add up to four token exchanges (the four reads start together and
 * getAccessToken does not share an exchange in flight); none once it holds one.
 * This is the DRY RUN's report; its `verdict` is a forecast. The capture's own guard uses
 * assessRecapture below, which also hands back the verdict whose `message` a real refusal says.
 */
export async function planRecapture(date: string, opts: RecaptureOpts): Promise<any> {
  return (await assessRecapture(date, opts)).plan;
}

/** The one read and the one decision, shared by the dry run (`plan`) and the capture's guard (`verdict`). */
export async function assessRecapture(date: string, opts: RecaptureOpts): Promise<{ plan: any; verdict: RecaptureVerdict }> {
  const env = opts.env ?? process.env;
  const io = { ...LIVE_IO, ...(opts.io || {}) };
  const lean = leanHistoryOn(env);
  const [idx, archivedIds, manifest] = await Promise.all([
    io.readIndex(opts.tenant, date),
    io.listArchivedStopIds(opts.tenant, date),
    io.getManifest(opts.tenant, date),
  ]);
  const useIndex = lean && opts.firestoreOn && indexUsable(idx);
  const path: 'firestore-index' | 'scan' = useIndex ? 'firestore-index' : 'scan';
  const why = useIndex
    ? 'NUVIZZ_LEAN_DISCOVERY is on and the day\'s index is non-empty, has a last scan and was not halted'
    : !lean ? 'NUVIZZ_LEAN_DISCOVERY is not on, so the capture scans NuVizz'
      : !idx?.stops?.length ? 'the day\'s index is empty, so the capture falls back to a NuVizz scan'
        : !idx?.meta?.last_scanned_at ? 'the day\'s index has no last scan time, so the capture falls back to a NuVizz scan'
          : 'the day\'s last scan was halted, so the capture falls back to a NuVizz scan';
  const patched = patchedAfterLastScan(idx?.stops || [], idx?.meta?.last_scanned_at);
  const rowCount = rowCountSinceLastScan(idx?.meta, idx?.stops || []);
  const archivedStops = archivedIds.length;
  const wouldOverwrite = path === 'firestore-index' ? archivedOverwrites(idx.stops, archivedIds) : null;
  // The changed rows split by the archive. These are facts about the INDEX and the archive on
  // either path; on the scan path the capture writes the scan's rows instead, so they describe the
  // index a re-run would NOT copy. Unknowable (null) when the last scan time cannot be read.
  const split = patched.known ? splitPatchedByArchive(patched.ids, archivedIds) : null;
  const verdict = recaptureVerdict(date, { patched, archivedStops, wouldOverwrite, rowCount, path });
  const guardOn = recaptureGuardEnabled(env);
  const refused = opts.manual && guardOn && verdict.refuse;
  // THE DRY RUN'S VERDICT IS A FORECAST. It never says a refusal happened or that "nothing was
  // written" about a run nobody ran — that text is the real refusal's (verdict.message), which
  // only captureDate says, after it has stopped.
  //
  // A RUN WITH NO ?date= (manual false) is the 2 AM cron — or anybody's POST with no query string,
  // which the code cannot tell from it (see the header). The guard checks neither, so this says
  // what such a run would still do to the day: the reasons a named-day run would be refused are
  // things it writes over, not things that stop it. The guard-off forecast says the same for a
  // named-day run with HISTORY_RECAPTURE_GUARD off. Either one, on the scan path, spends the scan.
  const scanNote = path === 'scan' ? SCAN_NOTE : '';
  const forecast = !opts.manual
    ? `DRY RUN — the scheduled nightly capture is not refused by this guard, and neither is a POST with no query string, which the code cannot tell from it${verdict.refuse ? `: either would write despite ${verdict.reasons.join('; ')}` : ''}. It records patched_after_last_scan on the manifest.${scanNote}`
    : !guardOn && verdict.refuse ? `DRY RUN — HISTORY_RECAPTURE_GUARD is off, so a hand-driven re-capture of ${date} would NOT be refused: it would write despite ${verdict.reasons.join('; ')}.${scanNote}`
      : verdict.forecast;
  // A deploy with scans switched off skips the whole run (runHistorySnapshot, before any read), so
  // a forecast of what the guard would do must say that first. Only a caller that checked the
  // switch can say it; capture-health and the background dry run both pass it.
  const verdictText = opts.scansOn === false
    ? `DRY RUN — scans are switched off on this deploy (NUVIZZ_SCANS_ENABLED=false, or a mirror deploy), so a run now would be SKIPPED before it reads or writes anything. With scans on: ${forecast.replace(/^DRY RUN — /, '')}`
    : forecast;
  const plan = {
    date,
    dry_run: true, writes: 0, nuvizz_calls: 0,
    path, path_why: why,
    nuvizz_calls_if_run: path === 'firestore-index' ? 0 : SCAN_CALL_ESTIMATE,
    scans_enabled: opts.scansOn ?? null,   // null = not checked by this caller
    index: {
      rows: patched.rows,
      last_scanned_at: patched.lastScannedAt,
      halted: !!idx?.meta?.scanState?.halted,
      patched_after_last_scan: patched.known ? patched.patched : null,
      by_frozen_heal: patched.byFrozenHeal,
      by_board_write: patched.byBoardWrite,
      unreadable_stamps: patched.unreadable,
      // Of the changed rows: already archived (a re-run REPLACES a correct nightly-time record
      // with the later outcome) / not archived (a re-run writes them for the first time, with the
      // later outcome).
      patched_already_archived: split ? split.alreadyArchived : null,
      patched_not_archived: split ? split.notArchived : null,
      sample: patched.sample,
      // Rows added or removed since the last scan, from the meta the read already holds
      // (rowCountSinceLastScan). Reported, never refused on. null = the meta has no readable count.
      rows_at_last_scan: rowCount.atLastScan,
      rows_now: rowCount.now,
      rows_difference_since_last_scan: rowCount.difference,
    },
    archive: {
      stops_archived: archivedStops,
      would_overwrite: wouldOverwrite,
      // Archived stops the re-run would rewrite from rows this count does NOT flag (see
      // not_counted: a row changed without a stamp the guard reads cannot be told apart here).
      would_overwrite_unflagged: wouldOverwrite != null && split ? wouldOverwrite - split.alreadyArchived : null,
      sealed: !!(manifest && (manifest.verified || manifest.complete)),
      manifest: manifest ? {
        captured_at: manifest.captured_at ?? null, capture_version: manifest.capture_version ?? null,
        source_scanned_at: manifest.source_scanned_at ?? null, counts: manifest.counts ?? null,
        no_board: !!manifest.no_board, healed: !!manifest.healed,
      } : null,
    },
    manual: opts.manual,
    // WHAT A RUN WOULD DO, FIELD BY FIELD, in the order it would happen. would_skip first: true =
    // scans are switched off on this deploy, so a run now stops before it reads or writes anything
    // (runHistorySnapshot's scans check) and neither the guard nor the capture is reached; false =
    // it is not skipped for that; null = this caller did not check the switch. would_refuse is
    // the guard's answer for a run that gets past that point — so with would_skip true, a script
    // reading would_refuse alone would be reading the answer for a run that is not going to happen.
    would_skip: opts.scansOn === false ? true : opts.scansOn === true ? false : null,
    would_refuse: refused,
    verdict: verdictText,
    reasons: verdict.reasons,
    switches: {
      HISTORY_RECAPTURE_GUARD: guardOn ? 'on' : 'off',
      HISTORY_WRITE_RETRY: historyWriteRetryEnabled(env) ? 'on' : 'off',
      NUVIZZ_LEAN_DISCOVERY: lean ? 'on' : 'not on',
    },
    // Documents returned by each read (Firestore bills a read per document returned).
    firestore_reads: { index_meta: 1, index_rows: (idx?.stops || []).length, archived_stop_ids: archivedStops, manifest: 1 },
    // WHAT THE COUNT CANNOT SEE. It reads two stamps, frozen_heal_at and board_write_at; every
    // other writer below changes a past day's index without one of them.
    not_counted: NOT_COUNTED,
  };
  return { plan, verdict };
}
