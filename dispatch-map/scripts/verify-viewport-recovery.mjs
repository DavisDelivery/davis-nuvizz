#!/usr/bin/env node
// scripts/verify-viewport-recovery.mjs — does the shell come back after the keyboard?
//
// Chad's v0.54.69 phone screenshot: the board list squeezed into three rows, the bottom
// quarter of the screen a dead grey slab. The shell is pinned to a pixel height read from
// visualViewport; the keyboard shrank it (correctly), and when the keyboard closed iOS never
// fired the final resize, so the shell stayed keyboard-height forever.
//
// Unit tests pin the RULE (test/viewport.test.mjs). They can't prove the app re-measures and
// re-renders, and a rule the shell never applies is the same as no rule. This drives the real
// bundle with a visualViewport we control: shrink it, go stale, and check the shell recovers.
//
//   node scripts/verify-viewport-recovery.mjs [distDir]
//     CHROMIUM_PATH  browser binary      SHOTS_PORT  port (default 8821)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SHOTS_PORT) || 8821;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

const H = 844, W = 390, KEYBOARD_H = 630;

try { if (!(await stat(DIST)).isDirectory()) throw new Error('nd'); }
catch { console.error(`no build at ${DIST} — run \`npm run build\` first`); process.exit(1); }

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' }); return res.end(b); } catch { /* next */ }
  }
  res.writeHead(404).end('nf');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

// Replace visualViewport with one we drive by hand — the point is to reproduce iOS's
// FAILURE to fire the final resize, which a real browser will never do for us.
await ctx.addInitScript(({ h, w }) => {
  const listeners = { resize: [], scroll: [] };
  const vv = {
    height: h, width: w, offsetLeft: 0, offsetTop: 0, scale: 1,
    addEventListener: (t, fn) => listeners[t]?.push(fn),
    removeEventListener: (t, fn) => { const a = listeners[t]; const i = a?.indexOf(fn); if (i > -1) a.splice(i, 1); },
  };
  Object.defineProperty(window, 'visualViewport', { get: () => vv, configurable: true });
  // The harness handles: set the height, and choose whether iOS bothers to tell anyone.
  window.__vv = {
    set(height, { fire = true } = {}) {
      vv.height = height;
      if (fire) listeners.resize.forEach((fn) => fn(new Event('resize')));
    },
  };
}, { h: H, w: W });

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/.netlify/functions/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, stops: [], count: 0 }) }));
await page.route('**://*.googleapis.com/**', (r) => r.abort());
await page.route('**://*.gstatic.com/**', (r) => r.abort());

const shellHeight = () => page.evaluate(() => Math.round(document.getElementById('root').firstElementChild.getBoundingClientRect().height));

console.log('\nViewport recovery — the grey-slab bug (v0.54.69)');
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1400);

const atRest = await shellHeight();
atRest === H ? ok(`shell fills the phone at rest (${atRest}px)`) : bad(`shell is ${atRest}px on an ${H}px phone before anything happened`);

// 1. Focus the search box and raise the keyboard. The shell SHOULD shrink — this is the
//    behaviour the pixel-height design exists for, and the fix must not break it.
await page.locator('input[placeholder*="Customer"]').first().focus().catch(() => {});
await page.evaluate((kh) => window.__vv.set(kh), KEYBOARD_H);
await page.waitForTimeout(500);
const typing = await shellHeight();
typing === KEYBOARD_H
  ? ok(`keyboard up → shell sits above it (${typing}px)`)
  : bad(`keyboard up → shell is ${typing}px, expected ${KEYBOARD_H}px (the UI would be behind the keyboard)`);

// 2. Dismiss the keyboard the way iOS sometimes does: the field blurs, and the final
//    visualViewport resize NEVER ARRIVES. Before the fix the shell stayed at 630px — the
//    grey slab. The focusout listener is what has to save it.
await page.evaluate(() => { document.activeElement?.blur(); });
await page.waitForTimeout(900);
const after = await shellHeight();
after === H
  ? ok(`keyboard dismissed with NO resize event → shell recovered to ${after}px (no grey slab)`)
  : bad(`keyboard dismissed → shell stuck at ${after}px on an ${H}px phone — this is the grey slab`);

// 3. A genuinely taller visible viewport (iOS toolbars scrolling away) must still be kept:
//    the fix is a floor, not an overwrite, or the app would shrink as you scroll.
await page.evaluate(() => window.__vv.set(900));
await page.waitForTimeout(400);
const tall = await shellHeight();
tall === 900 ? ok('toolbars away → shell grows past the layout viewport (900px)') : bad(`toolbars away → shell is ${tall}px, expected 900px`);

if (errors.length) bad(`uncaught page errors: ${errors.slice(0, 3).join(' | ')}`);

await browser.close();
server.close();
if (fails.length) { console.error(`\n✗ ${fails.length} check(s) failed\n`); process.exit(1); }
console.log('\n✓ viewport recovery verified\n');
