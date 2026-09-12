// lib/manifest-email-ingest.mts
//
// The nightly Uline freight report arrives BY EMAIL. Chad, looking at the drop
// screen: "This should happen automatically from email parse." This module is
// the automatic half: poll the mailbox, find the freight-report PDF, and run the
// SAME free board diff the drop screen runs — then store the result where every
// browser's Manifest-check flag reads it.
//
// TWO MAILBOXES, ONE PIPELINE. The report can arrive at the Resend receiving
// domain (warehouse.davisdelivery.com) or in Gmail — Chad: "write google mail
// into the app so we can parse for these manifests and look for any missing
// orders every night." Rather than fork the orchestration, each mailbox is a
// MailSource (list → attachments → download) and everything below the fetch is
// shared. Adding a third mailbox later means writing one small adapter, not
// touching any of the logic that decides what a PDF means.
//
// Design rules:
//   • POLL, don't webhook. The credentials already live on Netlify; polling adds
//     no public unauthenticated endpoint to a codebase that has no auth yet.
//   • SELF-VALIDATING match. No brittle sender/subject filters: any PDF that
//     PARSES as a Uline freight report (≥1 order row) IS the report; a PDF that
//     parses to zero rows is marked ignored and never fetched again.
//   • ZERO NuVizz calls. Only the free diff runs — the probe step is HTTP-only
//     behind a human click, unreachable from any scheduled path.
//   • Fail toward retry. A download or diff error leaves the email UNMARKED so
//     the next cycle tries again; only a definitive outcome (checked / ignored)
//     writes a marker.
//   • ISOLATE the mailboxes. One source's auth failure or throttle must never
//     stop the other from being read: sources are looped independently and their
//     errors are reported per source.
//
// Everything is dependency-injected so the whole orchestration is unit-tested
// without network or Firestore.

import type { MailAttachment, MailMessage, MailSource } from './mail-source.mts';

export type { MailAttachment, MailMessage, MailSource };

export const RESEND_BASE = 'https://api.resend.com';
export const LATEST_DOC = 'nuvizz_ops/manifest_check_latest';
export const markerDoc = (emailId: string) => `nuvizz_ops/manifest_email__${emailId}`;
/**
 * How many NEW emails one pass will open, per mailbox.
 *
 * WAS 3, AND THREE WAS TOO FEW THE MOMENT THE SCHEDULE NARROWED. Uline sends a night's report
 * up to SEVEN times (measured 9/9: 10:51a, then 8p, 9p, 10p, 11p, 12a, 12:30a), so a pass that
 * can open three has to leave four for later — and the cap is spent OLDEST FIRST, which means
 * last night's leftovers go first. On 2026-09-10 the 8:10p pass spent all three slots filing
 * the 9/9 night's 11p/12a/12:30a reports and never reached a single 9/10 email. Eight covers
 * a whole night's sends with room to spare, so a backlog can be drained in one pass instead of
 * pushing the same work forward another day.
 *
 * Raising it costs nothing in NuVizz calls — there are none on this path — and nothing in
 * mailbox calls for mail already marked; the only extra work is one attachment download and
 * one Firestore board diff per genuinely new email, which is the work we WANT done.
 *
 * MANIFEST_MAX_EMAILS_PER_RUN overrides it. House shape: anything unparseable, out of range,
 * or absent leaves the default in place, because a typo in an env var must never quietly
 * shrink this back to the behaviour that lost a night.
 */
export const MAX_EMAILS_PER_RUN = (() => {
  const n = Number(process.env.MANIFEST_MAX_EMAILS_PER_RUN);
  return Number.isFinite(n) && n >= 1 && n <= 50 ? Math.floor(n) : 8;
})();

/** Per-mailbox marker path. Resend keeps the ORIGINAL unprefixed path so the
 *  markers already written stay authoritative and nothing is re-processed on
 *  deploy; every other source is namespaced so two mailboxes can never collide
 *  on a message id. */
export function markerDocFor(sourceName: string, emailId: string): string {
  return sourceName === 'resend' ? markerDoc(emailId) : markerDoc(`${sourceName}__${emailId}`);
}

export interface IngestDeps {
  fetchImpl: typeof fetch;
  getDoc: (path: string) => Promise<any | null>;
  setDoc: (path: string, data: any) => Promise<boolean>;
  runDiff: (buf: Buffer) => Promise<any>;
  now?: () => string;      // ISO stamp, injectable for tests
  sources?: MailSource[];  // when omitted, built from apiKey below (back-compat)
  apiKey?: string | null;  // Resend key — the original single-mailbox entry point
  /** FILE THE PAPER. Called once per ACCEPTED report with the bytes and the diff, so the
   *  nightly run leaves a per-day record and a stored PDF behind it (Chad: "download the PDF
   *  and put them in our system… have a history of those"). Optional and best-effort by
   *  contract: the diff and the marker are the job, and an archive failure must never cost a
   *  night's check. Returns whatever it wants recorded on the outcome line. */
  archive?: (buf: Buffer, diff: any, email: any, fileName: string | null, at: string, mailbox: string) => Promise<any>;
}

const isPdfAttachment = (a: any) =>
  /pdf/i.test(String(a?.contentType ?? '')) || /\.pdf$/i.test(String(a?.filename ?? ''));

/** The switch's position, read once per call so a test can flip it. Anything but an explicit
 *  off-word leaves it ON — a malformed value must not silently take the alert back off, which
 *  is the exact failure this carries the verdict to fix.
 *  MANIFEST_STORED_GRADE=off puts the stripped shape back, and with it the old grading. */
export function storedGradeEnabled(env: any = process.env): boolean {
  const v = String(env?.MANIFEST_STORED_GRADE ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** The stored shape — mirrors the client's toStored() so a stored email run and a
 *  stored manual run are interchangeable to the flag and the tab. */
/**
 * THE COUNT MUST TRAVEL WITH ITS STANDING — and on this document it did not.
 *
 * v0.81.5 established the rule and filed coverage/grade/expectedDelivery on the ARCHIVE
 * record (manifest-archive-store) and re-graded the HISTORY row from them
 * (manifest-history.gradeForRow). This function — the one that writes
 * nuvizz_ops/manifest_check_latest, which is the document the Manifest check SCREEN
 * subscribes to — was missed, and kept writing the stripped shape.
 *
 * What that cost, measured on Chad's 2026-09-12 card. The run shipped Friday 09-11, expected
 * delivery Monday 09-14, and checked 09-14 (424 stops) · 09-15 (2) · 09-16 (0). With the
 * verdict dropped, manifest-check-view falls back to `boardCoverage(checkedAgainst)` with NO
 * `required` and NO `asOf` — which manifest-window documents as "demand ALL of them, the
 * conservative reading". So:
 *
 *   • it named 2026-09-16 — the +2 SLACK day, which that module says explicitly is "extra
 *     places to LOOK, and deliberately not extra days that must be scanned" — instead of
 *     2026-09-14, the day that decides and the one that was covered;
 *   • and, far worse, `conclusive` is then false on essentially EVERY nightly run, because
 *     the day after tomorrow is never routed yet. gradeSuspects downgrades 'missing' to
 *     'unrouted' on a false verdict, so the RED alert and the nav badge were structurally
 *     dead: the one check that can catch an order Uline handed us that NuVizz never received
 *     could not raise its alarm. A missed flag is the order that never shipped.
 *
 * Carrying the four fields the server already computed is the whole fix. The client prefers
 * a stored verdict over a re-derived one and always has (manifest-check-view.gradeOf), so
 * nothing downstream changes shape — and App.jsx's "Shipped X · expected delivery Y" line,
 * written months ago and never once rendered for an email run, comes on with it.
 */
export function toStoredEmailRun(diff: any, email: any, fileName: string | null, at: string, mailbox = 'email') {
  return {
    at,
    source: 'email',   // what the flag/tab switch on — unchanged, both mailboxes
    mailbox,           // WHICH inbox it came from, for the diagnostics line
    emailId: String(email?.id ?? ''),
    from: String(email?.from ?? ''),
    subject: String(email?.subject ?? ''),
    fileName: fileName || null,
    checkedAgainst: diff.checkedAgainst || [],
    manifest: diff.manifest || null,
    onBoard: diff.onBoard ?? 0,
    boardOnly: diff.boardOnly ?? 0,
    duplicatePros: diff.duplicatePros || [],
    suspects: (diff.suspects || []).slice(0, 200),
    suspectsTotal: (diff.suspects || []).length,
    // WHY THE WINDOW IS THE WINDOW, and what the boards behind it were worth. `?? null`
    // throughout: Firestore rejects undefined, and a field that is absent must read as
    // "this run did not record it" rather than vanishing.
    ...(storedGradeEnabled() ? {
      shipDate: diff.shipDate ?? null,
      expectedDelivery: diff.expectedDelivery ?? null,
      coverage: diff.coverage ?? null,
      grade: diff.grade ?? null,
    } : {}),
  };
}

/**
 * The Resend receiving inbox as a MailSource. Behaviour is byte-for-byte what
 * this module did before the two-mailbox refactor, including the re-list dance
 * when a download_url has expired.
 */
export function resendSource(apiKey: string, fetchImpl: typeof fetch): MailSource {
  const hdr = { Authorization: `Bearer ${apiKey}` };
  const rawAttachments = async (id: string): Promise<any[]> => {
    const resp = await fetchImpl(`${RESEND_BASE}/emails/receiving/${encodeURIComponent(id)}/attachments`, { headers: hdr });
    if (!resp.ok) return [];
    const json: any = await resp.json().catch(() => null);
    return Array.isArray(json?.data) ? json.data : [];
  };
  const normalize = (a: any): MailAttachment => ({
    id: String(a?.id ?? ''),
    filename: String(a?.filename ?? '') || null,
    contentType: String(a?.content_type ?? '') || null,
    downloadUrl: String(a?.download_url ?? '') || null,
  });

  return {
    name: 'resend',

    async list(): Promise<MailMessage[]> {
      const resp = await fetchImpl(`${RESEND_BASE}/emails/receiving?limit=20`, { headers: hdr });
      if (!resp.ok) throw new Error(`resend list ${resp.status}`);
      const json: any = await resp.json().catch(() => null);
      const emails: any[] = Array.isArray(json?.data) ? json.data : [];
      return emails.map((e) => ({
        id: String(e?.id ?? ''),
        from: String(e?.from ?? ''),
        subject: String(e?.subject ?? ''),
        attachments: (Array.isArray(e?.attachments) ? e.attachments : []).map(normalize),
      }));
    },

    // The list payload usually carries the attachments; when it doesn't, ask the
    // attachments endpoint. Called only AFTER the marker check, so an email we
    // already handled costs nothing.
    async attachments(msg: MailMessage): Promise<MailAttachment[]> {
      if (msg.attachments.length) return msg.attachments;
      return (await rawAttachments(msg.id)).map(normalize);
    },

    async download(msg: MailMessage, att: MailAttachment): Promise<Buffer | null> {
      let urlToGet = String(att.downloadUrl ?? '');
      if (!urlToGet) {
        // download_url expires; re-list for a fresh one before giving up.
        const fresh = (await rawAttachments(msg.id)).find((x: any) => String(x?.id ?? '') === att.id) || null;
        urlToGet = String(fresh?.download_url ?? '');
      }
      if (!urlToGet) throw new Error('no download_url');
      const dl = await fetchImpl(urlToGet);
      if (!dl.ok) throw new Error(`download ${dl.status}`);
      return Buffer.from(await dl.arrayBuffer());
    },
  };
}

/**
 * OLDEST FIRST, AND THAT ORDER IS THE WHOLE CORRECTNESS OF THE ARCHIVE.
 *
 * Chad, looking at a stored manifest: "you're saving the wrong manifest, you should be saving
 * the last one pulled in. You're instead saving the first one."
 *
 * He is exactly right, and here is the mechanism. Uline sends one night's freight report
 * FIVE times — a small mid-afternoon preliminary and then the full report at midnight, 1am,
 * 2am and 3am. Measured on 08/27/26: the first attachment is ~27KB, the rest are ~61KB. The
 * manifest is append-only, so the LAST one is the complete one and the first is a fragment.
 *
 * Gmail's messages.list returns NEWEST FIRST. This loop walked that order, and every accepted
 * report overwrites the same blob key and replaces doc.latest — so within a batch the OLDEST
 * message was filed LAST and won. With MAX_EMAILS_PER_RUN capping each pass, successive runs
 * then marched the archive BACKWARDS through the night until it settled on report #1: the
 * 27KB fragment. That is the PDF on Chad's screen.
 *
 * Two more things rode on the same mistake. reportNo counts in processing order, so the
 * earliest report ended up numbered highest and labelled "latest". And foldManifestDay's
 * append-only check (orderCountFell, surfaced as "a report came back short") compares each
 * fold against the previous one — walking backwards makes the count fall almost every time,
 * so that warning was firing on healthy nights.
 *
 * Sorting ascending fixes all three, and it converges FORWARD under the per-run cap: each
 * pass ends on the newest message it handled, so the archive never moves backwards in time.
 *
 * A MESSAGE WITH NO TIMESTAMP SORTS FIRST, deliberately, and the asymmetry is the point.
 * Filing is last-write-wins, so an undated message placed first is overwritten by every
 * report whose time we DO know, while one placed last would overwrite all of them. The
 * failure modes are not equal: losing an undated report we cannot place costs one revision,
 * whereas letting it win risks re-enacting this exact bug — a fragment overwriting the
 * complete manifest. The cautious side is first. (Gmail always supplies internalDate, so
 * this is a defensive path, not the normal one.)
 *
 * Returning 0 for those pairs was tried and is WRONG: it is not a total order, so the
 * timestamped messages either side of an undated one can be left mis-sorted relative to
 * each other. A test caught that.
 */
export function orderOldestFirst(emails: MailMessage[]): MailMessage[] {
  const key = (m: MailMessage): number => {
    const t = Number(m?.receivedAt);
    return Number.isFinite(t) ? t : -Infinity;
  };
  return [...emails].sort((a, b) => key(a) - key(b));
}

/** One mailbox's pass. Bounded by MAX_EMAILS_PER_RUN PER SOURCE, so a noisy
 *  inbox can never starve the one the report actually lands in. */
async function ingestOneSource(src: MailSource, deps: IngestDeps, outcomes: any[]): Promise<any> {
  const { getDoc, setDoc, runDiff } = deps;
  const now = deps.now || (() => new Date().toISOString());

  let emails: MailMessage[];
  try {
    emails = await src.list();
  } catch (e: any) {
    return { name: src.name, inbox: 0, processed: 0, error: e?.message || 'list failed' };
  }

  let processed = 0;
  // See orderOldestFirst: the newest report of a night must be filed LAST, because filing is
  // an overwrite and the last write wins.
  for (const email of orderOldestFirst(emails)) {
    if (processed >= MAX_EMAILS_PER_RUN) break;
    const id = String(email?.id ?? '');
    if (!id) continue;
    const marker = markerDocFor(src.name, id);
    if (await getDoc(marker)) continue; // already handled (checked or ignored)

    let atts: MailAttachment[];
    try {
      atts = await (src.attachments ? src.attachments(email) : Promise.resolve(email.attachments));
    } catch (e: any) {
      // Couldn't even enumerate: transient by assumption, so leave it unmarked.
      outcomes.push({ source: src.name, id, outcome: 'retry', reason: e?.message || 'attachments failed' });
      continue;
    }

    const pdfs = atts.filter(isPdfAttachment);
    if (!pdfs.length) {
      await setDoc(marker, { outcome: 'ignored', reason: 'no pdf attachment', at: now(), source: src.name, from: email.from ?? null, subject: email.subject ?? null });
      outcomes.push({ source: src.name, id, outcome: 'ignored', reason: 'no pdf attachment' });
      processed += 1;
      continue;
    }

    let stored = false; let lastErr: string | null = null; let sawNonManifest = false;
    for (const att of pdfs) {
      try {
        const buf = await src.download(email, att);
        if (!buf) { lastErr = 'empty attachment'; continue; }
        const diff = await runDiff(buf);
        if (diff?.ok) {
          const run = toStoredEmailRun(diff, email, att.filename || null, now(), src.name);
          await setDoc(LATEST_DOC, run);
          // File the paper BEFORE the marker. The marker is what stops this email ever being
          // read again, so writing it first would make an archive failure permanent — the one
          // ordering mistake here that cannot be retried out of.
          let filed: any = null;
          if (deps.archive) {
            try { filed = await deps.archive(buf, diff, email, att.filename || null, run.at, src.name); }
            catch (e: any) { filed = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
          }
          await setDoc(marker, { outcome: 'checked', at: run.at, suspects: run.suspectsTotal, source: src.name, from: run.from, subject: run.subject, ...(filed ? { archived: filed } : {}) });
          outcomes.push({ source: src.name, id, outcome: 'checked', suspects: run.suspectsTotal, ...(filed ? { archived: filed } : {}) });
          stored = true;
          break;
        }
        if (diff?.notManifest) { sawNonManifest = true; continue; } // a PDF, just not the report
        lastErr = String(diff?.error ?? 'diff failed'); // e.g. board not scanned yet → retry next cycle
      } catch (e: any) { lastErr = e?.message || 'error'; }
    }

    if (stored) { processed += 1; continue; }
    if (lastErr) {
      // Transient (download, board-not-scanned): leave UNMARKED so the next cycle retries.
      outcomes.push({ source: src.name, id, outcome: 'retry', reason: lastErr });
      continue;
    }
    if (sawNonManifest) {
      await setDoc(marker, { outcome: 'ignored', reason: 'pdf is not the freight report', at: now(), source: src.name, from: email.from ?? null, subject: email.subject ?? null });
      outcomes.push({ source: src.name, id, outcome: 'ignored', reason: 'pdf is not the freight report' });
      processed += 1;
    }
  }

  return { name: src.name, inbox: emails.length, processed };
}

/**
 * ── THE DRY RUN ─────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS, and it is a lesson this repo has already paid for once. On the night of
 * 2026-09-10 the Manifest history showed "1 report" when Uline had sent five, and every
 * surface that could have said why showed the same blank: the job wrote nothing and the panel
 * got nothing, which look identical. Four candidate explanations fitted the symptom — the
 * per-run cap, the PDF parse, the board diff, the schedule — and the only honest way to tell
 * them apart is to read what the job WOULD do, email by email, without doing it.
 *
 * CLAUDE.md, after the roster went four rounds undiagnosed: "Build the free diagnostic FIRST
 * when one is possible… a zero-cost ?explain=1 was ten minutes of work and should have been
 * the first move." This is that.
 *
 * IT WRITES NOTHING. No marker, no LATEST_DOC, no archive, no blob. It is the same walk the
 * real cycle makes — the SAME source list, the SAME marker paths, the SAME oldest-first
 * order, the SAME cap arithmetic — reported instead of executed. Reusing markerDocFor and
 * orderOldestFirst rather than re-deriving them is the whole point: a diagnostic that works
 * out the marker path its own way is answering a question about itself.
 *
 * COST: one list call per mailbox, plus one marker read per email. With `deep`, also one
 * attachment download and one board diff per email this pass would actually open — both free
 * (Firestore reads only). ZERO NuVizz calls, by construction: nothing here can reach NuVizz.
 *
 * `wouldProcess` is the honest part. The real loop breaks at MAX_EMAILS_PER_RUN and spends
 * that cap on the OLDEST unhandled mail first, so a backlog from last night can eat a pass
 * before tonight's report is reached. Every row says whether this pass gets to it.
 */
export async function explainManifestEmails(deps: IngestDeps & { deep?: boolean }): Promise<any> {
  const sources = deps.sources
    ?? (deps.apiKey ? [resendSource(deps.apiKey, deps.fetchImpl)] : []);
  if (!sources.length) {
    return { ok: true, explain: true, wrote: 'nothing', skipped: 'no mail sources configured', mailboxes: [] };
  }

  const mailboxes: any[] = [];
  for (const src of sources) {
    let emails: MailMessage[];
    try { emails = await src.list(); }
    catch (e: any) { mailboxes.push({ name: src.name, error: e?.message || 'list failed', emails: [] }); continue; }

    const rows: any[] = [];
    let wouldProcess = 0;
    for (const email of orderOldestFirst(emails)) {
      const id = String(email?.id ?? '');
      if (!id) continue;
      const marker = await deps.getDoc(markerDocFor(src.name, id)).catch(() => null);

      // The cap is spent in THIS order, so "would this pass even reach it" is answerable
      // right here — and it is the single most useful column when a night comes up short.
      const reached = wouldProcess < MAX_EMAILS_PER_RUN;
      const row: any = {
        id,
        receivedAt: Number(email?.receivedAt) || null,
        // ET, because every question asked of this data is asked in ET ("did the 9:10p pass
        // see it?") and a UTC stamp is one mental subtraction away from a wrong answer.
        receivedAtEt: Number(email?.receivedAt)
          ? new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short',
          }).format(new Date(Number(email.receivedAt)))
          : null,
        from: String(email?.from ?? ''),
        subject: String(email?.subject ?? ''),
        marked: !!marker,
        outcome: marker?.outcome ?? null,
        reason: marker?.reason ?? null,
        markedAt: marker?.at ?? null,
        archived: marker?.archived ?? null,
      };

      if (marker) {
        row.verdict = `already ${marker.outcome ?? 'handled'} — never read again`;
        rows.push(row); continue;
      }
      if (!reached) {
        row.verdict = `UNREAD THIS PASS — the ${MAX_EMAILS_PER_RUN}-email cap was already spent on older mail`;
        rows.push(row); continue;
      }
      wouldProcess += 1;

      let atts: MailAttachment[] = [];
      try { atts = await (src.attachments ? src.attachments(email) : Promise.resolve(email.attachments)); }
      catch (e: any) {
        row.verdict = `would RETRY — could not list attachments (${e?.message || 'error'})`;
        rows.push(row); continue;
      }
      const pdfs = atts.filter(isPdfAttachment);
      row.pdfs = pdfs.map((a) => a.filename || a.id);
      if (!pdfs.length) { row.verdict = 'would be IGNORED — no PDF attachment'; rows.push(row); continue; }

      if (!deps.deep) {
        row.verdict = 'would be READ this pass (add deep=1 to see what the diff says)';
        rows.push(row); continue;
      }

      // DEEP: run the real diff and report it, writing nothing. This is the branch that tells
      // a parse failure ("no orders found") apart from a board failure ("no board rows cached
      // for those dates") — two outcomes that look identical from outside the job and need
      // opposite fixes.
      const tried: any[] = [];
      for (const att of pdfs) {
        try {
          const buf = await src.download(email, att);
          if (!buf) { tried.push({ file: att.filename, result: 'empty attachment' }); continue; }
          const diff = await deps.runDiff(buf);
          tried.push({
            file: att.filename,
            bytes: buf.length,
            ok: !!diff?.ok,
            orders: diff?.manifest?.orders ?? null,
            shipDate: diff?.shipDate ?? null,
            expectedDelivery: diff?.expectedDelivery ?? null,
            boardDays: diff?.boardDays ?? null,
            notManifest: !!diff?.notManifest,
            error: diff?.error ?? null,
          });
          if (diff?.ok) break;
        } catch (e: any) { tried.push({ file: att.filename, result: `error: ${e?.message || e}` }); }
      }
      row.tried = tried;
      const good = tried.find((x) => x.ok);
      row.verdict = good
        ? `would be CHECKED and filed (${good.orders} orders)`
        : tried.some((x) => x.notManifest)
          ? 'would be IGNORED — the PDF is not the freight report'
          : `would RETRY — ${tried.map((x) => x.error || x.result).filter(Boolean)[0] || 'the diff did not succeed'}`;
      rows.push(row);
    }

    mailboxes.push({
      name: src.name,
      inbox: emails.length,
      unmarked: rows.filter((r) => !r.marked).length,
      cap: MAX_EMAILS_PER_RUN,
      wouldProcess,
      emails: rows,
    });
  }

  return { ok: true, explain: true, wrote: 'nothing', nuvizzCalls: 0, mailboxes };
}

/**
 * One polling cycle across every configured mailbox. Returns a summary of what
 * happened — every skip has a reason, because a silent no-op is
 * indistinguishable from a broken one.
 */
export async function ingestManifestEmails(deps: IngestDeps): Promise<any> {
  const sources = deps.sources
    ?? (deps.apiKey ? [resendSource(deps.apiKey, deps.fetchImpl)] : []);
  if (!sources.length) {
    // Preserve the original message for the Resend-only entry point: an inbox
    // that was never set up is not an error.
    return { ok: true, skipped: deps.sources ? 'no mail sources configured' : 'no RESEND_API_KEY', processed: 0 };
  }

  const outcomes: any[] = [];
  const perSource: any[] = [];
  for (const src of sources) perSource.push(await ingestOneSource(src, deps, outcomes));

  const inbox = perSource.reduce((n, s) => n + (s.inbox || 0), 0);
  const processed = perSource.reduce((n, s) => n + (s.processed || 0), 0);
  const errored = perSource.filter((s) => s.error);
  const out: any = { ok: errored.length < sources.length, inbox, processed, outcomes };
  if (perSource.length > 1) out.sources = perSource;
  if (errored.length) out.error = errored.map((s) => `${s.name}: ${s.error}`).join('; ');
  return out;
}
