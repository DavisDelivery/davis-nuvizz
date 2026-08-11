// lib/manifest-email-ingest.mts
//
// The nightly Uline freight report arrives BY EMAIL. Chad, looking at the drop
// screen: "This should happen automatically from email parse." This module is
// the automatic half: poll the Resend inbox (receiving on the
// warehouse.davisdelivery.com domain), find the freight-report PDF, and run the
// SAME free board diff the drop screen runs — then store the result where every
// browser's Manifest-check flag reads it.
//
// Design rules:
//   • POLL, don't webhook. The API key already lives on Netlify; polling adds no
//     public unauthenticated endpoint to a codebase that has no auth yet.
//   • SELF-VALIDATING match. No brittle sender/subject filters: any PDF that
//     PARSES as a Uline freight report (≥1 order row) IS the report; a PDF that
//     parses to zero rows is marked ignored and never fetched again.
//   • ZERO NuVizz calls. Only the free diff runs — the probe step is HTTP-only
//     behind a human click, unreachable from any scheduled path.
//   • Fail toward retry. A download or diff error leaves the email UNMARKED so
//     the next cycle tries again; only a definitive outcome (checked / ignored)
//     writes a marker.
//
// Everything is dependency-injected so the whole orchestration is unit-tested
// without network or Firestore.

export const RESEND_BASE = 'https://api.resend.com';
export const LATEST_DOC = 'nuvizz_ops/manifest_check_latest';
export const markerDoc = (emailId: string) => `nuvizz_ops/manifest_email__${emailId}`;
export const MAX_EMAILS_PER_RUN = 3;

export interface IngestDeps {
  apiKey: string | null | undefined;
  fetchImpl: typeof fetch;
  getDoc: (path: string) => Promise<any | null>;
  setDoc: (path: string, data: any) => Promise<boolean>;
  runDiff: (buf: Buffer) => Promise<any>;
  now?: () => string; // ISO stamp, injectable for tests
}

const isPdfAttachment = (a: any) =>
  /pdf/i.test(String(a?.content_type ?? '')) || /\.pdf$/i.test(String(a?.filename ?? ''));

/** The stored shape — mirrors the client's toStored() so a stored email run and a
 *  stored manual run are interchangeable to the flag and the tab. */
export function toStoredEmailRun(diff: any, email: any, fileName: string | null, at: string) {
  return {
    at,
    source: 'email',
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
 * One polling cycle. Returns a summary of what happened — every skip has a
 * reason, because a silent no-op is indistinguishable from a broken one.
 */
export async function ingestManifestEmails(deps: IngestDeps): Promise<any> {
  const { apiKey, fetchImpl, getDoc, setDoc, runDiff } = deps;
  const now = deps.now || (() => new Date().toISOString());
  if (!apiKey) return { ok: true, skipped: 'no RESEND_API_KEY', processed: 0 };

  const hdr = { Authorization: `Bearer ${apiKey}` };
  const listResp = await fetchImpl(`${RESEND_BASE}/emails/receiving?limit=20`, { headers: hdr });
  if (!listResp.ok) return { ok: false, error: `resend list ${listResp.status}`, processed: 0 };
  const list: any = await listResp.json().catch(() => null);
  const emails: any[] = Array.isArray(list?.data) ? list.data : [];
  if (!emails.length) return { ok: true, processed: 0, inbox: 0 };

  const outcomes: any[] = [];
  let processed = 0;
  for (const email of emails) {
    if (processed >= MAX_EMAILS_PER_RUN) break;
    const id = String(email?.id ?? '');
    if (!id) continue;
    if (await getDoc(markerDoc(id))) continue; // already handled (checked or ignored)

    // Attachments: the list payload carries them; fall back to the attachments
    // endpoint when it doesn't (the API returns download_url per attachment).
    let atts: any[] = Array.isArray(email?.attachments) ? email.attachments : [];
    if (!atts.length) {
      const aResp = await fetchImpl(`${RESEND_BASE}/emails/receiving/${encodeURIComponent(id)}/attachments`, { headers: hdr });
      if (aResp.ok) { const aj: any = await aResp.json().catch(() => null); atts = Array.isArray(aj?.data) ? aj.data : []; }
    }
    const pdfs = atts.filter(isPdfAttachment);
    if (!pdfs.length) {
      await setDoc(markerDoc(id), { outcome: 'ignored', reason: 'no pdf attachment', at: now(), from: email?.from ?? null, subject: email?.subject ?? null });
      outcomes.push({ id, outcome: 'ignored', reason: 'no pdf attachment' });
      processed += 1;
      continue;
    }

    let stored = false; let lastErr: string | null = null; let sawNonManifest = false;
    for (const att of pdfs) {
      try {
        // download_url expires; on a stale one, re-list attachments for a fresh URL.
        let urlToGet = String(att?.download_url ?? '');
        if (!urlToGet) {
          const aResp = await fetchImpl(`${RESEND_BASE}/emails/receiving/${encodeURIComponent(id)}/attachments`, { headers: hdr });
          const aj: any = aResp.ok ? await aResp.json().catch(() => null) : null;
          const fresh = (Array.isArray(aj?.data) ? aj.data : []).find((x: any) => String(x?.id ?? '') === String(att?.id ?? '')) || null;
          urlToGet = String(fresh?.download_url ?? '');
        }
        if (!urlToGet) { lastErr = 'no download_url'; continue; }
        const dl = await fetchImpl(urlToGet);
        if (!dl.ok) { lastErr = `download ${dl.status}`; continue; }
        const buf = Buffer.from(await dl.arrayBuffer());
        const diff = await runDiff(buf);
        if (diff?.ok) {
          const run = toStoredEmailRun(diff, email, String(att?.filename ?? '') || null, now());
          await setDoc(LATEST_DOC, run);
          await setDoc(markerDoc(id), { outcome: 'checked', at: run.at, suspects: run.suspectsTotal, from: run.from, subject: run.subject });
          outcomes.push({ id, outcome: 'checked', suspects: run.suspectsTotal });
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
      outcomes.push({ id, outcome: 'retry', reason: lastErr });
      continue;
    }
    if (sawNonManifest) {
      await setDoc(markerDoc(id), { outcome: 'ignored', reason: 'pdf is not the freight report', at: now(), from: email?.from ?? null, subject: email?.subject ?? null });
      outcomes.push({ id, outcome: 'ignored', reason: 'pdf is not the freight report' });
      processed += 1;
    }
  }

  return { ok: true, inbox: emails.length, processed, outcomes };
}
