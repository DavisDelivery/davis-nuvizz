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
// OVERWRITE, BUT DO NOT DESTROY. "Every new manifest overwrites the previous for that day"
// and "have a history of those" pull in opposite directions if overwrite is taken literally.
// Anything READING a day gets the newest report — overwrite, as asked. The superseded ones
// stay addressable as numbered revisions under the same day, because the sequence is where
// the story lives: six orders that appear only on the last report, two hours before dispatch,
// is a fact about Uline worth being able to show.
//
// PURE. No Firestore, no blobs, no network — every decision here is testable on plain data.
import crypto from 'node:crypto';
import { manifestDateToIso } from './manifest-run.mts';

export const MANIFEST_DAYS_COLLECTION = 'manifest_days';
export const MANIFEST_BLOB_STORE = 'manifests';
export const ARCHIVE_VERSION = 1;
/** Before this ET hour, an arriving manifest belongs to the night that just ended. */
export const NIGHT_ROLLOVER_HOUR = 5;
/** How many superseded reports to keep per day. A night is 4-5; this is headroom, not a cap
 *  anyone should hit, and it stops a pathological resend loop growing a document without end. */
export const MAX_REVISIONS = 24;
/** Off-board rows kept per revision. The count is always exact; the LIST is what gets capped. */
export const MAX_MISSING_ROWS = 500;

export function manifestDayPath(tenant: string, date: string): string {
  return `${MANIFEST_DAYS_COLLECTION}/${tenant}__${date}`;
}
/** Blob key for one stored report. Date-first so a prefix list gives a day, then a month. */
export function manifestBlobKey(tenant: string, date: string, revision: number): string {
  return `${tenant}/${date}/r${String(revision).padStart(3, '0')}.pdf`;
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

export interface RevisionInput {
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
}

/**
 * PURE. Fold one accepted report into the day's record.
 *
 * Returns the NEXT document plus what happened, so the caller can log a real outcome instead
 * of announcing one. `duplicate` means these exact bytes are already filed — the caller must
 * not write a blob for it, which is the whole reason the digest is computed before the fold.
 */
export function foldRevision(existing: any, entry: RevisionInput, tenant: string, date: string): {
  doc: any; revision: number; duplicate: boolean; supersededRevision: number | null;
} {
  const prior: any[] = Array.isArray(existing?.revisions) ? existing.revisions : [];
  const dupe = prior.find((r) => r?.digest && entry.digest && r.digest === entry.digest) || null;
  if (dupe) {
    // Same paper, seen again (a resend, or the second mailbox carrying it). Record that we saw
    // it — an unchanged document is a fact worth keeping — and change nothing else.
    const doc = {
      ...existing,
      updated_at: entry.at,
      revisions: prior.map((r) => (r === dupe ? { ...r, lastSeenAt: entry.at, seen: (Number(r.seen) || 1) + 1 } : r)),
    };
    return { doc, revision: Number(dupe.revision) || 1, duplicate: true, supersededRevision: null };
  }

  const revision = prior.reduce((m, r) => Math.max(m, Number(r?.revision) || 0), 0) + 1;
  const missing = Array.isArray(entry.missing) ? entry.missing : [];
  const rev = {
    revision,
    at: entry.at,
    lastSeenAt: entry.at,
    seen: 1,
    digest: entry.digest,
    bytes: entry.bytes,
    emailId: entry.emailId ?? null,
    mailbox: entry.mailbox ?? null,
    from: entry.from ?? null,
    subject: entry.subject ?? null,
    fileName: entry.fileName ?? null,
    orders: Number(entry.orders) || 0,
    totals: entry.totals ?? null,
    verified: !!entry.verified,
    onBoard: Number(entry.onBoard) || 0,
    boardOnly: Number(entry.boardOnly) || 0,
    // The COUNT is exact even when the list is trimmed, so a capped day can never under-report
    // how much was missing — the number and the sample disagreeing silently is the trap here.
    missingCount: missing.length,
    missing: missing.slice(0, MAX_MISSING_ROWS),
    missingTruncated: missing.length > MAX_MISSING_ROWS,
    checkedAgainst: entry.checkedAgainst ?? [],
    blobKey: entry.blobKey ?? null,
    // Reported, never assumed: if the bytes did not reach the store, the record says so rather
    // than leaving a blobKey that resolves to nothing.
    pdfStored: !!entry.pdfStored,
    pdfError: entry.pdfError ?? null,
  };
  const revisions = [...prior, rev].sort((a, b) => (Number(b.revision) || 0) - (Number(a.revision) || 0)).slice(0, MAX_REVISIONS);
  const doc = {
    tenant, date, version: ARCHIVE_VERSION,
    first_at: existing?.first_at || entry.at,
    updated_at: entry.at,
    // THE OVERWRITE Chad asked for: whatever reads this day gets the newest report.
    latest: rev,
    revisionCount: revisions.length,
    revisions,
  };
  return { doc, revision, duplicate: false, supersededRevision: prior.length ? (Number(prior[0]?.revision) || null) : null };
}

/** PURE. The one-line summary the tab and the log show for a day. */
export function describeDay(doc: any): string {
  const l = doc?.latest;
  if (!l) return 'no manifest on file';
  const miss = Number(l.missingCount) || 0;
  const revs = Number(doc.revisionCount) || 1;
  return `${l.orders} order${l.orders === 1 ? '' : 's'} · ${miss ? `${miss} not on the board` : 'all on the board'}`
    + ` · report ${l.revision} of ${revs}${l.pdfStored ? '' : ' · PDF not stored'}`;
}
