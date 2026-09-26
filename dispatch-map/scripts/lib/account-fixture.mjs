// scripts/lib/account-fixture.mjs — Account & logins, at its worst, for the layout guards.
//
// An empty list measures a header and proves nothing (verify-mobile-layout.mjs says it about
// every screen). So the rows here are the ones a collision would live in: a 40-character
// username, a long name and a long email, a NuVizz username that runs past a phone's width,
// every NuVizz badge the screen can show (working, refused with NuVizz's own long sentence,
// saved-but-untested, none), a locked account, a temporary password and an account turned off.
//
// No real person's name and no company address: see test/no-lifelike-addresses.test.mjs and
// test/no-env-value-literals.test.mjs.

const AT = '2026-09-26T20:41:00.000Z';
const OK = { at: AT, api: 'ok', apiStatus: 404, apiDetail: null, portal: 'ok', portalDetail: null, calls: 5 };
const REFUSED_SENTENCE = 'NuVizz said: The username or password you entered is incorrect. Please try again or contact your administrator.';

/** A signed-in ADMIN session, as src/lib/session.js stores it. The token is never checked: every call is stubbed. */
export const ADMIN_SESSION = JSON.stringify({
  token: 'layout-guard.not-a-real.token',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { username: 'owner', displayName: 'The Owner', role: 'admin', mustChangePassword: false },
});

export const SESSION_KEY = 'dispatchMap.session.v1';

/** GET auth-nuvizz-login for the signed-in admin (and, with no session, the mode it reports). */
export const ACCOUNT_MINE = {
  ok: true, username: 'owner', mode: 'preferred', keyReady: true, rwbEngine: true, checkCalls: 5,
  login: { saved: true, username: 'owner.nuvizz.login', savedAt: AT, savedBy: 'owner', check: OK, rejected: null },
};

const base = { active: true, mustChangePassword: false, locked: false, lockedUntil: null, createdAt: AT };

/** GET auth-users. */
export const ACCOUNT_USERS = {
  ok: true, mailConfigured: true, roles: ['admin', 'dispatcher', 'viewer'],
  users: [
    { ...base, username: 'owner', displayName: 'The Owner', email: 'owner@example.com', role: 'admin', lastLoginAt: AT,
      nuvizz: { saved: true, username: 'owner.nuvizz.login', savedAt: AT, savedBy: 'owner', check: OK, rejected: null } },
    { ...base, username: 'a-forty-character-username-for-the-guard', displayName: 'Maximiliana Featherstonehaugh-Worthington',
      email: 'maximiliana.featherstonehaugh.worthington@example.com', role: 'dispatcher', mustChangePassword: true,
      locked: true, lockedUntil: '2026-09-26T21:05:00.000Z', lastLoginAt: null,
      nuvizz: {
        saved: true, username: 'maximiliana.featherstonehaugh.worthington', savedAt: AT, savedBy: 'owner',
        check: { at: AT, api: 'skipped', apiStatus: null, apiDetail: 'not asked', portal: 'refused', portalDetail: REFUSED_SENTENCE, calls: 4 },
        rejected: { at: AT, reason: REFUSED_SENTENCE },
      } },
    { ...base, username: 'dispatch2', displayName: 'Second Dispatcher', email: null, role: 'dispatcher', lastLoginAt: AT,
      nuvizz: { saved: true, username: 'dispatch2nv', savedAt: AT, savedBy: 'dispatch2', check: null, rejected: null } },
    { ...base, username: 'dispatch3', displayName: 'Third Dispatcher', email: 'dispatch3@example.com', role: 'dispatcher', lastLoginAt: AT,
      nuvizz: { saved: false, username: null, savedAt: null, savedBy: null, check: null, rejected: null } },
    { ...base, username: 'viewer1', displayName: 'Office Viewer', email: null, role: 'viewer', active: false, lastLoginAt: null,
      nuvizz: { saved: false, username: null, savedAt: null, savedBy: null, check: null, rejected: null } },
  ],
};

/**
 * { status, body } for one Account & logins call, or null when the URL is not one of them.
 * auth-me answers the way the real one does to a token it cannot verify: a 401 that still carries
 * the two site-level facts (require-user.mts / auth-me.mts), so the screen's "This site" card and
 * the checklist render their answered state rather than "the server did not say".
 */
export function accountAnswer(url) {
  const u = String(url || '');
  if (u.includes('/auth-nuvizz-login')) return { status: 200, body: ACCOUNT_MINE };
  if (u.includes('/auth-users')) return { status: 200, body: ACCOUNT_USERS };
  if (u.includes('/auth-me')) return { status: 401, body: { ok: false, error: 'sign in required', authRequired: false, configured: true } };
  return null;
}
