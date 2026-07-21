// manifest-upload.mts
//
// Chunked PDF upload for the manifest reader. Netlify BACKGROUND functions cap the
// request body around 256 KB, which used to hard-limit manifest PDFs to ~176 KB — a
// high-resolution fax scan (Chad's Manifest_04753105: 5 pages, 3.9 MB) was rejected
// outright. This SYNC function (regular ~6 MB body limit) accepts the PDF's base64 in
// numbered parts and stores each as its own Firestore doc; the client then kicks
// manifest-ocr-background with {jobId, chunks: N} and it reassembles + deletes them.
//
//   POST { jobId, seq, total, data }  → { ok: true, seq }
//
// Chunk doc: nuvizz_ops/manifest_pdf__<jobId>__<seq> → { data, total, created_at }.
// Bounds: ≤900k base64 chars per part (Firestore doc limit is 1 MiB), ≤32 parts
// (~21 MB base64 ≈ 16 MB PDF — comfortably past any fax manifest, still far under the
// AI reader's 32 MB request cap). ZERO NuVizz calls, zero AI — Firestore writes only.

import { isFirestoreEnabled, setDoc } from './lib/firestore.mts';
import { isValidJobId, pdfChunkDocPath, MAX_PDF_CHUNKS, MAX_CHUNK_B64_CHARS } from './manifest-ocr-background.mts';

// PURE validation, exported for tests. Returns an error string, or null when valid.
export function validateChunkReq(body: any): string | null {
  if (!body || typeof body !== 'object') return 'invalid body';
  if (!isValidJobId(String(body.jobId || '').toLowerCase())) return 'bad jobId';
  const seq = body.seq, total = body.total;
  if (!Number.isInteger(total) || total < 1 || total > MAX_PDF_CHUNKS) return `total must be 1-${MAX_PDF_CHUNKS}`;
  if (!Number.isInteger(seq) || seq < 0 || seq >= total) return 'seq out of range';
  const data = body.data;
  if (typeof data !== 'string' || !data.length) return 'data required';
  if (data.length > MAX_CHUNK_B64_CHARS) return `chunk too large (>${MAX_CHUNK_B64_CHARS} chars)`;
  // base64 alphabet only — a chunk is a SLICE of a base64 stream, so padding may only
  // appear in the final part; a lax check ('=' allowed anywhere) still rejects raw binary.
  if (!/^[A-Za-z0-9+/=]+$/.test(data)) return 'data is not base64';
  return null;
}

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const J = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers });

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers });
  if (req.method !== 'POST') return J({ ok: false, error: 'POST only' }, 405);
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  let body: any;
  try { body = await req.json(); } catch { return J({ ok: false, error: 'invalid JSON body' }, 400); }
  const err = validateChunkReq(body);
  if (err) return J({ ok: false, error: err }, 400);

  const jobId = String(body.jobId).toLowerCase();
  try {
    await setDoc(pdfChunkDocPath(jobId, body.seq), {
      data: body.data, total: body.total, created_at: new Date().toISOString(),
    });
    return J({ ok: true, seq: body.seq });
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'chunk write failed' }, 500);
  }
};
