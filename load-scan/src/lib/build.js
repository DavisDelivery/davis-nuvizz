// build.js — who am I and where did I come from?
//
// Lifted out of App.jsx so the shared chrome (Header, the footers) can read the
// version without importing the whole app back into itself. Nothing here has
// logic; it is the answer to "which build is that phone on", which is the first
// question asked whenever a driver reports something odd.

/**
 * Bumped BY HAND on every change. load-scan versions independently of
 * dispatch-map — they ship from the same repo but to different phones and for
 * different jobs, and a shared number would make both look like they changed
 * when only one did.
 */
export const APP_VERSION = '0.44.0';

// Injected by vite at build time (see vite.config.js `define`). The `typeof`
// guard is what keeps `npm run dev` and the unit suite working, where the
// defines are absent and a bare reference would be a ReferenceError — the exact
// class of runtime error that blanks the app.
export const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
export const BUILD_CONTEXT = typeof __BUILD_CONTEXT__ !== 'undefined' ? __BUILD_CONTEXT__ : 'dev';
