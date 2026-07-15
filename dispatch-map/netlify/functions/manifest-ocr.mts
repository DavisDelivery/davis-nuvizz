// manifest-ocr.mts
//
// Read a SCANNED carrier delivery manifest (Estes-style PDF — pure fax images, zero
// embedded text) into structured order rows for Bulk Add. The client POSTs the PDF as
// base64; this function hands it to Claude vision with a strict-JSON extraction prompt
// (lib/manifest-extract.mts) and returns the normalized rows + integrity warnings. The
// rows always land in Bulk Add's editable review grid — nothing is created from here.
//
//   POST { pdfBase64: string, filename?: string }
//   →    { ok, manifest: {carrier, manifestNumber, manifestDate, totalPros},
//          rows: ManifestRow[], warnings: string[] }
//
// ZERO NuVizz calls. Costs one Anthropic vision call per manifest (a few cents; the
// same ANTHROPIC_API_KEY that powers AI search). Fires only on an explicit file drop.

import { MANIFEST_SYSTEM, MANIFEST_PROMPT, extractJsonBlock, normalizeManifestRows } from './lib/manifest-extract.mts';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Sonnet by default — fax-quality digits (PRO numbers) punish a weaker reader.
const OCR_MODEL = process.env.ANTHROPIC_OCR_MODEL || 'claude-sonnet-4-6';
// Abort before Netlify's 26s kill so the client gets clean JSON, not an HTML 502
// (same pattern as nuvizz-stop-explorer).
const OCR_TIMEOUT_MS = 22000;
// ~6 MB of base64 (≈4.5 MB PDF). Real manifests are ~100 KB fax scans; this cap only
// blocks a mistaken drop of some huge document.
const MAX_B64_CHARS = 8_000_000;

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const J = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers });

  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers });
  if (req.method !== 'POST') return J({ ok: false, error: 'POST only' }, 405);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return J({ ok: false, error: 'AI is not configured on this site (ANTHROPIC_API_KEY unset) — manifest reading needs it.' });

  let body: any;
  try { body = await req.json(); } catch { return J({ ok: false, error: 'invalid JSON body' }, 400); }
  const pdfBase64 = String(body?.pdfBase64 || '');
  if (!pdfBase64) return J({ ok: false, error: 'pdfBase64 required' }, 400);
  if (pdfBase64.length > MAX_B64_CHARS) return J({ ok: false, error: 'PDF too large — manifests are small fax scans; this file is over ~4.5 MB.' }, 413);
  // '%PDF' base64-encodes to 'JVBERi' — cheap sanity check that this is actually a PDF.
  if (!pdfBase64.startsWith('JVBERi')) return J({ ok: false, error: 'That file does not look like a PDF.' }, 400);

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
      return J({ ok: false, error: `anthropic_${resp.status}: ${(await resp.text()).slice(0, 200)}` });
    }
    const data: any = await resp.json();
    const text = (data?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim();
    const parsed = extractJsonBlock(text);
    if (!parsed) return J({ ok: false, error: 'The reader returned no usable JSON — try the drop again.' });
    const { manifest, rows, warnings } = normalizeManifestRows(parsed);
    if (!rows.length) return J({ ok: false, error: 'No consignee rows could be read from this PDF.', manifest, warnings });
    return J({ ok: true, manifest, rows, warnings });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return J({ ok: false, error: aborted ? 'Reading the manifest took too long — try again (or split a very long PDF).' : (e?.message || 'manifest read failed') });
  } finally {
    clearTimeout(timer);
  }
};
