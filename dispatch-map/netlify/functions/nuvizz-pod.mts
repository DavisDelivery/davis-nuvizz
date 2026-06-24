// nuvizz-pod.mts
//
// On-demand proof-of-delivery (POD) photo proxy. Per the NuVizz Photo-Pull guide, the actual
// image bytes come from the deliverIt *documentapi* (NOT in the v7 OpenAPI):
//
//   GET {docBase}/doc/getdocument/{companyCode}?documentGuid=<g>&objectType=02&extension=<ext>
//   docBase = https://portal.nuvizz.com/deliverit/openapi/documentapi   (Basic auth)
//   → { documentData: "<base64 image bytes>" }
//
// The board already carries each POD's `documentPath` (cc=…&objType=stop&docGuid=…&ext=jpg&…),
// so the client can just hand us that. We pull with the server-side Basic creds (through the
// metered requester), decode the base64, and stream the image back — creds never reach the
// browser, so an <img src="/.netlify/functions/nuvizz-pod?documentPath=…"> just works. Host
// failover (portal → contact-support) mirrors the rest of the scanner.
//
//   GET ?documentPath=<podDoc.documentPath>                  → image bytes
//   GET ?documentGuid=<g>&extension=<ext>&cc=<companyCode>   → image bytes (explicit)
//   add &format=datauri                                      → { dataUri } JSON instead
import { getNuvizzRequester } from './lib/nuvizz-request.mts';
import { getCreds, basicAuthHeader } from './lib/nuvizz-scan.mts';

const NUVIZZ_BASE = process.env.NUVIZZ_BASE_URL || 'https://portal.nuvizz.com/deliverit/openapi/v7';
// documentapi base, e.g. https://portal.nuvizz.com/deliverit/openapi/documentapi
const DOC_BASE = process.env.NUVIZZ_DOC_BASE || NUVIZZ_BASE.replace(/\/v7\/?$/, '/documentapi');
const FAILOVER = (u: string) => u.replace('portal.nuvizz.com', 'contact-support.nuvizz.com');

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', pdf: 'application/pdf' };

export default async (req: Request): Promise<Response> => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=300' };
  const jsonHdr = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: cors });
  const url = new URL(req.url);

  // Resolve guid / extension / company from either an explicit set or the podDoc.documentPath.
  let guid = url.searchParams.get('documentGuid') || '';
  let ext = (url.searchParams.get('extension') || '').toLowerCase();
  let cc = url.searchParams.get('cc') || '';
  const documentPath = url.searchParams.get('documentPath') || '';
  if (documentPath) {
    const sp = new URLSearchParams(documentPath.startsWith('?') ? documentPath.slice(1) : documentPath);
    guid = guid || sp.get('docGuid') || sp.get('documentGuid') || '';
    ext = ext || (sp.get('ext') || sp.get('extension') || '').toLowerCase();
    cc = cc || sp.get('cc') || '';
  }
  if (!cc) cc = getCreds().companyCode;
  if (!guid) return new Response(JSON.stringify({ ok: false, reason: 'missing documentGuid' }), { status: 400, headers: jsonHdr });
  ext = ext || 'jpg';

  const headers = { Authorization: basicAuthHeader(), Accept: 'application/json' };
  const reqr = getNuvizzRequester();
  const path = `/doc/getdocument/${encodeURIComponent(cc)}?documentGuid=${encodeURIComponent(guid)}&objectType=02&extension=${encodeURIComponent(ext)}`;
  const primary = `${DOC_BASE}${path}`;

  let lastErr = '';
  for (const target of [primary, FAILOVER(primary)]) {
    try {
      const r = await reqr.request(target, { method: 'GET', headers }, { route: '/documentapi/getdocument', tenant: cc });
      if (!r.ok) { lastErr = `http_${r.status}`; continue; }
      const j: any = await r.json();
      const b64 = j?.documentData || j?.documentdata || j?.data;
      if (!b64 || typeof b64 !== 'string') { lastErr = 'no_documentData'; continue; }
      const mime = MIME[ext] || 'application/octet-stream';
      if (url.searchParams.get('format') === 'datauri') {
        return new Response(JSON.stringify({ ok: true, dataUri: `data:${mime};base64,${b64}` }), { status: 200, headers: jsonHdr });
      }
      const bytes = Buffer.from(b64, 'base64');
      return new Response(bytes, { status: 200, headers: { ...cors, 'Content-Type': mime } });
    } catch (e: any) { lastErr = e?.message || 'request failed'; }
  }
  return new Response(JSON.stringify({ ok: false, reason: lastErr || 'document not retrievable' }), { status: 502, headers: jsonHdr });
};
