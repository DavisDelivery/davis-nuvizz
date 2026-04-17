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
