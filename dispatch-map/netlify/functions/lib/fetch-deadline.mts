// lib/fetch-deadline.mts — one deadline, shared by every fetch this app makes.
//
// WHY THIS IS ITS OWN MODULE. Both sides of the app talk over `fetch`: the NuVizz requester and
// the Firestore REST client. On 2026-09-10 a manual scan started at 20:01, recorded zero calls,
// wrote no board and was still open seven minutes later — one request had been accepted and
// never answered, and neither path passed a signal, so it simply waited until the platform
// killed the function. The requester cannot own this helper (Firestore would then import the
// requester, which already imports Firestore for its call counter) so it lives here, importing
// nothing.
//
// NOT `AbortSignal.timeout()`. Its timer is unref'd, so it fires only while something else is
// holding the event loop open — true of a real pending socket, false of a stub, and a deadline
// whose firing depends on what else happens to be running is not a deadline. An explicit
// controller with an ordinary timer fires on its own terms, and `cancel()` clears it on every
// path so a finished request leaves no timer behind.

export interface Deadline { signal: AbortSignal | undefined; cancel: () => void }

/** A signal that aborts after `ms`, merged with the caller's own if they passed one.
 *  `ms <= 0` disables the deadline and hands back exactly what the caller gave. */
export function deadlineSignal(caller: AbortSignal | undefined | null, ms: number): Deadline {
  if (!(ms > 0)) return { signal: caller ?? undefined, cancel: () => {} };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException(`no answer within ${ms}ms`, 'TimeoutError')), ms);
  return {
    signal: caller ? AbortSignal.any([caller, ac.signal]) : ac.signal,
    cancel: () => clearTimeout(timer),
  };
}

/** `fetch` with a deadline. The caller's own signal, when present, still wins. */
export async function fetchWithDeadline(url: string, init: any = {}, ms = 20_000): Promise<Response> {
  const d = deadlineSignal(init?.signal, ms);
  try {
    return await fetch(url, { ...init, signal: d.signal });
  } finally {
    d.cancel();
  }
}
