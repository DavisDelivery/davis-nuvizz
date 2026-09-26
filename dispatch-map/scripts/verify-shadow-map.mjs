#!/usr/bin/env node
// scripts/verify-shadow-map.mjs — THE CLAUDE-vs-DISPATCH MAP, MEASURED WHERE IT CAN BE DRAWN.
//
// Chad, 2026-09-25: "I want an interactive map to see Claude's vs my own dispatch." The map lives two
// taps down the Shadow tab (open a backtested day, open its map), and a stop tapped on it opens a
// card. The phone and tablet layout guards cannot measure it: they run on CI's FIRST build, which
// has no Google Maps key, and the shadow's one reviewed loader (src/lib/google-maps-loader.js)
// refuses to load Google without one — so there the map honestly says it could not load. That is
// how v1.72.0's first probe went red in CI while passing on a machine whose build had a key.
//
// So this guard rides the KEYED build (test.yml, beside verify:engine-map): Google's script is
// answered by a stand-in that can hold the map's Data layer (CLAUDE_SHADOW_FAKE_MAPS), the shadow
// endpoint by the worst-case fixture day, and every other function by an empty answer — nothing
// leaves the machine. At two phones, two iPads and a desktop it opens the day, opens the map, taps
// the stop shared by two orders, and measures the screen with the same MEASURE every layout guard
// uses. Each step proves it arrived; a build with no key FAILS here, loudly, rather than measuring
// the "could not load" line and calling it the map.
//
// Usage: node scripts/verify-shadow-map.mjs [dist]      env: CHROMIUM_PATH, SMOKE_PORT (default 8815)
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { MEASURE } from './lib/layout-measure.mjs';
import { claudeShadowFixtureFor, CLAUDE_SHADOW_FAKE_MAPS, isGoogleMapsScript, guardOpenBacktestDay, guardOpenMapAndTapStop } from './lib/claude-shadow-fixture.mjs';

const DIST = process.argv[2] || 'dist';
const PORT = Number(process.env.SMOKE_PORT) || 8815;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
// iPads get the DESKTOP layout on a touch screen: hasTouch, as verify-tablet-layout does, because
// index.css gates the fingertip floor on pointer: coarse. The desktop is a mouse — like
// verify-desktop-layout, it is not held to the touch floor.
const SIZES = [
  { name: 'iPhone 14', width: 390, height: 844, phone: true },
  { name: 'small Android', width: 360, height: 740, phone: true },
  { name: 'iPad portrait', width: 820, height: 1180, touch: true },
  { name: 'iPad Air landscape', width: 1180, height: 820, touch: true },
  { name: 'desktop', width: 1440, height: 900, mouse: true },
];

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' }); return res.end(b); } catch { /* next */ }
  }
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });

async function toShadow(page, phone) {
  if (phone) {
    await page.locator('button[title="Version menu"]').first().click().catch(() => {});
    await page.waitForTimeout(300);
    const item = page.getByRole('menuitem', { name: /routing/i }).first();
    if (!(await item.isVisible().catch(() => false))) return false;
    await item.click();
    await page.waitForTimeout(900);
    const gear = page.locator('button[aria-label="Panel settings"]:visible').first();
    if (!(await gear.isVisible().catch(() => false))) return false;
    await gear.click();
    await page.waitForTimeout(300);
    const act = page.getByRole('button', { name: /shadow view/i }).first();
    if (!(await act.isVisible().catch(() => false))) return false;
    await act.click();
  } else {
    const r = page.getByRole('button', { name: /^Routing( \(beta\))?$/ }).first();
    if (!(await r.isVisible().catch(() => false))) return false;
    await r.click();
    await page.waitForTimeout(900);
    const s = page.getByRole('button', { name: /^Shadow$/ }).first();
    if (!(await s.isVisible().catch(() => false))) return false;
    await s.click();
  }
  await page.waitForTimeout(900);
  return page.getByRole('heading', { name: 'Claude shadow' }).first().isVisible().catch(() => false);
}

let failures = 0;
console.log('\nShadow map guard — the Claude-vs-dispatch map, opened, on every size\n');
for (const size of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, ...(size.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: PHONE_UA } : size.touch ? { hasTouch: true, isMobile: false } : {}) });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on('dialog', (d) => d.dismiss());
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (isGoogleMapsScript(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: CLAUDE_SHADOW_FAKE_MAPS });
    if (u.includes('/.netlify/functions/claude-shadow')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(claudeShadowFixtureFor(u, route.request().postData())) });
    if (u.includes('/.netlify/functions/')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, stops: [], entries: [], items: [], rows: [], results: [], days: [], loads: [], count: 0 }) });
    if (u.startsWith(`http://127.0.0.1:${PORT}`)) return route.continue();
    return route.abort();   // nothing leaves the machine
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const where = `${size.name} (${size.width}×${size.height})`;
  const step = async (label, fn) => { let ok = false; try { ok = await fn(); } catch { ok = false; } if (!ok) { failures += 1; console.log(`  \x1b[31m✗\x1b[0m ${where}: could not ${label}${pageErrors.length ? ` — page errors: ${pageErrors.slice(0, 2).join(' | ')}` : ''}`); } return ok; };
  if (!(await step('reach Routing → Shadow', () => toShadow(page, size.phone)))) { await ctx.close(); continue; }
  if (!(await step('open the backtested day', () => guardOpenBacktestDay(page)))) { await ctx.close(); continue; }
  const noKey = await page.getByText(/VITE_GOOGLE_MAPS_API_KEY is not set/).first().isVisible().catch(() => false);
  if (!(await step('open the map and tap a stop', () => guardOpenMapAndTapStop(page)))) {
    if (noKey || await page.getByText(/VITE_GOOGLE_MAPS_API_KEY is not set/).first().isVisible().catch(() => false)) console.log('      this build has no Google Maps key — run this guard on the keyed build (test.yml builds with VITE_GOOGLE_MAPS_API_KEY=ci-test-key)');
    await ctx.close();
    continue;
  }
  const maps = await page.evaluate(() => window.__guardMapCount?.() ?? 0);
  if (maps < 1) { failures += 1; console.log(`  \x1b[31m✗\x1b[0m ${where}: no map was created — the stand-in did not answer, so nothing below would mean anything`); await ctx.close(); continue; }
  const m = await page.evaluate(MEASURE);
  const probs = [];
  if (m.docW > m.vw + 1) probs.push(`content is ${m.docW}px wide in a ${m.vw}px viewport`);
  for (const w of m.wide || []) probs.push(`wider than the screen: ${w.w}px — ${w.el}`);
  for (const o of m.offscreen || []) probs.push(`off-screen: right edge ${o.right}px — ${o.el}`);
  for (const c of m.clipped || []) probs.push(`clipped ${c.cut}px — ${c.el}`);
  if (!size.mouse) for (const s of m.small || []) probs.push(`touch target ${s.w}×${s.h}px — ${s.el}`);
  for (const o of m.overlap || []) probs.push(`controls overlapping by ${o.px}px — ${o.el}`);
  if (pageErrors.length) probs.push(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`);
  if (probs.length) { failures += 1; console.log(`  \x1b[31m✗\x1b[0m ${where}: the map open, a stop tapped (${maps} map${maps === 1 ? '' : 's'})`); for (const p of probs) console.log(`      ${p}`); }
  else console.log(`  \x1b[32m✓\x1b[0m ${where}: the map open, a stop tapped (${maps} map${maps === 1 ? '' : 's'})`);
  await ctx.close();
}
await browser.close();
srv.close();
if (failures) { console.log(`\n\x1b[31m✗ ${failures} failure(s)\x1b[0m\n`); process.exit(1); }
console.log('\n\x1b[32m✓ the Claude-vs-dispatch map fits every size\x1b[0m\n');
