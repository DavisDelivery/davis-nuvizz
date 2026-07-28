// manifest-ocr-background.mts
//
// Read a SCANNED carrier delivery manifest (Estes-style PDF — pure fax images, zero
// embedded text) into structured order rows for Bulk Add — as a Netlify BACKGROUND
// function. The first (synchronous) version of this OCR hit Netlify's 26s request cap:
// Claude vision over a 3-page fax scan reliably needs 20-40s, so the request aborted at
// 22s and the dispatcher saw "took too long" on every real manifest. Background functions
// get 15 minutes: the client POSTs {jobId, pdfBase64}, Netlify replies 202 immediately,
// this handler runs the OCR and writes the outcome to Firestore, and the client polls
// manifest-ocr-result?job=<id> for it.
//
// Job doc: nuvizz_ops/manifest_ocr__<jobId> → { status: 'reading'|'done'|'error', ... }.
// Docs are tiny (rows JSON ≲20 KB) and stamped created_at; the result endpoint deletes
// them best-effort once read.
//
// ZERO NuVizz calls. One Anthropic vision call per manifest (a few cents; the same
// ANTHROPIC_API_KEY that powers AI search). Fires only on an explicit file drop.

import { MANIFEST_SYSTEM, MANIFEST_PROMPT, extractManifestJson, normalizeManifestRows } from './lib/manifest-extract.mts';
import { isFirestoreEnabled, setDoc, getDoc, deleteDoc } from './lib/firestore.mts';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Sonnet 5 by default — fax-quality digits (PRO numbers) punish a weaker reader,
// so we run the strongest current Sonnet vision model (upgraded from
// claude-sonnet-4-6). Overridable per-site via ANTHROPIC_OCR_MODEL with no deploy.
const OCR_MODEL = process.env.ANTHROPIC_OCR_MODEL || 'claude-sonnet-5';
// Generous now that we're off the request path; still bounded so a hung upstream call
// can't pin the function for the full 15-minute background allowance. A heavy
// high-resolution scan takes longer than the old 3-page fax baseline, so this is
// wider than the original 110s (the client polls up to 6 minutes).
const OCR_TIMEOUT_MS = Math.max(60_000, Number(process.env.MANIFEST_OCR_TIMEOUT_MS) || 300_000);
// Netlify background functions cap the request BODY around 256 KB, so an INLINE
// pdfBase64 is limited to this; the client sends anything bigger through the chunked
// manifest-upload path ({jobId, chunks: N} here) instead of inlining it.
const MAX_B64_CHARS = 250_000;
// Assembled (chunked) PDFs: ≤32 parts × ≤900k chars ≈ 21 MB base64 (~16 MB PDF) —
// far past any fax manifest, still well under the AI reader's 32 MB request cap.
export const MAX_PDF_CHUNKS = 32;
export const MAX_CHUNK_B64_CHARS = 900_000;
const MAX_TOTAL_B64_CHARS = MAX_PDF_CHUNKS * MAX_CHUNK_B64_CHARS;

export const jobDocPath = (jobId: string) => `nuvizz_ops/manifest_ocr__${jobId}`;
export const pdfChunkDocPath = (jobId: string, seq: number) => `nuvizz_ops/manifest_pdf__${jobId}__${seq}`;
export const isValidJobId = (id: string) => /^[a-z0-9-]{8,64}$/.test(id);

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const J = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers });

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers });
  if (req.method !== 'POST') return J({ ok: false, error: 'POST only' }, 405);
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  let body: any;
  try { body = await req.json(); } catch { return J({ ok: false, error: 'invalid JSON body' }, 400); }
  const jobId = String(body?.jobId || '').toLowerCase();
  let pdfBase64 = String(body?.pdfBase64 || '');
  const chunks = Number(body?.chunks || 0);
  if (!isValidJobId(jobId)) return J({ ok: false, error: 'bad jobId' }, 400);
  if (!pdfBase64 && !chunks) return J({ ok: false, error: 'pdfBase64 or chunks required' }, 400);

  const doc = jobDocPath(jobId);
  const stamp = () => new Date().toISOString();

  if (pdfBase64) {
    // Inline path (small PDFs) — bounded by the background-function body cap.
    if (pdfBase64.length > MAX_B64_CHARS) return J({ ok: false, error: 'PDF too large for an inline drop — the app uploads big files in parts; hard-refresh the app and drop it again.' }, 413);
  } else {
    // Chunked path: reassemble the base64 the client uploaded via manifest-upload.
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_PDF_CHUNKS) return J({ ok: false, error: 'bad chunk count' }, 400);
    const parts: string[] = [];
    for (let i = 0; i < chunks; i++) {
      const c: any = await getDoc(pdfChunkDocPath(jobId, i)).catch(() => null);
      if (!c || typeof c.data !== 'string' || !c.data) {
        await setDoc(doc, { status: 'error', error: `Upload incomplete — part ${i + 1} of ${chunks} never arrived. Drop the file again.`, created_at: stamp() }).catch(() => {});
        return J({ ok: true, jobId });
      }
      parts.push(c.data);
    }
    pdfBase64 = parts.join('');
    // Chunks are single-use — clean up now (best-effort) so they never accumulate,
    // whatever the OCR outcome below.
    for (let i = 0; i < chunks; i++) deleteDoc(pdfChunkDocPath(jobId, i)).catch(() => {});
    if (pdfBase64.length > MAX_TOTAL_B64_CHARS) {
      await setDoc(doc, { status: 'error', error: 'That PDF is too large for the reader (over ~16 MB) — print-to-PDF a smaller page range and drop that.', created_at: stamp() }).catch(() => {});
      return J({ ok: true, jobId });
    }
  }
  // '%PDF' base64-encodes to 'JVBERi' — cheap sanity check that this is actually a PDF.
  if (!pdfBase64.startsWith('JVBERi')) return J({ ok: false, error: 'That file does not look like a PDF.' }, 400);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    await setDoc(doc, { status: 'error', error: 'AI is not configured on this site (ANTHROPIC_API_KEY unset) — manifest reading needs it.', created_at: stamp() }).catch(() => {});
    return J({ ok: true, jobId });
  }
  await setDoc(doc, { status: 'reading', created_at: stamp() }).catch(() => {});

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), OCR_TIMEOUT_MS);
  try {
    const resp = await fetch(MESSAGES_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OCR_MODEL,
        // A 37-PRO Estes manifest pretty-printed lands around 4k output tokens — 68% of the
        // old 6000 cap, so a routine 50-80 PRO manifest silently overran it, the response
        // stopped mid-row, and the whole file failed as "no usable JSON". The prompt now asks
        // for COMPACT JSON (roughly halves the output) and the cap is wide enough that even a
        // pretty-printed 150-row manifest fits. Truncation is also DETECTED below and its
        // complete rows recovered, so this is depth, not the only defense.
        max_tokens: 32000,
        // NO temperature: claude-sonnet-5 DEPRECATED the parameter — sending it
        // is a hard 400 ("`temperature` is deprecated for this model"), which
        // broke every manifest/paste read the moment v0.50.77 switched models
        // (Chad hit it live, 7/23). Older models treat the omission as default,
        // so leaving it off is correct across every ANTHROPIC_OCR_MODEL value.
        system: MANIFEST_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
            { type: 'text', text: MANIFEST_PROMPT },
          ],
        }],
      }),
    });
    if (!resp.ok) {
      // Surface the status but never the key; trim the body so we never leak much.
      await setDoc(doc, { status: 'error', error: `anthropic_${resp.status}: ${(await resp.text()).slice(0, 200)}`, created_at: stamp() });
      return J({ ok: true, jobId });
    }
    const data: any = await resp.json();
    const text = (data?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim();
    // stop_reason tells us WHY a response is short. Without it, a response cut off at the
    // token cap was indistinguishable from garbage and got reported as "try the drop again"
    // — advice that could never work, because the same PDF truncates identically every time.
    const cutOff = data?.stop_reason === 'max_tokens';
    const { parsed, repairs } = extractManifestJson(text);
    if (!parsed) {
      // Keep a slice of what the reader actually said. A bare "no usable JSON" left nothing
      // to diagnose the NEXT time this happens.
      await setDoc(doc, {
        status: 'error',
        error: cutOff
          ? 'The reader ran out of room before finishing this manifest and nothing could be recovered — split the PDF into two halves and drop them separately.'
          : 'The reader returned no usable JSON. This PDF fails the same way every time, so re-dropping it will not help — send it to Chad/support with this message.',
        raw_snippet: text.slice(0, 800),
        stop_reason: data?.stop_reason ?? null,
        created_at: stamp(),
      });
      return J({ ok: true, jobId });
    }
    const { manifest, rows, warnings, integrity } = normalizeManifestRows(parsed);
    if (!rows.length) { await setDoc(doc, { status: 'error', error: 'No consignee rows could be read from this PDF.', warnings, raw_snippet: text.slice(0, 800), created_at: stamp() }); return J({ ok: true, jobId }); }
    // Any repair is loud: the dispatcher must know the file needed fixing up, because a
    // repaired read is exactly where a missing order would hide.
    const allWarnings = repairs.length
      ? [`The reader's response was malformed and had to be repaired (${repairs.join('; ')}) — check the row count against the paper.`, ...warnings]
      : warnings;
    if (cutOff) allWarnings.unshift('The reader hit its output limit — rows after the cut are MISSING. Split this manifest and re-drop if the count is short.');
    await setDoc(doc, { status: 'done', manifest, rows, warnings: allWarnings, integrity, created_at: stamp() });
    return J({ ok: true, jobId });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    await setDoc(doc, { status: 'error', error: aborted ? `The AI reader took over ${Math.round(OCR_TIMEOUT_MS / 1000)}s — try again.` : (e?.message || 'manifest read failed'), created_at: stamp() }).catch(() => {});
    return J({ ok: true, jobId });
  } finally {
    clearTimeout(timer);
  }
};
