// nuvizz-pod.mts
//
// On-demand proof-of-delivery (POD) image/document proxy. NuVizz's v7 OpenAPI does NOT
// document a doc-download endpoint; the portal serves POD images from an internal document
// service whose URL we keep server-side. The board carries each POD's `documentPath` (a ready
// query string: cc=…&objType=stop&docGuid=…&ext=jpg&docName=…). This function fetches the bytes
// with the Basic creds and streams them back, so the browser never sees creds.
//
//   GET ?documentPath=<the podDoc.documentPath>        → image/pdf bytes
//   GET ?probe=1&documentPath=<...>                    → DIAGNOSTIC: try candidate bases,
//                                                        report which returns real bytes.
import { basicAuthHeader } from './lib/nuvizz-scan.mts';

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';
const DELIVERIT = NUVIZZ_BASE.replace(/\/openapi\/v7\/?$/, ''); // → https://portal.nuvizz.com/deliverit

// Candidate document-service paths (the querystring from documentPath is appended). The
// confirmed one can be pinned via NUVIZZ_DOC_URL so we stop probing.
function candidateBases(): string[] {
  const pinned = process.env.NUVIZZ_DOC_URL;
  if (pinned) return [pinned];
  return [
    `${DELIVERIT}/document`,
    `${DELIVERIT}/documentapi`,
    `${DELIVERIT}/documentapi/document`,
    `${DELIVERIT}/document/download`,
    `${DELIVERIT}/rest/document`,
    `${DELIVERIT}/documentServlet`,
    `${DELIVERIT}/openapi/document`,
    `${NUVIZZ_BASE}/document`,
    `${NUVIZZ_BASE}/document/download`,
  ];
}

const looksLikeBytes = (ct: string, len: number) =>
  /image\/|application\/pdf|application\/octet-stream/i.test(ct) || (!/text\/html|application\/json/i.test(ct) && len > 1024);

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  const url = new URL(req.url);
  const documentPath = url.searchParams.get('documentPath') || '';
  if (!documentPath.trim()) return new Response(JSON.stringify({ ok: false, reason: 'missing documentPath' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  const auth = { Authorization: basicAuthHeader() };
  const qs = documentPath.startsWith('?') ? documentPath : `?${documentPath}`;

  // DIAGNOSTIC: probe candidates, report what each returns (read-only).
  if (url.searchParams.get('probe')) {
    const out: any[] = [];
    for (const base of candidateBases()) {
      try {
        const r = await fetch(`${base}${qs}`, { headers: auth });
        const ct = r.headers.get('content-type') || '';
        const buf = r.ok ? await r.arrayBuffer() : new ArrayBuffer(0);
        out.push({ base, status: r.status, contentType: ct, bytes: buf.byteLength, looksLikeImage: looksLikeBytes(ct, buf.byteLength) });
      } catch (e: any) { out.push({ base, error: e?.message || 'fetch failed' }); }
    }
    return new Response(JSON.stringify({ ok: true, results: out }, null, 2), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  // Normal: fetch from the first candidate that returns real bytes; stream it back.
  for (const base of candidateBases()) {
    try {
      const r = await fetch(`${base}${qs}`, { headers: auth });
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || 'application/octet-stream';
      const buf = await r.arrayBuffer();
      if (!looksLikeBytes(ct, buf.byteLength)) continue;
      return new Response(buf, { status: 200, headers: { ...cors, 'Content-Type': ct } });
    } catch { /* try next */ }
  }
  return new Response(JSON.stringify({ ok: false, reason: 'document not retrievable' }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
};
