// appupdate.js — noticing that a new build exists.
//
// ── THE BUG THIS FIXES ───────────────────────────────────────────────────────
//
// A driver was working on v0.19.0 while v0.22.0 was live. Three releases —
// including the fix that stops a stop counting more pieces than it holds — never
// reached the phone that needed them.
//
// The service worker was not at fault: navigations are network-first, so a
// RELOAD picks up a new build. The problem is that a phone in a warehouse never
// reloads. The app is added to the home screen, opened at 8pm, and left running
// until 8am. Switching back to it from the camera or a text message resumes the
// existing document; it does not navigate. So nothing ever asks the server
// whether there is something newer.
//
// ── WHAT THIS DOES ───────────────────────────────────────────────────────────
//
// Asks. On three triggers:
//
//   1. shortly after start-up
//   2. every time the app becomes visible again — the common case, because a
//      loader is in and out of it all shift
//   3. on a slow timer, for a phone left face-up on the forklift
//
// When the browser reports a waiting worker, the app shows a banner. It does NOT
// reload on its own: a reload in the middle of a truck would drop the driver
// back to the load picker mid-count, and that is a worse failure than being one
// version behind. Queued scans are already durable in IndexedDB, so taking the
// update is safe whenever they choose to.

/** Minimum gap between update checks — a check is a network round trip. */
const CHECK_EVERY_MS = 10 * 60 * 1000;

/**
 * Watch for a newer deployed build.
 *
 * @param onReady called with no arguments when an update is waiting to install
 * @returns a teardown function
 */
export function watchForUpdate(onReady) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};

  let stopped = false;
  let lastCheck = 0;
  let registration = null;

  const announce = () => {
    if (!stopped) onReady?.();
  };

  const check = () => {
    const now = Date.now();
    if (stopped || !registration || now - lastCheck < CHECK_EVERY_MS) return;
    lastCheck = now;
    // update() re-fetches sw.js. If the bytes changed, the browser installs the
    // new worker and it lands in `waiting`.
    registration.update().catch(() => {});
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') check();
  };

  navigator.serviceWorker
    .getRegistration()
    .then((reg) => {
      if (!reg || stopped) return;
      registration = reg;

      // Already waiting when we arrived — the update installed on a previous run
      // and nobody has taken it yet.
      if (reg.waiting) announce();

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // 'installed' with an existing controller means: a new build is ready
          // and an old one is currently running. Without the controller check
          // this fires on the very first visit, when there is nothing to update.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) announce();
        });
      });

      // First check shortly after start-up, once the app has settled.
      setTimeout(check, 5000);
    })
    .catch(() => {});

  document.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(check, CHECK_EVERY_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/**
 * Take the update.
 *
 * Tells the waiting worker to activate, then reloads once it has taken control.
 * The reload is what actually swaps the running code — activating alone leaves
 * the old document in place.
 */
export function applyUpdate() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    window.location.reload();
    return;
  }

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Fires more than once in some browsers; reloading twice is a visible flicker.
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  navigator.serviceWorker
    .getRegistration()
    .then((reg) => {
      if (reg?.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      // No waiting worker (or the message went nowhere): a plain reload still
      // fetches the new shell, because navigations are network-first.
      else window.location.reload();
    })
    .catch(() => window.location.reload());
}
