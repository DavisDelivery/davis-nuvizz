// rollback-request.mts
//
// The footer's rollback button, server side. Files a GitHub issue asking for a rollback, so a
// coding agent (or a person) picks it up and opens the PR.
//
// WHY AN ISSUE AND NOT A PUSH, which is the whole security design of this file.
//
// A Netlify function cannot host a repo + git, so it could not run scripts/rollback.mjs even if
// we wanted it to — it would have to rewrite main through the GitHub API instead. That is a
// browser-reachable endpoint that can commit code to Davis's repo, and debug-capture.mts drew
// exactly this line first: "Nothing here ever pushes to main or deploys; the agent opens a PR
// the dispatcher reviews." This file stays on the same side of it. Chad taps once on his phone,
// an issue appears, the agent opens a rollback PR, CI runs, auto-merge lands it. Every step that
// changes code still passes through review the same way every other change does.
//
// That is not a compromise for its own sake. The failure this whole feature exists to prevent is
// "a change nobody asked for reached production". A one-tap path that writes straight to main
// would be a new way to do precisely that, from a phone, with no dry run in between.
//
// Required env (absent = the endpoint answers 503 and the panel degrades to read-only, which is
// the honest failure: the list still tells him what shipped and what a rollback would cost):
//   ROLLBACK_GH_TOKEN   PAT with Issues:write. Falls back to the debug-capture token, then GH_TOKEN.
//   NOTE: GITHUB_TOKEN is RESERVED on Netlify and cannot be set as a project env var.
// Optional env:
//   ROLLBACK_REPO       "owner/repo"   (default: DavisDelivery/davis-nuvizz)
//   ROLLBACK_LABELS     "a,b"          (default: none — a missing label 422s the whole create)
//   ROLLBACK_MENTION    prepended to the body, e.g. "@claude" to trigger the GitHub agent
import { requireUser } from './lib/require-user.mts';

const DEFAULT_REPO = 'DavisDelivery/davis-nuvizz';
const MAX_BODY_CHARS = 60000;
const MAX_REASON = 500;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS });

function getToken(): string | undefined {
  return process.env.ROLLBACK_GH_TOKEN
    || process.env.DEBUG_CAPTURE_GH_TOKEN
    || process.env.GH_TOKEN
    || process.env.GITHUB_TOKEN;
}

/**
 * Slice without splitting a surrogate pair. A plain slice can cut an emoji in half and leave a
 * LONE SURROGATE, which serializes to invalid UTF-8 and makes GitHub reject the whole request
 * with a generic "Problems parsing JSON" — the exact failure debug-capture.mts hit.
 */
function safeSlice(s: string, n: number): string {
  if (n >= s.length) return s;
  let end = Math.max(0, n);
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** PURE-ish: is this a version string we are willing to put in an issue title? */
export function validVersion(v: unknown): v is string {
  return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);
}

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  // Gate at dispatcher. This writes into the company's issue tracker with a server-held token,
  // so an open POST is a way to file issues on Davis's repo from anywhere.
  const gate = await requireUser(req, { role: 'dispatcher' });
  if (!gate.ok) return gate.response;

  const token = getToken();
  if (!token) {
    return json({
      ok: false,
      error: 'Server is missing ROLLBACK_GH_TOKEN — set it in Netlify env to enable one-tap rollback requests.',
    }, 503);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Body must be JSON' }, 400); }
  if (!body || body.schema !== 'dispatch-map.rollback-request/v1') {
    return json({ ok: false, error: 'Expected a dispatch-map.rollback-request/v1 body' }, 400);
  }
  // Validate the version rather than interpolating whatever arrived: this string lands in an
  // issue title and in a shell command inside the body, and neither is a place for free text.
  if (!validVersion(body.version)) {
    return json({ ok: false, error: 'version must be x.y.z' }, 400);
  }

  const reason = safeSlice(String(body.reason ?? '').trim(), MAX_REASON);
  const repo = process.env.ROLLBACK_REPO || DEFAULT_REPO;
  const labels = (process.env.ROLLBACK_LABELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const mention = (process.env.ROLLBACK_MENTION || '').trim();

  const title = `[rollback] back to v${body.version}${reason ? ` — ${safeSlice(reason, 60)}` : ''}`;
  const issueBody = safeSlice(
    (mention ? `${mention}\n\n` : '') + String(body.markdown ?? ''),
    MAX_BODY_CHARS,
  );
  if (!issueBody.trim()) return json({ ok: false, error: 'markdown body is required' }, 400);

  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'dispatch-map-rollback-request',
      },
      body: JSON.stringify(labels.length ? { title, body: issueBody, labels } : { title, body: issueBody }),
    });
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // GitHub buries the real reason for a 400/422 in errors[]; surface it so the toast is
      // actionable rather than "bad request".
      const detail = Array.isArray(data?.errors) && data.errors.length
        ? ' — ' + data.errors.map((e: any) => e?.message || [e?.resource, e?.field, e?.code].filter(Boolean).join(' ')).filter(Boolean).join('; ')
        : '';
      const hint = resp.status === 401 ? ' (token expired/revoked — rotate ROLLBACK_GH_TOKEN)'
        : resp.status === 403 || resp.status === 404 ? ' (token lacks Issues:write on this repo)'
        : '';
      return json({ ok: false, error: `GitHub ${resp.status}: ${data?.message || 'issue create failed'}${detail}${hint}` }, 502);
    }
    return json({ ok: true, issueUrl: data.html_url, issueNumber: data.number });
  } catch (e: any) {
    return json({ ok: false, error: `Could not reach GitHub: ${e?.message || e}` }, 502);
  }
};
