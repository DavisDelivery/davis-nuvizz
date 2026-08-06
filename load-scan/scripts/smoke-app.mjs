#!/usr/bin/env node
// scripts/smoke-app.mjs — does the built dock scanner actually START?
//
// Why this exists: dispatch-map shipped v0.54.14 blank on every device — state declared in one
// component and read in another threw on first render, React unmounted the tree, and the page
// went white with CI green the whole way. dispatch-map got a smoke job out of it. load-scan did
// not, and it is the app a loader is holding at 5am on a dock with a truck to fill.
//
// Nothing in the existing suite would catch it here either:
//   • it is a RUNTIME error — rollup/vite have no reason to complain;
//   • `npm run lint` is `echo 'no lint configured'`;
//   • all 211 tests are pure-function suites over scan-logic/server-logic — none mount the app.
// A green build says nothing about whether the app starts. This serves the real bundle, loads it
// in a real browser at phone size, and fails on any uncaught error or an empty root.
//
// It also guards the styling work: load-scan's utility classes are written through template
// literals in places, and a Tailwind purge turns a visual change into a silent no-op that every
// unit test still passes.
//
// Deliberately NOT a unit test: `npm test` runs with no install in CI (Node 22's TS stripping
// needs nothing), and this needs a bundle plus a browser. It is its own CI job.
//
// Usage: node scripts/smoke-app.mjs [distDir]
//   CHROMIUM_PATH   override the browser binary (default: Playwright's chromium)
//   SMOKE_PORT      override the port (default 8792 — dispatch-map's smoke uses 8791)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8792;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

function fail(msg, extra = '') {
  console.error(`\n✗ SMOKE FAILED — ${msg}`);
  if (extra) console.error(extra);
  console.error('\nThe built scanner did not start. A loader would be looking at a white screen\n'
    + 'with a truck to fill; do not merge until the page renders.');
  process.exit(1);
}

try { if (!(await stat(DIST)).isDirectory()) throw new Error('not a dir'); }
catch { fail(`no build at ${DIST} — run \`npm run build\` first`); }

// Static server with an index.html fallback, mirroring the Netlify SPA redirect so client routes
// resolve the same way they do in production.
const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const candidate of [join(DIST, path), join(DIST, 'index.html')]) {
    try {
      const body = await readFile(candidate);
      res.writeHead(200, { 'content-type': TYPES[extname(candidate)] || 'application/octet-stream' });
      return res.end(body);
    } catch { /* try the fallback */ }
  }
  res.writeHead(404).end('not found');
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
// Phone-sized on purpose: this app is only ever used on a phone, and the mobile layout is the
// render path that matters.
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(`${e.message}\n  ${(e.stack || '').split('\n').slice(1, 5).join('\n  ')}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });

let navError = null;
try {
  // `load`, not `networkidle`: with no backend behind it the app keeps retrying its data fetches,
  // so networkidle may never arrive. We only care that the bundle evaluated and React committed.
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60_000 });
} catch (e) { navError = e.message.split('\n')[0]; }
// Mount effects here open IndexedDB (the offline scan queue) and read the stored session. A throw
// in any of them still blanks the app, so give them room to run before looking.
await page.waitForTimeout(4000);

const state = await page.evaluate(() => {
  const root = document.getElementById('root');
  return {
    hasRoot: !!root,
    children: root ? root.children.length : -1,
    textLen: root ? (root.innerText || '').trim().length : -1,
    text: (document.body.innerText || '').trim().slice(0, 200),
  };
}).catch(() => null);

await browser.close();
server.close();

if (navError) fail(`the page could not be loaded: ${navError}`);
if (!state) fail('could not read the page state — the renderer died');

// With no backend the app legitimately sits on its sign-in screen; what it must NEVER do is throw
// on startup or commit nothing at all.
if (pageErrors.length) fail(`${pageErrors.length} uncaught error(s) on startup`, pageErrors.join('\n---\n'));
if (!state.hasRoot) fail('#root is missing from the served index.html');
if (state.children === 0 || state.textLen === 0) {
  fail('#root is EMPTY — React mounted nothing (the v0.54.14 symptom)',
    `children=${state.children} textLength=${state.textLen}`);
}

console.log('✓ smoke passed — the built scanner starts and renders');
console.log(`   #root children=${state.children}, text length=${state.textLen}`);
console.log(`   first text: ${JSON.stringify(state.text.slice(0, 90))}`);
if (consoleErrors.length) {
  // Not fatal: with no functions behind it, failed data fetches are expected here.
  console.log(`   (${consoleErrors.length} console error(s), expected without a backend: ${JSON.stringify(consoleErrors[0].slice(0, 80))})`);
}
