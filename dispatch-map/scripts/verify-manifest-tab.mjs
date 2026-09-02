#!/usr/bin/env node
// scripts/verify-manifest-tab.mjs — does the More menu open, does the manifest
// check run, and does the FLAG actually appear on the nav?
//
// Unit tests prove the flag RULE. They cannot prove the nav renders it, and a
// flag nobody can see is the same as no flag. This drives the real bundle.
//
//   node scripts/verify-manifest-tab.mjs [distDir]
//     CHROMIUM_PATH   browser binary   SMOKE_PORT   port (default 8801)
//     SUSPECTS=0|N    how many missing orders the stubbed check reports

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8801;
const N = Number(process.env.SUSPECTS ?? 2);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

const suspects = Array.from({ length: N }, (_, i) => ({
  pro: `0071589${String(90 + i).padStart(2, '0')}`, custName: `GHOST CO ${i + 1}`,
  city: 'ALPHARETTA', zip: '30004', lbs: 500 + i, skids: 1, pieces: 0, shipDate: '8/06/26',
}));
const CHECK = {
  ok: true, mode: 'board-diff', nuvizzCalls: 0,
  manifest: { orders: 660, totals: { count: 660, lbs: 359769, skids: 1019, pieces: 310 }, verified: true, warnings: [] },
  checkedAgainst: [{ date: '2026-08-06', stops: 658 }, { date: '2026-08-07', stops: 640 }],
  onBoard: 660 - N, boardOnly: 12, duplicatePros: [], suspects,
  summary: `660 on the manifest · ${660 - N} on the board`,
};

try { if (!(await stat(DIST)).isDirectory()) throw new Error('nd'); }
catch { console.error(`no build at ${DIST}`); process.exit(1); }

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' }); return res.end(b); } catch { /* next */ }
  }
  res.writeHead(404).end('nf');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
// MOBILE=1 runs the phone layout, where the whole nav is one chip menu. v0.54.48
// shipped the tab on desktop only and it was unreachable from a phone — this is
// the run that would have caught it.
const MOBILE = process.env.MOBILE === '1';
const page = await (await browser.newContext(MOBILE
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  : { viewport: { width: 1440, height: 1000 } })).newPage();
let checkCalls = 0, probeParam = null;
await page.route('**/.netlify/functions/**', async (route) => {
  const url = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.includes('manifest-check')) { checkCalls++; probeParam = new URL(url).searchParams.get('probe'); return json(CHECK); }
  if (url.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: [], count: 0 });
  return json({ ok: true });
});
page.on('pageerror', (e) => bad(`uncaught page error: ${e.message}`));

console.log(`\nManifest check tab — live render (${N} missing order(s) stubbed)${MOBILE ? ' [PHONE]' : ''}`);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// Desktop: the "More" button. Phone: the version chip that opens the whole menu.
const more = MOBILE
  ? page.locator('button[title="Version menu"]').first()
  : page.getByRole('button', { name: /more/i }).first();
(await more.isVisible().catch(() => false))
  ? ok(MOBILE ? 'the phone menu chip is on the bar' : 'the More menu is on the nav')
  : bad(MOBILE ? 'no phone menu chip' : 'no More menu on the nav');
await more.click(); await page.waitForTimeout(400);

if (MOBILE) {
  // The phone menu has its own More container (Chad: "there is no more button on
  // mobile"). It must be a real button — and it must start OPEN, so adding the
  // container never buries a tab an extra tap deep.
  const moreRow = page.getByRole('menuitem', { name: /^more$/i }).first();
  (await moreRow.isVisible().catch(() => false))
    ? ok('the phone menu has a More button')
    : bad('no More button inside the phone menu');
  (await page.getByRole('menuitem', { name: /manifest check/i }).first().isVisible().catch(() => false))
    ? ok('and it starts OPEN — the tab is still one tap away')
    : bad('More is collapsed by default, burying the tab');
  await moreRow.click(); await page.waitForTimeout(300);
  !(await page.getByRole('menuitem', { name: /manifest check/i }).first().isVisible().catch(() => false))
    ? ok('tapping More collapses it') : bad('More did not collapse');
  await moreRow.click(); await page.waitForTimeout(300);   // reopen for the rest of the run
}

// isVisible() is NOT enough, and that is exactly how a broken More menu shipped in
// v0.54.71: an element clipped by an ancestor's overflow still has a non-empty
// bounding box, so Playwright calls it visible while nobody on a desktop can see
// it. (The nav had overflow-x-auto, which forces overflow-y to auto too, so the
// dropdown opened inside a ~40px-tall clip box.) Hit-test the exact point the user
// would click instead: if the browser paints something else there, the menu is
// behind a clip and this fails.
const hittable = (loc) => loc.evaluate((node) => {
  const r = node.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(12, r.height / 2));
  return !!top && (node === top || node.contains(top));
}).catch(() => false);

const item = page.getByRole('menuitem', { name: /manifest check/i }).first();
(await item.isVisible().catch(() => false)) ? ok('Manifest check is listed inside it') : bad('Manifest check missing from the menu');
(await hittable(item))
  ? ok('and it is genuinely on screen — not clipped by a scrolling ancestor')
  : bad('the menu is in the DOM but CLIPPED — something else is painted where the user would click');
await item.click(); await page.waitForTimeout(800);

let body = await page.evaluate(() => document.body.innerText);
/Manifest check/i.test(body) ? ok('the tab opened') : bad('the tab did not open');
/Zero NuVizz calls/i.test(body) ? ok('the screen states its cost up front') : bad('no cost statement on the screen');

// THERE IS NO DROP BOX ANY MORE (v0.83.1). Chad: "there is no need for the manual manifest
// drop in box any longer as we are pulling it out of the emails." A run reaches this screen
// the way it reaches every browser now: the ingest writes Firestore, Shell mirrors it into
// localStorage['dd_manifest_check_last'], and the screen adopts it. So this seeds that slot
// with a run in the stored shape (the fields toStored() keeps) and reloads, then holds the
// screen to the same assertions it always had — plus one new one: nothing on it POSTs a PDF.
(await page.locator('input[type=file]').count()) === 0
  ? ok('there is no file input on the screen — the manual drop is gone')
  : bad('a file input is still rendered on the Manifest check screen');
const stored = {
  at: new Date().toISOString(), fileName: 'Uline_DA_210252748.pdf',
  checkedAgainst: CHECK.checkedAgainst, manifest: CHECK.manifest,
  onBoard: CHECK.onBoard, boardOnly: CHECK.boardOnly, duplicatePros: CHECK.duplicatePros,
  suspects: CHECK.suspects.slice(0, 200), suspectsTotal: CHECK.suspects.length,
  coverage: null, grade: null,
};
await page.evaluate((v) => localStorage.setItem('dd_manifest_check_last', JSON.stringify(v)), stored);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
// The reload lands on the map; walk back to the tab the same way a person would.
await (MOBILE ? page.locator('button[title="Version menu"]').first() : page.getByRole('button', { name: /more/i }).first()).click();
await page.waitForTimeout(400);
if (MOBILE) { const mr = page.getByRole('menuitem', { name: /^more$/i }).first(); if (!(await page.getByRole('menuitem', { name: /manifest check/i }).first().isVisible().catch(() => false))) await mr.click(); await page.waitForTimeout(300); }
await page.getByRole('menuitem', { name: /manifest check/i }).first().click(); await page.waitForTimeout(800);
checkCalls === 0 ? ok('nothing on this screen POSTs a PDF by hand any more') : bad(`expected 0 manual check calls, got ${checkCalls}`);
probeParam === null ? ok('and NEVER asked for the NuVizz probe') : bad(`the UI requested probe=${probeParam} — it must never spend NuVizz calls`);

body = await page.evaluate(() => document.body.innerText);
if (N > 0) {
  new RegExp(`${N} orders? on the manifest`, 'i').test(body)
    ? ok('the headline names the missing orders') : bad(`no headline about ${N} missing order(s)`);
  /GHOST CO 1/.test(body) ? ok('the missing order is listed with its customer') : bad('the suspect table did not render');
  /007158990/.test(body) ? ok('...and its PRO') : bad('no PRO in the suspect table');
} else {
  /All 660 manifest orders found/i.test(body) ? ok('a clean run says so plainly') : bad('a clean run did not report clean');
  !/GHOST CO/.test(body) ? ok('and lists no suspects') : bad('a clean run listed suspects');
}
/359,769/.test(body) ? ok('the manifest totals render') : bad('totals missing');
/match the ones printed on the manifest/i.test(body) ? ok('and are marked as reconciled') : bad('no reconciliation statement');

// THE FLAG on the nav, and whether it survives a reload.
const badgeOf = async (mobile) => page.evaluate((isM) => {
  if (isM) {
    // The phone chip carries a DOT, not a number — the nav is one control, so the
    // only thing that fits is "something behind here needs you".
    const chip = document.querySelector('button[title="Version menu"]');
    return chip && chip.querySelector('span.bg-red-600') ? 1 : 0;
  }
  const b = [...document.querySelectorAll('button')].find((x) => /more/i.test(x.textContent || ''));
  const m = b && (b.textContent || '').match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}, mobile);
const want = MOBILE ? (N > 0 ? 1 : 0) : N;
const live = await badgeOf(MOBILE);
live === want
  ? ok(MOBILE ? `the phone chip ${want ? 'shows the alert dot' : 'shows no dot'} without leaving the tab` : `the nav badge reads ${N} without leaving the tab`)
  : bad(`badge is ${live}, expected ${want}`);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const after = await badgeOf(MOBILE);
after === want ? ok(`the flag SURVIVES a reload (still ${after})`) : bad(`after reload the badge is ${after}, expected ${want}`);

if (MOBILE) {
  // Folding the container away must never hide a problem underneath it.
  await page.locator('button[title="Version menu"]').first().click();
  await page.waitForTimeout(400);
  const moreRow = page.getByRole('menuitem', { name: /^more/i }).first();
  await moreRow.click(); await page.waitForTimeout(300);
  const txt = (await moreRow.textContent().catch(() => '')) || '';
  const carries = N > 0 ? /\d/.test(txt) : !/\d/.test(txt);
  carries
    ? ok(N > 0 ? `collapsed, the More row carries the flag ("${txt.trim()}") — folding it cannot hide a problem` : 'collapsed and clean, no badge')
    : bad(`collapsed More row badge wrong for ${N} suspect(s): "${txt.trim()}"`);
}

await browser.close(); server.close();
if (fails.length) { console.error(`\n✗ ${fails.length} check(s) failed\n`); process.exit(1); }
console.log('\n✓ manifest check tab verified in a real browser\n');
