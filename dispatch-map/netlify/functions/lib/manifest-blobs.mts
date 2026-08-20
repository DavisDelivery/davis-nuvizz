// lib/manifest-blobs.mts
//
// WHERE THE PDFs ACTUALLY LIVE. Chad: "we need to download the PDF and put them in our
// system." A night is 4-5 reports and this runs every night, so the archive is a few
// thousand PDFs a year — which is exactly what Netlify Blobs is for and exactly what
// Firestore is not (a document caps at 1 MB, which is why the drop screen has to chunk a
// PDF into base64 parts to get it in at all).
//
// EVERYTHING HERE IS BEST-EFFORT AND SAYS SO. The day record is written to Firestore either
// way and carries pdfStored plus the failure text, because a blobKey pointing at bytes that
// were never written is worse than an honest "PDF not stored" — the first one is only
// discovered months later by the person who needed the document.
//
// The import is dynamic so a runtime without the package (a unit test, a local node run)
// degrades to "not configured" instead of failing to load the module that the whole nightly
// ingest hangs off.
import { MANIFEST_BLOB_STORE } from './manifest-archive.mts';

let storePromise: Promise<any | null> | null = null;

async function store(): Promise<any | null> {
  if (!storePromise) {
    storePromise = (async () => {
      try {
        const mod: any = await import('@netlify/blobs');
        return mod?.getStore ? mod.getStore(MANIFEST_BLOB_STORE) : null;
      } catch { return null; }
    })();
  }
  return storePromise;
}

export async function blobsAvailable(): Promise<boolean> {
  return !!(await store());
}

/** Write one PDF. Returns what HAPPENED, never throws — the ingest must not lose a night's
 *  diff because an object store had a bad minute. */
export async function putManifestPdf(key: string, buf: Buffer, meta: Record<string, any> = {}): Promise<{
  ok: boolean; error: string | null;
}> {
  const s = await store();
  if (!s) return { ok: false, error: 'blob store unavailable (@netlify/blobs not loaded)' };
  try {
    await s.set(key, buf, { metadata: { contentType: 'application/pdf', ...meta } });
    return { ok: true, error: null };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** Read one PDF back, or null when it is not there. Never throws. */
export async function getManifestPdf(key: string): Promise<Buffer | null> {
  const s = await store();
  if (!s) return null;
  try {
    const ab = await s.get(key, { type: 'arrayBuffer' });
    return ab ? Buffer.from(ab as ArrayBuffer) : null;
  } catch { return null; }
}

/** Round-trip a tiny object so "is the archive actually writing?" is one click rather than a
 *  question answered months later by its absence. See manifest-history?selftest=1. */
export async function blobSelfTest(): Promise<{ ok: boolean; step: string; error: string | null }> {
  const s = await store();
  if (!s) return { ok: false, step: 'load', error: 'blob store unavailable (@netlify/blobs not loaded)' };
  const key = '__selftest/roundtrip.bin';
  const payload = Buffer.from(`manifest-archive selftest ${new Date().toISOString()}`);
  try { await s.set(key, payload); } catch (e: any) { return { ok: false, step: 'write', error: String(e?.message || e).slice(0, 200) }; }
  let back: Buffer | null = null;
  try { const ab = await s.get(key, { type: 'arrayBuffer' }); back = ab ? Buffer.from(ab as ArrayBuffer) : null; } catch (e: any) { return { ok: false, step: 'read', error: String(e?.message || e).slice(0, 200) }; }
  if (!back || !back.equals(payload)) return { ok: false, step: 'verify', error: 'what came back is not what went in' };
  try { await s.delete(key); } catch { /* leaving one tiny object behind is not a failure */ }
  return { ok: true, step: 'done', error: null };
}
