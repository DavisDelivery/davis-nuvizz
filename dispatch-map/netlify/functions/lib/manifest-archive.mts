// lib/manifest-archive.mts
//
// KEEP THE MANIFEST, NOT JUST THE VERDICT.
//
// Chad: "we need to download the PDF and put them in our system and have a history of those,
// as well as any that we're missing on that manifest for that particular day… we get four or
// five manifests every night, and every new manifest needs to overwrite the previous for that
// particular day. But their last one is sent at twelve AM, which is technically the delivery
// day — we need to make sure that day applies to the night before and not to that actual day."
//
// Until now the nightly ingest wrote ONE document, nuvizz_ops/manifest_check_latest, and every
// new manifest replaced it. Four or five arrive a night. So if the third report showed six
// orders off the board and the fourth superseded it, nothing anywhere could say whether those
// six were added or simply lost — and the PDF itself, the document you hold up to Uline when
// an order is disputed, was read once and thrown away.
//
// WHICH DAY A MANIFEST BELONGS TO, and why the clock is the wrong thing to ask.
//
// The document prints its own ship date on every row. All four or five reports of one night
// carry the SAME date, including the one that lands at 12:05a — so filing by what the paper
// says makes the midnight problem disappear rather than needing a rule to work around it. The
// clock is used only when no row carries a readable date, and then it is night-aware: an
// arrival before NIGHT_ROLLOVER_HOUR belongs to the evening that just ended, not to the
// calendar day it technically landed in. That is Chad's rule, applied exactly where it is
// actually needed and nowhere else.
//
// ONE COPY A NIGHT. Chad, correcting the first cut of this: "The manifest is only added to,
// nothing is ever removed from it, so that course of action of overwriting it every time was
// correct. I just want to keep an actual copy of it, but I don't want 4 copies a night kept."
//
// That invariant is the whole design. Each report of a night is a SUPERSET of the one before
// it, so the last one is the complete one and the earlier four hold nothing the last does not
// — keeping them would be four near-identical PDFs a night, ~1,500 a year, to answer a
// question none of them can answer better than the survivor. The night's PDF therefore lives
// at ONE key and each new report overwrites those bytes.
//
// What is kept beyond the document is metadata only, and only what the overwrite would
// otherwise destroy the ability to ask: how many reports arrived, when the first and last
// landed, and each arrival's order count. That is a few hundred bytes, not a copy, and it is
// what answers "did the midnight one actually reach us."
//
// AND THE INVARIANT IS A CHECK, not just a simplification. If a report arrives with FEWER
// orders than the one before it, something removed rows from a document that is only ever
// added to — a truncated download or a mis-parse, not a real change — so the day records it
// and the screen says so, rather than quietly overwriting a good manifest with a worse one.
//
// PURE. No Firestore, no blobs, no network — every decision here is testable on plain data.
import crypto from 'node:crypto';
import { manifestDateToIso } from './manifest-run.mts';

export const MANIFEST_DAYS_COLLECTION = 'manifest_days';
export const MANIFEST_BLOB_STORE = 'manifests';
export const ARCHIVE_VERSION = 1;
/** Before this ET hour, an arriving manifest belongs to the night that just ended. */
export const NIGHT_ROLLOVER_HOUR = 5;
/** Arrival lines kept per night — metadata only, never PDFs. A night is 4-5; the cap exists
 *  so a pathological resend loop cannot grow the document without end. */
export const MAX_ARRIVALS = 24;
/** Off-board rows kept per revision. The count is always exact; the LIST is what gets capped. */
export const MAX_MISSING_ROWS = 500;

export function manifestDayPath(tenant: string, date: string): string {
  return `${MANIFEST_DAYS_COLLECTION}/${tenant}__${date}`;
}
/** THE night's PDF. One key per night, deliberately: a newer report overwrites these bytes
 *  rather than sitting beside them. Date-first so a prefix lists a month. */
export function manifestBlobKey(tenant: string, date: string): string {
  return `${tenant}/${date}.pdf`;
}

/** The bytes' identity. Uline resends the same file and two mailboxes can carry one report;
 *  a byte-identical PDF is the SAME report, never a new revision. */
export function pdfDigest(buf: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const ET_PARTS = (d: Date) => {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
};

function shiftDay(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * PURE. Which day's file does this report belong in?
 *
 * The MODE of the rows' ship dates, not row [0]: one mis-read row must not decide where a
 * night's paperwork is filed, and the old diff took row zero on trust. Ties break to the
 * earliest date so the answer is deterministic whatever order the rows arrived in.
 */
export function manifestDeliveryDate(rows: any[], receivedAt?: Date | string | null): {
  date: string; from: 'manifest' | 'clock'; shipDates: string[];
} {
  const counts = new Map<string, number>();
  for (const r of rows || []) {
    const iso = manifestDateToIso(r?.shipDate);
    if (iso) counts.set(iso, (counts.get(iso) || 0) + 1);
  }
  if (counts.size) {
    const ranked = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    return { date: ranked[0][0], from: 'manifest', shipDates: ranked.map(([d]) => d) };
  }
  // NO DATE ON THE PAPER — fall back to the clock, night-aware (see the header).
  const when = receivedAt instanceof Date ? receivedAt
    : receivedAt ? new Date(receivedAt) : new Date();
  const safe = Number.isFinite(when.getTime()) ? when : new Date();
  const { date, hour } = ET_PARTS(safe);
  return { date: hour < NIGHT_ROLLOVER_HOUR ? shiftDay(date, -1) : date, from: 'clock', shipDates: [] };
}

export interface ReportInput {
  at: string;
  digest: string;
  bytes: number;
  emailId?: string | null;
  mailbox?: string | null;
  from?: string | null;
  subject?: string | null;
  fileName?: string | null;
  orders: number;
  totals?: any;
  verified?: boolean;
  onBoard?: number;
  boardOnly?: number;
  missing?: any[];
  checkedAgainst?: any[];
  blobKey?: string | null;
  pdfStored?: boolean;
  pdfError?: string | null;
  /** When the MAILBOX received this report, epoch ms. Decides which revision is the night's
   *  truth — see the supersedes rule in foldManifestDay. */
  receivedAt?: number | null;
}

/**
 * PURE. Fold tonight's report into the night's record — replacing what was there.
 *
 * Returns the next document plus what happened, so the caller logs a real outcome instead of
 * announcing one. `duplicate` means these exact bytes are already on file: the caller must
 * skip the upload, which is why the digest is computed before the fold rather than after.
 */
export function foldManifestDay(existing: any, entry: ReportInput, tenant: string, date: string): {
  doc: any; duplicate: boolean; reportNo: number; supersedes: boolean;
  orderCountFell: boolean; priorOrders: number | null;
} {
  const prevLatest = existing?.latest ?? null;
  const priorArrivals: any[] = Array.isArray(existing?.arrivals) ? existing.arrivals : [];

  // SAME PAPER, SEEN AGAIN — a resend, or the second mailbox carrying the same report. Record
  // that we saw it (an unchanged document is a fact worth keeping) and change nothing else, so
  // it costs no upload and does not read as a fifth report.
  if (prevLatest?.digest && entry.digest && prevLatest.digest === entry.digest) {
    return {
      doc: {
        ...existing,
        updated_at: entry.at,
        latest: { ...prevLatest, lastSeenAt: entry.at, seen: (Number(prevLatest.seen) || 1) + 1 },
      },
      duplicate: true,
      reportNo: Number(existing?.reportCount) || 1,
      // The same bytes already on file: nothing to supersede, nothing to overwrite.
      supersedes: false,
      orderCountFell: false,
      priorOrders: Number(prevLatest.orders) || null,
    };
  }

  const missing = Array.isArray(entry.missing) ? entry.missing : [];
  const orders = Number(entry.orders) || 0;
  const priorOrders = prevLatest ? (Number(prevLatest.orders) || 0) : null;
  const reportNo = (Number(existing?.reportCount) || 0) + 1;

  // WHICH REPORT IS THE NIGHT'S TRUTH — decided by WHEN ULINE SENT IT, not by the order we
  // happened to open the mail in.
  //
  // Chad: "you're saving the wrong manifest, you should be saving the last one pulled in.
  // You're instead saving the first one." The ingest now walks the mailbox oldest-first, which
  // fixes the common case — but it must not be the ONLY thing holding this up. A report that
  // cannot be filed on arrival ("board not scanned yet") is deliberately left unmarked and
  // retried, so it comes back later, in a batch alongside reports that are newer than it. That
  // is a designed-in re-batching, not a rare accident, and before this guard it meant the
  // afternoon's 27KB preliminary could overwrite the complete 61KB manifest.
  //
  // So the fold refuses to demote: an entry that Uline sent EARLIER than the one already on
  // file is recorded as an arrival and nothing more. The night keeps the latest paper.
  const incomingAt = Number(entry.receivedAt);
  const standingAt = Number(prevLatest?.receivedAt);
  const supersedes = !(Number.isFinite(incomingAt) && Number.isFinite(standingAt) && incomingAt < standingAt);

  // The invariant, used as a check: a manifest is only ever added to. Only meaningful when
  // this report genuinely follows the one on file — comparing a deliberately-kept older
  // report against a newer one would flag every out-of-order arrival as a short report.
  const orderCountFell = supersedes && priorOrders != null && orders < priorOrders;

  const latest = {
    reportNo,
    at: entry.at,
    // When the MAILBOX received it. `at` is when WE filed it, which is the same for every
    // report in one batch and therefore cannot order them.
    receivedAt: Number.isFinite(incomingAt) ? incomingAt : null,
    lastSeenAt: entry.at,
    seen: 1,
    digest: entry.digest,
    bytes: entry.bytes,
    emailId: entry.emailId ?? null,
    mailbox: entry.mailbox ?? null,
    from: entry.from ?? null,
    subject: entry.subject ?? null,
    fileName: entry.fileName ?? null,
    orders,
    totals: entry.totals ?? null,
    verified: !!entry.verified,
    onBoard: Number(entry.onBoard) || 0,
    boardOnly: Number(entry.boardOnly) || 0,
    // The COUNT is exact even when the list is trimmed, so a capped night can never
    // under-report how much was missing — number and sample disagreeing silently is the trap.
    missingCount: missing.length,
    missing: missing.slice(0, MAX_MISSING_ROWS),
    missingTruncated: missing.length > MAX_MISSING_ROWS,
    checkedAgainst: entry.checkedAgainst ?? [],
    blobKey: entry.blobKey ?? null,
    // Reported, never assumed: if the bytes did not reach the store the record says so, rather
    // than leaving a key that resolves to nothing.
    pdfStored: !!entry.pdfStored,
    pdfError: entry.pdfError ?? null,
    orderCountFell,
    priorOrders,
  };

  // METADATA ONLY — no PDFs, no missing lists. Just enough to answer "how many came, and did
  // the last one land", which is precisely what the overwrite would otherwise destroy.
  const arrivals = [
    {
      reportNo, at: entry.at, orders, missingCount: missing.length, mailbox: entry.mailbox ?? null,
      receivedAt: Number.isFinite(incomingAt) ? incomingAt : null,
      ...(orderCountFell ? { orderCountFell: true } : {}),
      // Says plainly that this one arrived out of order and was NOT adopted, so the arrivals
      // list cannot be read as "the last line is the manifest on file".
      ...(supersedes ? {} : { supersededByStanding: true }),
    },
    ...priorArrivals,
  ].slice(0, MAX_ARRIVALS);

  return {
    doc: {
      tenant, date, version: ARCHIVE_VERSION,
      first_at: existing?.first_at || entry.at,
      updated_at: entry.at,
      reportCount: reportNo,
      // Any night that ever saw a shrinking report stays flagged, because the reason to look
      // does not go away when a later good report lands on top of the bad one.
      sawOrderCountFall: !!existing?.sawOrderCountFall || orderCountFell,
      // An out-of-order arrival is COUNTED and RECORDED but does not take the night. The
      // standing revision stays exactly as it was, PDF and all.
      latest: supersedes ? latest : prevLatest,
      arrivals,
    },
    duplicate: false,
    reportNo,
    supersedes,
    orderCountFell,
    priorOrders,
  };
}

/** PURE. The one-line summary the tab and the log show for a night. */
export function describeDay(doc: any): string {
  const l = doc?.latest;
  if (!l) return 'no manifest on file';
  const miss = Number(l.missingCount) || 0;
  const reports = Number(doc.reportCount) || 1;
  return `${l.orders} order${l.orders === 1 ? '' : 's'} · ${miss ? `${miss} not on the board` : 'all on the board'}`
    + ` · ${reports} report${reports === 1 ? '' : 's'} tonight${l.pdfStored ? '' : ' · PDF not stored'}`
    + (doc.sawOrderCountFall ? ' · a report ARRIVED SHORTER than the one before it' : '');
}
