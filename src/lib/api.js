// src/lib/api.js — thin wrapper around the Netlify proxy

const PROXY = '/.netlify/functions/nuvizz';
const DISPATCH = '/.netlify/functions/dispatch';

export const TENANTS = {
  davis: { label: 'Davis', companyCode: 'DAVIS', color: '#1e5b92', accent: '#3b82f6' },
  uline: { label: 'Uline', companyCode: 'ULINE', color: '#c8102e', accent: '#ef4444' },
  glorybound: { label: 'Glory Bound', companyCode: 'GloryBound', color: '#059669', accent: '#10b981' },
};

export async function api(tenant, path, { method = 'GET', query = {}, body = null } = {}) {
  const qs = new URLSearchParams({ tenant, path, ...query }).toString();
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${PROXY}?${qs}`, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
  return data;
}

// Glory Bound Firestore source (independent of NuVizz)
export async function dispatchApi(path, query = {}) {
  const qs = new URLSearchParams({ path, ...query }).toString();
  const resp = await fetch(`${DISPATCH}?${qs}`);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);
  return data;
}

export const fetchToday = (tenant) => {
  if (tenant === 'glorybound') return dispatchApi('__today');
  return api(tenant, '__today');
};
export const fetchDateRange = (tenant, from, to) => api(tenant, '__daterange', { query: { from, to } });
export const fetchHealth = (tenant = 'davis') => api(tenant, '__health');

export const fetchStop = (tenant, stopNbr, companyCode) =>
  api(tenant, `/stop/info/${encodeURIComponent(stopNbr)}/${encodeURIComponent(companyCode)}`);
export const fetchStopETA = (tenant, stopNbr, companyCode) =>
  api(tenant, `/stop/etainfo/${encodeURIComponent(companyCode)}`, { query: { stopNbr } });
export const fetchStopEvents = (tenant, stopNbr, companyCode) =>
  api(tenant, `/stop/eventinfo/${encodeURIComponent(companyCode)}`, { query: { stopNbr } });
export const fetchLoad = (tenant, loadNbr, companyCode) =>
  api(tenant, `/load/info/${encodeURIComponent(loadNbr)}/${encodeURIComponent(companyCode)}`);

// --- PRO normalization (client-side mirror of the function) ---
// Always 9 digits, zero-padded. "7100000" → "007100000".
export function normalizePro(input) {
  if (!input) return null;
  const cleaned = String(input).trim().replace(/^0+/, '');
  if (!cleaned) return '000000000';
  if (!/^\d+$/.test(cleaned)) return null;
  if (cleaned.length > 9) return cleaned;
  return cleaned.padStart(9, '0');
}

// Smart PRO lookup — the happy path for a driver or dispatcher typing a PRO.
// Returns normalized pro, full stop data, parent load, and stops-away count.
export const lookupPro = (tenant, pro, { includeLoad = true } = {}) =>
  api(tenant, '__lookup', { query: { pro, includeLoad: includeLoad ? 'true' : 'false' } });

// Document fetch (dual-credential fallback happens server-side)
export const fetchDoc = (tenant, guid, ext, objectType = '02') =>
  api(tenant, '__doc', { query: { guid, ext, objectType } });

// Stops-away from a known load
export const fetchStopsAway = (tenant, loadNbr, stopNbr) =>
  api(tenant, '__stopsaway', { query: { loadNbr, stopNbr } });

// Fleet dispatch board — scans load number range for a date, returns all loads + drivers
export const fetchFleet = (tenant, date) =>
  api(tenant, '__fleet', { query: date ? { date } : {} });

// Fleet stops — flat list of all stops across all loads (for Map/Stops views)
export const fetchFleetStops = (tenant, date) =>
  api(tenant, '__fleetstops', { query: date ? { date } : {} });

// Unified driver view — one driver's loads and stops for a day
export const fetchDriver = (tenant, userName, date) =>
  api(tenant, '__driver', { query: { userName, ...(date ? { date } : {}) } });

// Force-refresh a single load: live-fetch from NuVizz, update cache, return fresh.
// Used when a user opens LoadDetail / StopDetail for the freshest data on that screen.
export const refreshLoad = (tenant, loadNbr, date) =>
  api(tenant, '__refreshLoad', { query: { loadNbr, ...(date ? { date } : {}) } });

// Force-refresh entire fleet: full scan + Firestore rewrite. Used by manual refresh button.
export const refreshFleet = (tenant, date) =>
  api(tenant, '__refreshFleet', { query: date ? { date } : {} });

// --- Driver registry (baked in — discovered by probing /user/info/ with common names) ---
// Refresh periodically by re-running the discovery probe. Source of truth: NuVizz user/info.
export const DAVIS_DRIVERS = [
  { userName: 'AARON',   name: 'Aaron Mitchell',       userId: 79957,  status: 'ENABLED' },
  { userName: 'ALLEN',   name: 'Allen Council',        userId: 80428,  status: 'ENABLED' },
  { userName: 'BEN',     name: 'Ben Paintsil',         userId: 4051,   status: 'ENABLED' },
  { userName: 'BILL',    name: 'Bill Tillery',         userId: 227989, status: 'ENABLED' },
  { userName: 'BRAD',    name: 'Brad Goodroe',         userId: 101788, status: 'DISABLED' },
  { userName: 'BRETT',   name: 'Brett Spradley',       userId: 2569,   status: 'ENABLED' },
  { userName: 'BRIAN',   name: 'Brian Worley',         userId: 105292, status: 'ENABLED' },
  { userName: 'CHAD',    name: 'Chad Davis',           userId: 1889,   status: 'ENABLED' },
  { userName: 'COLIN',   name: 'Colin Calhoun',        userId: 2773,   status: 'ENABLED' },
  { userName: 'FRANK',   name: 'Frank Okine',          userId: 1987,   status: 'ENABLED' },
  { userName: 'GARRY',   name: 'Garry Pitts',          userId: 36964,  status: 'DISABLED' },
  { userName: 'GEORGE',  name: 'George Leonard',       userId: 1989,   status: 'ENABLED' },
  { userName: 'JACK',    name: 'Jack Johnson',         userId: 116693, status: 'DISABLED' },
  { userName: 'JEAN',    name: 'Jean Delsoin',         userId: 1981,   status: 'ENABLED' },
  { userName: 'JERALD',  name: 'Jerald Buckley',       userId: 1975,   status: 'DISABLED' },
  { userName: 'JIM',     name: 'Jim Pallette',         userId: 1883,   status: 'ENABLED' },
  { userName: 'JOE',     name: 'Joe Gibbs',            userId: 141770, status: 'ENABLED' },
  { userName: 'JOHN',    name: 'John Thompson',        userId: 1903,   status: 'ENABLED' },
  { userName: 'KEN',     name: 'Ken Watkins',          userId: 1991,   status: 'ENABLED' },
  { userName: 'LEROY',   name: 'Leroy Smith',          userId: 76840,  status: 'ENABLED' },
  { userName: 'MARCUS',  name: 'Marcus Young',         userId: 1947,   status: 'ENABLED' },
  { userName: 'MARTIN',  name: 'Martin Wyatt',         userId: 135785, status: 'ENABLED' },
  { userName: 'MIKE',    name: 'Mike Kirkeby',         userId: 2142,   status: 'DISABLED' },
  { userName: 'NELSON',  name: 'Oyieke Nelson',        userId: 102775, status: 'ENABLED' },
  { userName: 'RICHARD', name: 'Richard Mawuenyega',   userId: 102049, status: 'ENABLED' },
  { userName: 'ROBERT',  name: 'Robert Best',          userId: 137420, status: 'ENABLED' },
  { userName: 'RONALD',  name: 'Ronald Gates',         userId: 125591, status: 'ENABLED' },
  { userName: 'RYAN',    name: 'Ryan Freeland',        userId: 1895,   status: 'ENABLED' },
  { userName: 'SAMUEL',  name: 'Samuel Osei',          userId: 2276,   status: 'ENABLED' },
  { userName: 'SCOTT',   name: 'Scott Hart',           userId: 91489,  status: 'ENABLED' },
  { userName: 'STEVEN',  name: 'Steven Adjetey',       userId: 183157, status: 'ENABLED' },
  { userName: 'TERRY',   name: 'Terry Gambrell',       userId: 1971,   status: 'ENABLED' },
  { userName: 'VICTOR',  name: 'Victor Fernandez',     userId: 1957,   status: 'ENABLED' },
  { userName: 'VINCENT', name: 'Vincent Bonzo',        userId: 4355,   status: 'ENABLED' },
  { userName: 'WILLIAM', name: 'William Kidd',         userId: 77035,  status: 'ENABLED' },
];
