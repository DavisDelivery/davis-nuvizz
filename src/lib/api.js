// src/lib/api.js — thin wrapper around the Netlify proxy

const PROXY = '/.netlify/functions/nuvizz';

export const TENANTS = {
  davis: { label: 'Davis', companyCode: 'Davis', color: '#1e5b92', accent: '#3b82f6' },
  uline: { label: 'Uline', companyCode: 'Uline', color: '#c8102e', accent: '#ef4444' },
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

export const fetchToday = (tenant) => api(tenant, '__today');
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
