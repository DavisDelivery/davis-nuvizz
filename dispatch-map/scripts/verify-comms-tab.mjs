#!/usr/bin/env node
// scripts/verify-comms-tab.mjs — is the Customer emails screen REACHABLE from both
// navigations, does it render its cards, and does a template save actually round-trip
// with the admin token?
//
// The two failure classes this repo has actually shipped are exactly what this drives:
// v0.54.48 (tab reachable on desktop, invisible on a phone) and v0.54.71 (menu item
// "visible" to Playwright while clipped out of sight). So: both widths, and the menu
// item is HIT-TESTED, not just isVisible()'d.
//
//   node scripts/verify-comms-tab.mjs [distDir]
//     CHROMIUM_PATH   browser binary   SMOKE_PORT   port (default 8807)   MOBILE=1

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8807;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`);};

const CONFIG = {
  ok: true,
  config: {
    enabled: false, fromAddress: '', replyTo: 'customer@example.com',
    subjectTemplate: 'Delivered — PRO {{pro}}', htmlTemplate: '<p>Hi {{customer}}, PRO {{pro}} landed.</p>', dailyCap: 25,
  },
  fields: ['pro', 'customer', 'deliveredWhen'],
  defaultHtml: '<p>default template body</p>',
  resendConfigured: true,
  effectiveFrom: 'Davis Delivery <ops@example.com>',
};
const LOG = {
  ok: true, dates: ['2026-08-14'],
  totals: { total: 2, sent: 1, failed: 1, inflight: 0 },
  status: { '2026-08-14': { considered: 10, sent: 1, failed: 1, skipped: 8 } },
  entries: [
    { date: '2026-08-14', key: 'k1', at: new Date().toISOString(), to: 'customer@example.com', customer: 'ACME SUPPLY', subject: 'Delivered — PRO 007158990', ok: true },
    { date: '2026-08-14', key: 'k2', at: new Date().toISOString(), to: 'inbox@example.com', customer: 'GHOST CO', subject: 'Delivered — PRO 007158991', ok: false, claimed: false, error: 'bounced' },
  ],
};
const PREVIEW = {
  ok: true, preview: true, date: '2026-08-14', pro: '007158990', customer: 'ACME SUPPLY',
  subject: 'Delivered — PRO 007158990', html: '<h1 id="pv-mark">ACME SUPPLY delivery email</h1>',
  recipientOnFile: 'customer@example.com', recipientSource: 'order', optedOut: false,
  config: { enabled: false, from: 'ops@example.com', replyTo: 'customer@example.com', dailyCap: 25 },
  resendConfigured: true,
};
const COVERAGE = {
  ok: true, coverage: true, date: '2026-08-14', stops: 819, delivered: 710,
  sampled: 600, truncated: true, withEmail: 599, optedOut: 0, withoutEmail: 1,
  bySource: { notes: 0, order: 599 }, pct: 100,
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
const MOBILE = process.env.MOBILE === '1';
const page = await (await browser.newContext(MOBILE
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  : { viewport: { width: 1440, height: 1000 } })).newPage();

let savedBody = null, savedToken = null, previewCalls = 0;
await page.route('**/.netlify/functions/**', async (route) => {
  const url = route.request().url();
  const method = route.request().method();
  const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.includes('customer-comms-config')) {
    if (method === 'PUT' || method === 'POST') {
      savedToken = route.request().headers()['x-comms-token'] || null;
      // First write with no token → 403, exactly like the real endpoint. The UI must
      // ask for the token and RETRY — a silent swallow here loses the save.
      if (!savedToken) return json({ ok: false, error: 'not authorised' }, 403);
      savedBody = JSON.parse(route.request().postData() || '{}');
      return json({ ok: true, config: { ...CONFIG.config, ...savedBody }, resendConfigured: true });
    }
    return json(CONFIG);
  }
  if (url.includes('customer-comms-log')) return json(LOG);
  if (url.includes('customer-comms-test')) {
    if (url.includes('coverage=1')) return json(COVERAGE);
    previewCalls++;
    return json(PREVIEW);
  }
  if (url.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: [], count: 0 });
  return json({ ok: true });
});
page.on('pageerror', (e) => bad(`uncaught page error: ${e.message}`));
page.on('dialog', (d) => d.accept('stub-admin-token'));   // the token prompt + any confirm

console.log(`\nCustomer emails tab — live render${MOBILE ? ' [PHONE]' : ''}`);
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// v0.54.71's lesson, kept: an element clipped by a scrolling ancestor still reports
// isVisible(). Ask the browser what is painted at the click point instead.
const hittable = (loc) => loc.evaluate((node) => {
  const r = node.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(12, r.height / 2));
  return !!top && (node === top || node.contains(top));
}).catch(() => false);

if (MOBILE) {
  const chip = page.locator('button[title="Version menu"]').first();
  (await chip.isVisible().catch(() => false)) ? ok('the phone menu chip is on the bar') : bad('no phone menu chip');
  await chip.click(); await page.waitForTimeout(400);
  const item = page.getByRole('menuitem', { name: /customer emails/i }).first();
  (await item.isVisible().catch(() => false))
    ? ok('Customer emails is in the phone More block (open by default)')
    : bad('Customer emails missing from the phone menu — the v0.54.48 failure again');
  (await hittable(item)) ? ok('and it is genuinely tappable') : bad('the row is in the DOM but CLIPPED');
  await item.click();
} else {
  const more = page.getByRole('button', { name: /more/i }).first();
  (await more.isVisible().catch(() => false)) ? ok('the More menu is on the nav') : bad('no More menu on the nav');
  await more.click(); await page.waitForTimeout(300);
  const item = page.getByRole('menuitem', { name: /customer emails/i }).first();
  (await item.isVisible().catch(() => false)) ? ok('Customer emails is listed in it') : bad('Customer emails missing from the More menu');
  (await hittable(item)) ? ok('and it is genuinely on screen — not clipped') : bad('the menu item is in the DOM but CLIPPED');
  await item.click();
}
await page.waitForTimeout(900);

const body = await page.evaluate(() => document.body.innerText);
/Customer emails/.test(body) ? ok('the tab opened') : bad('the tab did not open');
/Zero NuVizz calls/i.test(body) ? ok('the screen states its cost up front') : bad('no cost statement');
/not wired yet/i.test(body) ? ok('it is honest that the automatic trigger is not wired') : bad('missing the trigger-not-wired banner');
/OFF/.test(body) ? ok('the enabled state renders (OFF)') : bad('no enabled/off pill');
// The subject is an <input> — input values never appear in innerText, so ask the DOM.
const subjVal = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input')];
  return inputs.map((i) => i.value).find((v) => /Delivered — PRO \{\{pro\}\}/.test(v)) || '';
});
subjVal ? ok('the saved subject template hydrated the editor') : bad('subject template did not hydrate');
/1 sent · 1 failed/.test(body) ? ok('the log totals line renders') : bad('log totals line missing');
/ACME SUPPLY/.test(body) ? ok('log entries render') : bad('log entries missing');

// Coverage: run the count, expect the stubbed 100%.
await page.getByRole('button', { name: /^count$/i }).first().click();
await page.waitForTimeout(500);
const body2 = await page.evaluate(() => document.body.innerText);
/100%/.test(body2) ? ok('coverage renders the go/no-go number') : bad('coverage number missing');

// Preview: server-rendered HTML lands in the sandboxed iframe.
await page.getByRole('button', { name: /preview saved template/i }).first().click();
await page.waitForTimeout(600);
(previewCalls > 0) ? ok('preview asked the server (same renderer as the real send)') : bad('preview never called the server');
const iframeHasMark = await page.evaluate(() => {
  const f = document.querySelector('iframe[title="Email preview"]');
  return !!f && String(f.getAttribute('srcdoc') || '').includes('pv-mark');
});
iframeHasMark ? ok('the rendered email is in the preview frame') : bad('preview frame empty');
const bodyPv = await page.evaluate(() => document.body.innerText);
/Would send to:/.test(bodyPv) ? ok('the preview names the real recipient decision') : bad('no recipient line on the preview');

// Save: no token stored → 403 → prompt (auto-accepted) → retried with the token.
await page.getByRole('button', { name: /save template/i }).first().click();
await page.waitForTimeout(700);
savedToken === 'stub-admin-token' ? ok('the save retried with the admin token after a 403') : bad(`save token wrong: ${savedToken}`);
(savedBody && typeof savedBody.htmlTemplate === 'string' && savedBody.subjectTemplate)
  ? ok('the template save round-tripped subject + html')
  : bad('save body missing template fields');

await browser.close();
server.close();
if (fails.length) { console.error(`\n✗ ${fails.length} check(s) failed\n`); process.exit(1); }
console.log(`\n✓ customer emails tab verified in a real browser${MOBILE ? ' [PHONE]' : ''}\n`);
