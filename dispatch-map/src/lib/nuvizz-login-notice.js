// nuvizz-login-notice.js — telling a dispatcher, AT THE MOMENT IT HAPPENS, that their own NuVizz
// login stopped working.
//
// THE GAP THIS CLOSES (found reviewing v1.75.0). When NuVizz refuses a dispatcher's saved login in
// the middle of a Save, the Save fails with whatever the engine saw first — "load not found (…HTTP
// 401)" — which sends them to refresh the board, not to their password. Their account is marked,
// so under `preferred` the NEXT Save quietly succeeds under the shared login and nothing on the
// board says so. The server said all of it (nuvizz-write.mts answers `loginRefused` and
// `identity`); nothing in the browser was reading it.
//
// The Route Workbench's own screen is frozen (CLAUDE.md), so this does not change what a Save shows
// there. It reads the answer at the one door every write goes through (src/lib/nuvizzWrite.js
// callWrite) and raises a whole-app bar, the same way RoleRefusalBar and PermissionBanner report
// whole-app conditions.
//
// PURE CORE: loginNoticeFrom() decides; the channel below only carries its answer.

/**
 * PURE. The notice a write's answer calls for, or null.
 *
 * Only a problem with a login the person HAS — refused now, refused earlier, unreadable, not
 * readable just now — or a refusal under `required`. NOT "you have none saved": under `preferred`
 * that is the ordinary state of everybody who has not set one up yet, and a bar after every Save for
 * it would be a bar people learn to ignore — the Account screen and its badge say it instead.
 */
export function loginNoticeFrom(j) {
  if (!j || typeof j !== 'object') return null;
  const id = j.identity && typeof j.identity === 'object' ? j.identity : null;
  const strict = id?.mode === 'required';
  if (j.loginRefused) {
    return {
      kind: 'refused-now',
      text: `NuVizz refused your saved NuVizz login (${String(j.loginRefused)}). ${strict
        ? 'Your changes are refused until it is re-entered.'
        : 'Your changes will go out under the shared login until it is re-entered.'}`,
    };
  }
  if (id?.as === 'refused') {
    return { kind: 'refused', text: String(j.error || 'Your change was refused: it needs your own NuVizz login.') };
  }
  if (id?.as === 'shared' && ['rejected', 'unreadable', 'unavailable'].includes(id.why)) {
    const note = id.note ? String(id.note) : 'Your NuVizz login could not be used.';
    return { kind: id.why, text: id.why === 'unavailable' ? note : `${note} Until then your changes go out under the shared login.` };
  }
  return null;
}

// ── the channel ──────────────────────────────────────────────────────────────

const listeners = new Set();

export function onLoginNotice(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Called with every write answer; raises a notice when loginNoticeFrom says there is one. */
export function noteWriteAnswer(j) {
  const n = loginNoticeFrom(j);
  if (!n) return null;
  for (const fn of listeners) { try { fn(n); } catch { /* one bad listener must not stop the rest */ } }
  return n;
}
