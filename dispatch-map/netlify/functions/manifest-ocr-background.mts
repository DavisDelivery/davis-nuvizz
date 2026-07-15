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

import { MANIFEST_SYSTEM, MANIFEST_PROMPT, extractJsonBlock, normalizeManifestRows } from './lib/manifest-extract.mts';
import { isFirestoreEnabled, setDoc } from './lib/firestore.mts';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Sonnet by default — fax-quality digits (PRO numbers) punish a weaker reader.
const OCR_MODEL = process.env.ANTHROPIC_OCR_MODEL || 'claude-sonnet-4-6';
// Generous now that we're off the request path; still bounded so a hung upstream call
// can't pin the function for the full 15-minute background allowance.
const OCR_TIMEOUT_MS = 110_000;
// Netlify background functions cap the request BODY around 256 KB — the client checks
// before sending; this is the server-side backstop. (A typical Estes fax page is ~40 KB
// of base64, so 5-page manifests fit comfortably.)
const MAX_B64_CHARS = 250_000;

export const jobDocPath = (jobId: string) => `nuvizz_ops/manifest_ocr__${jobId}`;
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
  const pdfBase64 = String(body?.pdfBase64 || '');
  if (!isValidJobId(jobId)) return J({ ok: false, error: 'bad jobId' }, 400);
  if (!pdfBase64) return J({ ok: false, error: 'pdfBase64 required' }, 400);
  if (pdfBase64.length > MAX_B64_CHARS) return J({ ok: false, error: 'PDF too large for background processing — split it and drop the halves.' }, 413);
  // '%PDF' base64-encodes to 'JVBERi' — cheap sanity check that this is actually a PDF.
  if (!pdfBase64.startsWith('JVBERi')) return J({ ok: false, error: 'That file does not look like a PDF.' }, 400);

  const doc = jobDocPath(jobId);
  const stamp = () => new Date().toISOString();
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
        max_tokens: 6000,
        temperature: 0,
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
    const parsed = extractJsonBlock(text);
    if (!parsed) { await setDoc(doc, { status: 'error', error: 'The reader returned no usable JSON — try the drop again.', created_at: stamp() }); return J({ ok: true, jobId }); }
    const { manifest, rows, warnings } = normalizeManifestRows(parsed);
    if (!rows.length) { await setDoc(doc, { status: 'error', error: 'No consignee rows could be read from this PDF.', warnings, created_at: stamp() }); return J({ ok: true, jobId }); }
    await setDoc(doc, { status: 'done', manifest, rows, warnings, created_at: stamp() });
    return J({ ok: true, jobId });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    await setDoc(doc, { status: 'error', error: aborted ? 'The AI reader took over 110s — try again.' : (e?.message || 'manifest read failed'), created_at: stamp() }).catch(() => {});
    return J({ ok: true, jobId });
  } finally {
    clearTimeout(timer);
  }
};
