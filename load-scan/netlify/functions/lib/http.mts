// http.mts — shared response helpers.
//
// ── CORS POSTURE (deliberate) ────────────────────────────────────────────────
//
// There is NO Access-Control-Allow-Origin header anywhere in load-scan, and that
// is the point. The PWA is served from the same origin as these functions, so
// same-origin requests need no CORS grant at all. Adding a permissive header buys
// nothing and costs everything.
//
// Davis-wms's netlify/functions/nuvizz-lookup.js is unauthenticated with
// Access-Control-Allow-Origin: * and returns consignee names and street
// addresses. That is a known pre-existing issue on an internal tool. It must not
// be reproduced on an app installed on 50 personal phones — anything with that
// header becomes readable by any page the driver has open.
//
// Every endpoint here requires a valid bearer token. No exceptions.

const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: BASE_HEADERS });
}

export const ok = (body: any) => json({ ok: true, ...body });
export const bad = (error: string, status = 400) => json({ ok: false, error }, status);
export const unauthorized = () => json({ ok: false, error: 'unauthorized' }, 401);
export const forbidden = (error = 'forbidden') => json({ ok: false, error }, 403);

/** Parse a JSON body, never throwing on malformed input. */
export async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

/** ET calendar day — the dock's day, not UTC's. */
export function etDayString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Did this request arrive through dispatch-map's server-side proxy?
 *
 * Honest about what this is worth: the dispatcher TOKEN is the authorization gate,
 * not this header. The shared secret proves provenance — that the hop came from
 * dispatch-map's function rather than an arbitrary client — and it is logged so an
 * admin action can be traced to a surface. Browser access from load-scan's own
 * break-glass panel legitimately arrives WITHOUT it, so this must not be a hard
 * requirement or that path dies the moment dispatch-map is the only way in.
 */
export function viaProxy(req: Request): boolean {
  const want = process.env.LOADSCAN_ADMIN_PROXY_SECRET;
  if (!want || want.length < 16) return false;
  const got = req.headers.get('x-proxy-secret') || '';
  if (got.length !== want.length) return false;
  // Constant-time compare: this value is long-lived and shared between two sites.
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
