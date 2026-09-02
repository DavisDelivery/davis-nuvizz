// test/uline-forecast-no-nuvizz-imports.test.mjs
//
// THE FORECAST FEATURE CANNOT REACH NUVIZZ — held by the import graph, directly.
//
// Honestly named: this checks DIRECT imports only. manifest-archive.mts (which the store
// imports for one collection name) itself imports manifest-run.mts, which imports
// nuvizz-scan.mts for a credentials helper; that module has no module-level network side
// effect, so today the transitive path is import hygiene and not a call. What this pins is
// that no forecast file, now or later, pulls in a NuVizz module by name — the way a copied
// "just reuse lookupStopByPro" would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FILES = [
  'netlify/functions/uline-forecast.mts',
  'netlify/functions/uline-forecast-ingest-background.mts',
  'netlify/functions/lib/uline-forecast.mts',
  'netlify/functions/lib/uline-forecast-store.mts',
  'netlify/functions/lib/uline-forecast-ingest.mts',
  'src/lib/uline-forecast-lane.js',
  'src/lib/uline-forecast-score.js',
];
const BANNED = /from\s+['"][^'"]*(nuvizz-[a-z-]+|manifest-run|nuvizz-request|nuvizz-scan)\.m?[jt]s['"]/;
const RAW_FETCH_TO_VENDOR = /portal\.nuvizz\.com|\$\{NUVIZZ_BASE\}/;

test('no forecast file imports a NuVizz module directly, or names the vendor host', () => {
  for (const f of FILES) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!BANNED.test(src), `${f} imports a NuVizz module`);
    assert.ok(!RAW_FETCH_TO_VENDOR.test(src), `${f} names the vendor host`);
  }
});

test('and every forecast file that exists is on the list above — a new one is not exempt by omission', () => {
  const found = [];
  for (const dir of ['netlify/functions', 'netlify/functions/lib', 'src/lib']) {
    for (const name of readdirSync(join(ROOT, dir))) if (/uline-forecast/.test(name)) found.push(`${dir}/${name}`);
  }
  for (const f of found) assert.ok(FILES.includes(f), `${f} is a forecast file not covered by this guard — add it`);
});

test('GET never touches the mailbox: the endpoint builds a Gmail source only inside POST actions', () => {
  const src = readFileSync(join(ROOT, 'netlify/functions/uline-forecast.mts'), 'utf8');
  const getBlock = src.slice(src.indexOf("if (req.method === 'GET')"), src.indexOf("if (req.method !== 'POST')"));
  assert.ok(!/buildForecastSource|ingestForecastEmails|backfillForecasts/.test(getBlock), 'no mailbox read on GET');
  const postBlock = src.slice(src.indexOf("if (req.method !== 'POST')"));
  assert.match(postBlock, /action === 'run'[\s\S]*?requireUser\(req, \{ role: 'dispatcher' \}\)/, 'run is gated at dispatcher');
  assert.match(postBlock, /action === 'backfill'[\s\S]*?requireUser\(req, \{ role: 'admin' \}\)/, 'backfill is gated at admin');
  assert.match(postBlock, /action === 'reingest'[\s\S]*?requireUser\(req, \{ role: 'admin' \}\)/, 'reingest is gated at admin');
  assert.match(postBlock, /readJsonBody\(req\)/, 'the body is read through the bounded reader');
});

test('the endpoint has a timeout entry, because a backfill press is a batch and the 10s default is an HTML 502', () => {
  const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  assert.match(toml, /\[functions\."uline-forecast"\]\s*\n\s*timeout = 26/);
});
