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
      // No token gate any more (Chad: "get rid of this need for a token") — the server
      // passes when COMMS_ADMIN_TOKEN is unset. Record the header so we can assert the
      // UI did NOT invent one, and the body so the save round-trip is provable.
      savedToken = route.request().headers()['x-comms-token'] || null;
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
let promptCount = 0;
page.on('dialog', (d) => { if (d.type() === 'prompt') promptCount++; d.accept(); });

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
/zero NuVizz calls/i.test(body) ? ok('the screen states its cost up front') : bad('no cost statement');
/not wired yet/i.test(body) ? ok('it is honest that the automatic trigger is not wired') : bad('missing the trigger-not-wired banner');
/OFF/.test(body) ? ok('the enabled state renders (OFF)') : bad('no enabled/off pill');
/1 sent · 1 failed/.test(body) ? ok('the log totals line renders') : bad('log totals line missing');
/ACME SUPPLY/.test(body) ? ok('log entries render') : bad('log entries missing');

// THE LIVE PREVIEW — the email is on screen the moment the tab opens, rendered from the
// SAVED template with sample data, merge values escaped exactly like the server does.
const liveDoc = await page.evaluate(() => String(document.querySelector('iframe[title="Email preview"]')?.getAttribute('srcdoc') || ''));
liveDoc.includes('BUFORD TILE') ? ok('the live preview renders the template with sample data on load') : bad('live preview empty on load');
liveDoc.includes('&amp;') ? ok('merge values are escaped in the preview, matching the server') : bad('sample ampersand not escaped — preview drifts from the send');

// Coverage
await page.getByRole('button', { name: /^count$/i }).first().click();
await page.waitForTimeout(500);
/100%/.test(await page.evaluate(() => document.body.innerText)) ? ok('coverage renders the go/no-go number') : bad('coverage number missing');

// Real-delivery preview — server-rendered, and a way back to the live sample.
await page.getByRole('button', { name: /preview a real delivery/i }).first().click();
await page.waitForTimeout(600);
(previewCalls > 0) ? ok('real preview asked the server (same renderer as the live send)') : bad('real preview never called the server');
const realDoc = await page.evaluate(() => String(document.querySelector('iframe[title="Email preview"]')?.getAttribute('srcdoc') || ''));
realDoc.includes('pv-mark') ? ok('the server-rendered email replaced the sample') : bad('server preview not shown');
(await page.getByRole('button', { name: /back to sample data/i }).first().isVisible().catch(() => false))
  ? ok('and the way back to the live sample is offered') : bad('no way back to the sample preview');
await page.getByRole('button', { name: /back to sample data/i }).first().click();
await page.waitForTimeout(300);

// Edit → sticky save bar → save. NO token prompt anywhere in this flow.
await page.getByRole('button', { name: /edit html/i }).first().click();
await page.waitForTimeout(300);
const subjInput = page.locator('input[maxlength="200"]').first();
(await subjInput.isVisible().catch(() => false)) ? ok('the template source opens on request') : bad('Edit HTML did not open the editor');
await subjInput.fill('Delivered — PRO {{pro}} (edited)');
await page.waitForTimeout(400);
(await page.getByRole('button', { name: /save changes/i }).first().isVisible().catch(() => false))
  ? ok('an edit surfaces the single sticky save bar') : bad('no save bar after an edit');
await page.getByRole('button', { name: /save changes/i }).first().click();
await page.waitForTimeout(600);
(savedBody && /\(edited\)/.test(String(savedBody.subjectTemplate)) && typeof savedBody.htmlTemplate === 'string')
  ? ok('the save round-tripped the edited subject + html in one write') : bad('save body wrong: ' + JSON.stringify(savedBody || {}).slice(0, 120));
savedToken === null ? ok('no token header was sent — the gate is gone') : bad('UI still sends a token header: ' + savedToken);
promptCount === 0 ? ok('and no token prompt ever appeared') : bad(promptCount + ' prompt dialog(s) appeared — the token ask is back');

await browser.close();
server.close();
if (fails.length) { console.error(`\n✗ ${fails.length} check(s) failed\n`); process.exit(1); }
console.log(`\n✓ customer emails tab verified in a real browser${MOBILE ? ' [PHONE]' : ''}\n`);
