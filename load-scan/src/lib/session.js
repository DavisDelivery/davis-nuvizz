// session.js — token storage and OFFLINE session validity.
//
// ── WHAT "verifiable offline" MEANS HERE ─────────────────────────────────────
//
// The token is an HMAC-SHA256 JWT. Verifying that signature needs the server's
// secret, which a phone must never hold — so the client checks the CLAIMS
// (structure, subject, expiry) offline and treats the signature as the server's
// business. That is the right trust boundary: the client is not a trust boundary
// at all. Every request re-verifies the signature server-side, and forging a
// local token buys nothing, because the manifest it would unlock is already
// cached on that same device.
//
// What the offline check IS for: deciding whether this driver may keep scanning in
// a dead zone, and when to stop and make them log in again. That question is
// answered entirely by `exp`, which needs no secret.

const KEY = 'loadscan.session.v1';

function decodeClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Structurally valid and unexpired. No network, no secret. */
export function isSessionValid(token, nowSec = Math.floor(Date.now() / 1000)) {
  const c = decodeClaims(token);
  if (!c?.sub) return false;
  return Number.isFinite(c.exp) && c.exp > nowSec;
}

export function daysRemaining(token, nowSec = Math.floor(Date.now() / 1000)) {
  const c = decodeClaims(token);
  if (!c?.exp) return 0;
  return Math.max(0, Math.floor((c.exp - nowSec) / 86400));
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!isSessionValid(s?.token)) {
      localStorage.removeItem(KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — the session simply won't survive a restart */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing useful to do */
  }
}

export function sessionClaims(token) {
  return decodeClaims(token);
}
