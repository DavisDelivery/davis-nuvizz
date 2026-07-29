// loadscan-admin.mts — server-to-server proxy from dispatch-map to the load-scan
// driver credential endpoints.
//
// WHY A PROXY AND NOT DIRECT CALLS
//
// The Drivers panel lives in dispatch-map because that is where dispatch already
// works all day. But load-scan's admin endpoints are on a DIFFERENT origin
// (ddsloadout vs dd-dispatch-map), so a browser calling them from here would need
// Access-Control-Allow-Origin on the endpoints that write PIN hashes. load-scan
// deliberately has no CORS header anywhere, and adding one there would be the
// worst possible place for it.
//
// So this function makes the hop server side. Nothing about the credential store
// is duplicated: PIN hashing, lockout and alias resolution all stay in load-scan,
// which remains the single writer.
//
// WHAT AUTHORIZES A CALL — read this before changing it
//
// Two independent things must both hold:
//   1. The CALLER must present a load-scan dispatcher token, which this function
//      forwards untouched. load-scan verifies the signature and the dispatcher
//      role. Authorization decisions are NOT made here.
//   2. This function adds LOADSCAN_ADMIN_PROXY_SECRET, which proves to load-scan
//      that the request came from dispatch-map's server rather than from an
//      arbitrary client holding a leaked token.
//
// dispatch-map itself has no login, so (1) is what stops this endpoint from being
// an open credential-issuing hole on a publicly reachable site. Do not "simplify"
// it away.

const LOADSCAN_BASE = process.env.LOADSCAN_BASE_URL || 'https://ddsloadout.netlify.app';

// Explicit allowlist. Without it this becomes an open relay into load-scan.
const ALLOWED = new Set(['driver-login', 'driver-admin', 'driver-alias-report']);

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export default async (req: Request): Promise<Response> => {
  const secret = process.env.LOADSCAN_ADMIN_PROXY_SECRET;
  if (!secret || secret.length < 16) {
    console.error('[loadscan-admin] LOADSCAN_ADMIN_PROXY_SECRET is missing or too short');
    return json({ ok: false, error: 'proxy not configured' }, 503);
  }

  const url = new URL(req.url);
  const target = String(url.searchParams.get('target') || '');
  if (!ALLOWED.has(target)) return json({ ok: false, error: `target not allowed: ${target}` }, 400);

  // driver-login is the only target reachable without a token — it is how the
  // dispatcher gets one. Everything else must already carry it.
  const auth = req.headers.get('authorization') || '';
  if (target !== 'driver-login' && !/^Bearer\s+\S+/i.test(auth)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  // Forward the caller's own query string, minus our routing param.
  const forward = new URL(`${LOADSCAN_BASE}/.netlify/functions/${target}`);
  for (const [k, v] of url.searchParams) if (k !== 'target') forward.searchParams.set(k, v);

  const body = req.method === 'POST' || req.method === 'PUT' ? await req.text() : undefined;

  let resp: Response;
  try {
    resp = await fetch(forward.toString(), {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: auth } : {}),
        'x-proxy-secret': secret,
      },
      ...(body ? { body } : {}),
    });
  } catch (e: any) {
    console.error('[loadscan-admin] upstream unreachable', e?.message || e);
    return json({ ok: false, error: 'load-scan is unreachable' }, 502);
  }

  const text = await resp.text();
  // Pass the upstream status through so the panel can distinguish 401 from 403
  // from 409 rather than seeing everything as a generic failure.
  return new Response(text, {
    status: resp.status,
    headers: { ...HEADERS, 'Content-Type': resp.headers.get('content-type') || 'application/json' },
  });
};
