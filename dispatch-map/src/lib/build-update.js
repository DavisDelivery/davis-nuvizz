// Detect that a NEWER BUILD of the app has been deployed while this tab stayed open.
//
// Why this exists. The dispatch console is a tab that stays open for days — Chad's is
// routinely still running the bundle it loaded on Monday. A single-page app never
// re-fetches its own JavaScript, so every fix shipped since that page load is simply
// absent from his screen. On 7/27 that surfaced as "No where to put notes on this order
// on desktop": the note composer had shipped in v0.52.0 four days earlier, the live site
// was serving it correctly, and the open tab was running v0.50.77 from 07-23. Nothing was
// broken except that the browser had no reason to ever load the new code.
//
// The check is deliberately dumb and dependency-free: Vite fingerprints the entry bundle
// (index-DwYEshK0.js), so if the deployed index.html points at a DIFFERENT filename than
// the one this page is running, a new build exists. No version endpoint to keep in sync,
// no build-config change, and it cannot report a false update — the hash only moves when
// the code actually changes.

// Pull the ES-module entry script's src out of an index.html document.
// Returns null when there's no module script (dev server, an error page, a captive-portal
// interception) — callers MUST treat null as "don't know", never as "changed".
export function entryScriptFromHtml(html) {
  if (typeof html !== 'string' || !html) return null;
  // Attribute order varies between Vite versions, so match the tag then the src within it,
  // rather than assuming type= comes before src=.
  const tags = html.match(/<script\b[^>]*>/gi);
  if (!tags) return null;
  for (const tag of tags) {
    if (!/type\s*=\s*["']module["']/i.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (src?.[1]) return src[1];
  }
  return null;
}

// Is `live` a different build from `current`? Unknown on either side → false.
//
// False is the safe default in BOTH directions: a spurious true nags a dispatcher to
// reload mid-plan, and a missed update is no worse than the status quo this replaces.
export function isNewBuild(current, live) {
  if (!current || !live) return false;
  return normalizeEntry(current) !== normalizeEntry(live);
}

// Compare filenames only. The running script's src can be absolute (a full origin URL,
// via script.src) while index.html carries a root-relative path, and a deploy-preview or
// branch alias changes the origin without changing the build. The fingerprinted basename
// is the only part that tracks the code.
function normalizeEntry(src) {
  const s = String(src).split('?')[0].split('#')[0];
  const slash = s.lastIndexOf('/');
  return slash === -1 ? s : s.slice(slash + 1);
}

// ── WHAT CHANGED, not just THAT something changed ────────────────────────────
//
// Chad, on the blue bar: "Can we start including a simple set of details of what changed in
// the new version."
//
// The bar could not say. It compares the fingerprint of the running entry bundle against the
// deployed one — deliberately dumb, and blind to content by design. The changelog lives
// INSIDE the bundle, so the stale tab holds only its own history and cannot read the new
// build's. The missing piece is a tiny file the build emits beside index.html, which any
// tab can fetch: scripts/emit-version-json.mjs writes { version, headline, at } from
// APP_VERSION and the top changelog row.
//
// Every row in that array opens with a capitalised headline sentence — a convention this
// changelog has kept for hundreds of entries — so the one-line summary is already written
// and needs only to be cut out. That is what this does: the FIRST sentence, nothing else.
// Deriving it beats a second hand-maintained field, which would drift the first time
// somebody bumped a version in a hurry.

/** Longest a banner headline may run before it stops being a banner. */
export const HEADLINE_MAX = 160;

/**
 * PURE. The first sentence of a changelog entry, as the update bar should show it.
 * Null for anything unusable, and callers MUST treat null as "show the plain banner" —
 * a version bar with no detail is the behaviour we already had, and is never worse.
 */
export function headlineFromEntry(text) {
  // Strings only. A number or an object stringifies into something that LOOKS like a
  // headline ("42", "[object Object]") and would be painted across the bar as if it were one.
  if (typeof text !== 'string') return null;
  const raw = text.replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  // Sentence end = . ! or ? followed by a space and a capital, so "v0.54.2." and decimals
  // inside a sentence do not cut it short. Falls back to the whole string when the entry is
  // a single sentence with no terminator.
  const m = raw.match(/^(.+?[.!?])(?=\s+[A-Z0-9“"(])/);
  let out = (m ? m[1] : raw).trim();
  if (out.length > HEADLINE_MAX) out = out.slice(0, HEADLINE_MAX - 1).replace(/\s+\S*$/, '') + '…';
  return out || null;
}

/**
 * PURE. Is the version the site is serving actually NEWER than the one this tab runs?
 * Compares dotted numeric parts left to right; anything unparseable answers false, because
 * telling a dispatcher a build is newer when it might be older is worse than saying nothing.
 */
export function isNewerVersion(current, live) {
  const parse = (v) => {
    const parts = String(v ?? '').trim().split('.');
    if (parts.length !== 3) return null;
    const nums = parts.map((x) => Number(x));
    return nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : null;
  };
  const a = parse(current); const b = parse(live);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (b[i] !== a[i]) return b[i] > a[i]; }
  return false;
}
