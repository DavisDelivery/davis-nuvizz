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
export const MAX_EMAILS_PER_RUN = 3;

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
}

const isPdfAttachment = (a: any) =>
  /pdf/i.test(String(a?.contentType ?? '')) || /\.pdf$/i.test(String(a?.filename ?? ''));

/** The stored shape — mirrors the client's toStored() so a stored email run and a
 *  stored manual run are interchangeable to the flag and the tab. */
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
  for (const email of emails) {
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
          await setDoc(marker, { outcome: 'checked', at: run.at, suspects: run.suspectsTotal, source: src.name, from: run.from, subject: run.subject });
          outcomes.push({ source: src.name, id, outcome: 'checked', suspects: run.suspectsTotal });
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
