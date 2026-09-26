// account-client.js — the Account & logins screen's calls to the server.
//
// Every call resolves { ok, status, error?, ...body } and NEVER throws, the same contract as
// auth-client.js's authCall, so the screen always has a sentence to show instead of a spinner
// that never stops.
//
// WHICH TRANSPORT. The signed-in calls go through apiFetch (lib/api.js): a 401 there really does
// mean the session is gone, and apiFetch is what turns that into the app's "sign in again" path.
// Two calls deliberately do not:
//   • siteMode() — asked with NO session, to learn which way the NuVizz switch is set. Through
//     apiFetch its expected 401 would be read as a session that just died.
//   • bootstrapFirstAdmin() — carries no session by definition (there is no admin yet) and its
//     403 means "wrong setup code", not anything about who is signed in.

import { apiFetch } from './api.js';
import { friendlyServerError } from './auth-client.js';

const FN = '/.netlify/functions';

async function readAnswer(resp) {
  let data = null;
  try { data = await resp.json(); } catch { /* an HTML 502 from the platform */ }
  if (!resp.ok || data?.ok === false) {
    return { ok: false, status: resp.status, error: friendlyServerError(resp.status, data?.error), data };
  }
  return { ok: true, status: resp.status, ...(data || {}) };
}

async function call(path, { method = 'GET', body, plain = false } = {}) {
  const init = {
    method,
    cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  };
  let resp;
  try { resp = await (plain ? fetch(`${FN}/${path}`, init) : apiFetch(`${FN}/${path}`, init)); }
  catch { return { ok: false, status: 0, error: 'No connection. Check signal and try again.', offline: true }; }
  return readAnswer(resp);
}

// ── a person's own NuVizz login ─────────────────────────────────────────────

const who = (username) => (username ? `?username=${encodeURIComponent(username)}` : '');

/** Yours, or (admin) someone else's: { mode, login, keyReady, rwbEngine, checkCalls }. */
export function fetchNuvizzLogin(username) { return call(`auth-nuvizz-login${who(username)}`); }

/** Tests it against NuVizz first (the answer carries `check`); a refused login is NOT saved (422). */
export function saveNuvizzLogin({ username, nuvizzUsername, nuvizzPassword }) {
  return call('auth-nuvizz-login', { method: 'POST', body: { action: 'save', ...(username ? { username } : {}), nuvizzUsername, nuvizzPassword } });
}

export function testNuvizzLogin({ username } = {}) {
  return call('auth-nuvizz-login', { method: 'POST', body: { action: 'test', ...(username ? { username } : {}) } });
}

export function removeNuvizzLogin({ username } = {}) {
  return call('auth-nuvizz-login', { method: 'POST', body: { action: 'remove', ...(username ? { username } : {}) } });
}

/** With no session: the one site-level fact the server shares (which way the NuVizz switch is set). */
export async function siteMode() {
  const r = await call('auth-nuvizz-login', { plain: true });
  return r.ok ? r.mode : (r.data?.mode ?? null);
}

// ── people (admin) ──────────────────────────────────────────────────────────

export function fetchUsers() { return call('auth-users'); }

/** create / update / reset / unlock / logout-all — auth-users.mts is the authority on each. */
export function userAction(body) { return call('auth-users', { method: 'POST', body }); }

// ── the very first admin ────────────────────────────────────────────────────

/**
 * auth-bootstrap: needs the one-time setup code (AUTH_BOOTSTRAP_SECRET) and refuses once any
 * admin exists. Its refusals are re-worded here only where the raw text would send someone the
 * wrong way: a 404 means the setup code is not switched on at all, not that the page is missing.
 */
export async function bootstrapFirstAdmin({ secret, username, displayName, email, password }) {
  const r = await call('auth-bootstrap', { method: 'POST', plain: true, body: { secret, username, displayName, email: email || undefined, password } });
  if (r.ok) return r;
  if (r.status === 404) return { ...r, error: 'First-time setup is not switched on (AUTH_BOOTSTRAP_SECRET is not set in Netlify).' };
  if (r.status === 403) return { ...r, error: 'That setup code is not right.' };
  if (r.status === 409 && /admin already exists/i.test(r.data?.error || '')) return { ...r, error: 'An admin account already exists — sign in with it instead.' };
  return r;
}
