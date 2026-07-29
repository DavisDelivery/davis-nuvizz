import React, { useEffect, useState } from 'react';
import { PackageCheck, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';

// Bumped by hand on every meaningful change, same convention as dispatch-map.
// Rendered visibly below so a deploy can be confirmed from the page itself.
const APP_VERSION = '0.1.1';

const BUILD_COMMIT = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
const BUILD_CONTEXT = typeof __BUILD_CONTEXT__ !== 'undefined' ? __BUILD_CONTEXT__ : 'dev';

/**
 * Fetch JSON from a Netlify function, refusing to guess.
 *
 * This site's SPA catch-all answers ANY unmatched path with index.html and
 * HTTP 200 — including /.netlify/functions/<name> for a function that isn't
 * deployed. (Verified on this site: a redirect scoped to /.netlify/functions/*
 * does not take precedence, because Netlify runs Compute before Static
 * routing.) So a typo'd or undeployed function name arrives here looking like
 * a successful request, and a bare res.json() dies on "Unexpected token '<'" —
 * a parse error that says nothing about the real cause.
 *
 * Checking the content-type turns that into a diagnosis: HTML back from a
 * function path means the function isn't there.
 */
async function fetchJson(path, init) {
  const res = await fetch(path, init);
  const type = res.headers.get('content-type') || '';

  if (!type.includes('application/json')) {
    throw new Error(
      res.ok
        ? `${path} returned ${type || 'no content-type'} instead of JSON — the function is probably not deployed on this site (the SPA fallback served index.html).`
        : `${path} failed: HTTP ${res.status} (${type || 'no content-type'})`,
    );
  }

  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `${path} failed: HTTP ${res.status}`);
  return body;
}

export default function App() {
  // Health probe against the scaffold's one function. This is the scaffold's whole
  // point: it proves the publish dir AND the functions dir resolved correctly from
  // the base directory, visibly, without opening the Netlify dashboard.
  const [health, setHealth] = useState({ state: 'loading' });

  async function probe() {
    setHealth({ state: 'loading' });
    try {
      const body = await fetchJson('/.netlify/functions/health', { cache: 'no-store' });
      setHealth({ state: body?.ok ? 'ok' : 'fail', body });
    } catch (e) {
      setHealth({ state: 'fail', body: { error: e?.message || 'fetch failed' } });
    }
  }

  useEffect(() => {
    probe();
  }, []);

  const ok = health.state === 'ok';

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-lg ring-1 ring-slate-200 overflow-hidden">
        <div className="bg-[#1e5b92] px-5 py-4 text-white flex items-center gap-3">
          <PackageCheck className="w-6 h-6 shrink-0" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-semibold leading-tight">Load Scan</h1>
            <p className="text-xs text-white/70 leading-tight">Davis Delivery</p>
          </div>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-sm text-slate-600">
            Scaffold is live. Features land here next.
          </p>

          {/* ── Build stamp (visible APP_VERSION — the deploy proof) ───────── */}
          <dl className="rounded-xl bg-slate-50 ring-1 ring-slate-200 px-4 py-3 text-sm">
            <div className="flex justify-between gap-3 py-0.5">
              <dt className="text-slate-500">Version</dt>
              <dd className="font-mono font-semibold text-slate-900">v{APP_VERSION}</dd>
            </div>
            <div className="flex justify-between gap-3 py-0.5">
              <dt className="text-slate-500">Commit</dt>
              <dd className="font-mono text-slate-700">{BUILD_COMMIT}</dd>
            </div>
            <div className="flex justify-between gap-3 py-0.5">
              <dt className="text-slate-500">Context</dt>
              <dd className="font-mono text-slate-700">{BUILD_CONTEXT}</dd>
            </div>
            <div className="flex justify-between gap-3 py-0.5">
              <dt className="text-slate-500">Built</dt>
              <dd className="font-mono text-slate-700">
                {BUILD_TIME ? `${BUILD_TIME.slice(5, 16).replace('T', ' ')}Z` : '—'}
              </dd>
            </div>
          </dl>

          {/* ── Function routing probe ─────────────────────────────────────── */}
          <div
            className={`rounded-xl px-4 py-3 ring-1 text-sm ${
              ok
                ? 'bg-emerald-50 ring-emerald-200'
                : health.state === 'loading'
                  ? 'bg-slate-50 ring-slate-200'
                  : 'bg-rose-50 ring-rose-200'
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              {health.state === 'loading' ? (
                <RefreshCw className="w-4 h-4 animate-spin text-slate-400" aria-hidden="true" />
              ) : ok ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-hidden="true" />
              ) : (
                <XCircle className="w-4 h-4 text-rose-600" aria-hidden="true" />
              )}
              <span className={ok ? 'text-emerald-900' : health.state === 'loading' ? 'text-slate-600' : 'text-rose-900'}>
                {health.state === 'loading'
                  ? 'Checking /.netlify/functions/health…'
                  : ok
                    ? 'Function routing OK'
                    : 'Function routing FAILED'}
              </span>
            </div>
            {health.body ? (
              <pre className="mt-2 text-[11px] leading-snug text-slate-600 whitespace-pre-wrap break-words font-mono">
                {JSON.stringify(health.body, null, 2)}
              </pre>
            ) : null}
          </div>

          <button
            type="button"
            onClick={probe}
            className="w-full rounded-xl bg-[#1e5b92] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#194b78] active:bg-[#153f64] transition-colors"
          >
            Re-check
          </button>
        </div>
      </div>
    </div>
  );
}
