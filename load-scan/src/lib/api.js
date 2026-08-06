// api.js — the only place this app talks to the network.
//
// Every call carries the bearer token; there are no unauthenticated endpoints.
// Every response is content-type checked before parsing, because this site's SPA
// fallback answers unknown paths with HTTP 200 text/html and a bare res.json()
// on that dies with "Unexpected token '<'" — a parse error that says nothing
// about the real cause.

const TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(message, { status = 0, offline = false, body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.offline = offline;
    this.body = body;
  }
}

async function call(path, { method = 'GET', token, body, timeoutMs = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, {
      method,
      signal: ctrl.signal,
      cache: 'no-store',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    clearTimeout(timer);
    // Abort or network failure — indistinguishable from the driver's point of
    // view, and both mean "keep working locally".
    throw new ApiError(e?.name === 'AbortError' ? 'request timed out' : 'no connection', { offline: true });
  }
  clearTimeout(timer);

  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    throw new ApiError(
      res.ok
        ? `${path} returned ${type || 'no content-type'} instead of JSON — the function is probably not deployed`
        : `${path} failed: HTTP ${res.status}`,
      { status: res.status },
    );
  }

  const json = await res.json();
  if (!res.ok || json?.ok === false) {
    throw new ApiError(json?.error || `HTTP ${res.status}`, { status: res.status, body: json });
  }
  return json;
}

export const login = (driverNumber, pin) =>
  call('/.netlify/functions/driver-login', { method: 'POST', body: { driverNumber, pin } });

export const changePin = (token, currentPin, newPin) =>
  call('/.netlify/functions/driver-change-pin', { method: 'POST', token, body: { currentPin, newPin } });

export const fetchManifest = (token, { date, loadNbr } = {}) => {
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  if (loadNbr) qs.set('loadNbr', loadNbr);
  const q = qs.toString();
  return call(`/.netlify/functions/load-manifest${q ? `?${q}` : ''}`, { token });
};

export const pushScans = (token, payload) =>
  call('/.netlify/functions/scan-session', { method: 'POST', token, body: payload, timeoutMs: 30_000 });

// ── Dispatcher ───────────────────────────────────────────────────────────────
export const adminList = (token) => call('/.netlify/functions/driver-admin?action=list', { token });
export const adminUnmatched = (token) => call('/.netlify/functions/driver-admin?action=unmatched', { token });
export const adminPost = (token, body) => call('/.netlify/functions/driver-admin', { method: 'POST', token, body });
export const aliasReport = (token, days = 14) =>
  call(`/.netlify/functions/driver-alias-report?days=${days}`, { token, timeoutMs: 60_000 });

/** The dispatcher's daily picture: trucks, who worked them, who never showed. */
export const scanActivity = (token, date) =>
  call(`/.netlify/functions/scan-activity${date ? `?date=${date}` : ''}`, { token, timeoutMs: 60_000 });

// ── Assignment, worklog and the admin report ─────────────────────────────────

/** What the dispatcher handed out for a shift. A loader gets only their own. */
export const fetchAssignments = (token, shiftDay) =>
  call(`/.netlify/functions/load-assign${shiftDay ? `?shiftDay=${encodeURIComponent(shiftDay)}` : ''}`, { token });

/** Assign or un-assign loads. `changes` is [{loadNbr, loaders:[driverNumber]}]. */
export const setAssignments = (token, shiftDay, changes) =>
  call('/.netlify/functions/load-assign', { method: 'POST', token, body: { shiftDay, changes } });

/**
 * Clock a load start or finish.
 *
 * Deliberately fire-and-forget at the call site: a loader must never be blocked
 * from working because the timing write failed. The worklog is a record OF the
 * work, not a gate ON it.
 */
export const postWorkEvents = (token, events) =>
  call('/.netlify/functions/work-session', { method: 'POST', token, body: { events } });

/** The admin report. `days` walks backwards from shiftDay. */
export const workReport = (token, { shiftDay, days = 1 } = {}) => {
  const qs = new URLSearchParams();
  if (shiftDay) qs.set('shiftDay', shiftDay);
  qs.set('days', String(days));
  return call(`/.netlify/functions/work-report?${qs}`, { token });
};

/** The CSV export URL for the analyst — opened directly so the browser saves it. */
export const workReportCsvUrl = ({ shiftDay, days = 1 } = {}) => {
  const qs = new URLSearchParams();
  if (shiftDay) qs.set('shiftDay', shiftDay);
  qs.set('days', String(days));
  qs.set('format', 'csv');
  return `/.netlify/functions/work-report?${qs}`;
};
