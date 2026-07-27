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
