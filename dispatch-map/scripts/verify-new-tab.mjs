#!/usr/bin/env node
// scripts/verify-new-tab.mjs — RIGHT-CLICK A SCREEN, OPEN IT IN A NEW TAB (v1.117.0).
//
// Chad, 2026-10-04: "can you make it where you can right click things in the app to bring up in new
// tab like if I want to bring up the stops tab or quotes tab in another tab".
//
// test/tab-links-wiring.test.mjs reads the markup; only a browser can say the link does what a
// dispatcher will do with it. The right-click menu is the browser's own and no automation can open
// it, but the browser offers "Open link in new tab" for exactly the element a middle-click and a
// Ctrl-click follow — an <a href> — so those are what this drives, in the real bundle:
//   DESKTOP (1440, Stops on the bar; 1280, Stops under More)
//     1. every bar tab and every More row that opens a screen is a link to /?tab=<its screen>, with
//        the role it had as a button; Messages and Debug this view are not links.
//     2. a PLAIN click switches the screen in this tab — no new tab, the address bar stays "/".
//     3. a MIDDLE-click and a CTRL-click open a new tab that starts on that screen, and the new tab's
//        address bar goes back to "/"; the tab they were clicked in does not move.
//     4. a tab opened on Routing starts on Build even when Shadow was the last sub-tab used — and the
//        Shadow's code is never fetched for it.
//     5. only screens this build offers: /?tab=nope and /?tab=uatbench (not a UAT host) open the Map.
//     6. ?write=1 rides along into the links; a reload of a new tab lands on the Map, as every reload did.
//   PHONE (390)
//     7. every screen row in the menu is a link to its screen; Messages, More, Roll back and Debug are
//        not; a tap switches the screen in place.
//
//   node scripts/verify-new-tab.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8823)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8823;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mjs': 'text/javascript', '.woff2': 'font/woff2' };
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };
const check = (cond, yes, no) => (cond ? ok(yes) : bad(no));

// A hung guard is worse than a red one (see the smoke job's timeout note).
setTimeout(() => { console.error('verify-new-tab: watchdog — no result in 150s'); process.exit(1); }, 150000).unref();

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

// Proof of arrival — each screen's own heading, read off the shipped bundle. The Map and Routing have
// no heading, so they are proved by the bar's active tab instead (the one painted in the brand colour).
const HEADING = {
  stoplookup: 'Stop lookup', neworder: 'New Order', quote: 'Charge detail', manifest: 'Manifest check',
  comms: 'Customer emails', labels: 'Print labels', flaghistory: 'Flag history', addrhistory: 'Address history',
  performance: 'Stop performance', users: 'Account & logins', diag: 'Diagnostics',
};
const BAR_LABEL = { map: 'Map', routing: 'Routing (beta)' };

async function newContext(opts) {
  const ctx = await browser.newContext(opts);
  ctx.errors = [];
  ctx.requests = [];
  ctx.on('page', (p) => p.on('pageerror', (e) => ctx.errors.push(String(e?.message || e))));
  ctx.on('request', (r) => ctx.requests.push({ url: r.url(), type: r.resourceType() }));
  // Nothing leaves the page: every function answers empty, every map host is refused.
  await ctx.route('**/.netlify/functions/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, stops: [], entries: [], items: [], rows: [], results: [], count: 0, loads: [] }) }));
  for (const host of ['googleapis.com', 'gstatic.com', 'google.com', 'firebaseio.com']) await ctx.route(`**://*.${host}/**`, (r) => r.abort());
  return ctx;
}

const where = (page) => page.evaluate(() => location.pathname + location.search);
const activeBarTab = (page) => page.evaluate(() => [...document.querySelectorAll('header nav a, header nav button')]
  .filter((el) => el.style.background).map((el) => (el.innerText || '').trim())[0] || null);

/** Did `page` arrive on screen `id`? Waits up to 8s for the proof. */
async function arrived(page, id) {
  try {
    if (HEADING[id]) {
      await page.getByRole('heading', { name: HEADING[id] }).first().waitFor({ state: 'visible', timeout: 8000 });
      return true;
    }
    await page.waitForFunction((label) => [...document.querySelectorAll('header nav a, header nav button')]
      .some((el) => el.style.background && (el.innerText || '').trim() === label), BAR_LABEL[id], { timeout: 8000 });
    return true;
  } catch { return false; }
}

/** Click (or tap) `loc`, giving up after 4s. True when it was clicked. */
async function tryClick(loc, opts = {}, tap = false) {
  try { await (tap ? loc.tap({ timeout: 4000 }) : loc.click({ timeout: 4000, ...opts })); return true; } catch { return false; }
}

/** Click `loc` the way `how` says and return the new tab it opened (or null), plus the document URL it asked for. */
async function openNewTab(ctx, loc, how) {
  const before = ctx.requests.length;
  const opened = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null);
  // A link that is not there is a failure to report, not a 30s hang that ends the run.
  if (!(await tryClick(loc, how === 'middle' ? { button: 'middle' } : { modifiers: ['Control'] }))) return { np: null, asked: 'nothing — no such link' };
  const np = await opened;
  if (!np) return { np: null, asked: null };
  await np.waitForLoadState('domcontentloaded').catch(() => {});
  const doc = ctx.requests.slice(before).find((r) => r.type === 'document');
  return { np, asked: doc ? doc.url.replace(ORIGIN, '') : null };
}

// ── DESKTOP, 1440 — Stops on the bar ─────────────────────────────────────────────────────────────
console.log('desktop 1440');
{
  const ctx = await newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // 1. The bar.
  const bar = await page.evaluate(() => [...document.querySelectorAll('header nav > *')].map((el) => ({
    tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim().replace(/\s+\d+$/, ''), href: el.getAttribute('href'), role: el.getAttribute('role'), target: el.getAttribute('target'),
  })));
  const want = { Map: '/', 'Routing (beta)': '/?tab=routing', Stops: '/?tab=stoplookup', 'New Order': '/?tab=neworder', Quote: '/?tab=quote' };
  for (const [label, href] of Object.entries(want)) {
    const el = bar.find((b) => b.text === label);
    // target=_blank: whatever the app does not catch (Safari's "Open Link") opens a new tab, never reloads this one.
    check(el && el.tag === 'a' && el.href === href && el.role === 'button' && el.target === '_blank',
      `bar "${label}" is a link to ${href} (role=button, as it was; target=_blank)`,
      `bar "${label}" is ${el ? `<${el.tag} href=${el.href} role=${el.role} target=${el.target}>` : 'missing'} — want <a href="${href}" role="button" target="_blank">`);
  }
  const msg = bar.find((b) => /^Messages/.test(b.text));
  check(msg && msg.tag === 'button', 'bar "Messages" stays a button (it opens a window over this screen)', `bar "Messages" is ${msg ? `<${msg.tag}>` : 'missing'}`);

  // 1. The More menu.
  await page.evaluate(() => { const b = [...document.querySelectorAll('header button')].find((x) => /^more/i.test((x.innerText || '').trim())); if (b) b.click(); });
  await page.waitForTimeout(300);
  const rows = await page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => ({
    tag: el.tagName.toLowerCase(), text: (el.querySelector('span span') || el).innerText.trim(), href: el.getAttribute('href'), target: el.getAttribute('target'),
  })));
  const moreWant = { 'Manifest check': '/?tab=manifest', 'Customer emails': '/?tab=comms', 'Print labels': '/?tab=labels', 'Flag history': '/?tab=flaghistory', 'Address history': '/?tab=addrhistory', Performance: '/?tab=performance', 'Account & logins': '/?tab=users', Diagnostics: '/?tab=diag' };
  for (const [label, href] of Object.entries(moreWant)) {
    const r = rows.find((x) => x.text === label);
    check(r && r.tag === 'a' && r.href === href && r.target === '_blank', `More "${label}" is a link to ${href}`, `More "${label}" is ${r ? `<${r.tag} href=${r.href} target=${r.target}>` : 'missing'}`);
  }
  const dbg = rows.find((x) => x.text === 'Debug this view');
  check(dbg && dbg.tag === 'button', 'More "Debug this view" stays a button', `More "Debug this view" is ${dbg ? `<${dbg.tag}>` : 'missing'}`);
  check(!rows.some((x) => x.text === 'Stops'), 'More has no Stops row while the bar carries it', 'More lists Stops beside the bar\'s Stops tab');

  // 3. A More row, middle-clicked: a new tab on that screen; this tab does not move.
  {
    const { np, asked } = await openNewTab(ctx, page.locator('[role="menu"] a[role="menuitem"]', { hasText: 'Flag history' }).first(), 'middle');
    check(np && asked === '/?tab=flaghistory', 'middle-click on More → Flag history opened a new tab at /?tab=flaghistory', `middle-click on More → Flag history opened ${np ? asked : 'no tab'}`);
    if (np) {
      check(await arrived(np, 'flaghistory'), '…which starts on Flag history', '…which did not start on Flag history');
      check((await where(np)) === '/', '…and its address bar went back to "/"', `…its address bar still reads ${await where(np)}`);
      await np.close();
    }
    check((await where(page)) === '/' && (await activeBarTab(page)) === 'Map', 'the tab it was clicked in is still on the Map', `the tab it was clicked in moved: ${await where(page)} / ${await activeBarTab(page)}`);
  }
  await page.keyboard.press('Escape');

  // 2. A plain click switches the screen here.
  {
    const pages = ctx.pages().length;
    const clicked = await tryClick(page.locator('header nav a', { hasText: 'Quote' }).first());
    check(clicked && await arrived(page, 'quote'), 'a plain click on "Quote" opened Quote in this tab', 'a plain click on the "Quote" link did not open Quote');
    await page.waitForTimeout(300);
    if (clicked) {   // only meaningful once the link was there to click — never a vacuous pass
      check(ctx.pages().length === pages, '…and opened no new tab', `…and opened ${ctx.pages().length - pages} new tab(s)`);
      check((await where(page)) === '/', '…and the address bar stayed "/"', `…and the address bar went to ${await where(page)}`);
    }
  }

  // 3. Middle-click and Ctrl-click on the bar.
  for (const [label, id, how] of [['Stops', 'stoplookup', 'middle'], ['New Order', 'neworder', 'ctrl'], ['Map', 'map', 'middle']]) {
    const { np, asked } = await openNewTab(ctx, page.locator('header nav a', { hasText: label }).first(), how);
    const href = id === 'map' ? '/' : `/?tab=${id}`;
    check(np && asked === href, `${how}-click on "${label}" opened a new tab at ${href}`, `${how}-click on "${label}" opened ${np ? asked : 'no tab'}`);
    if (!np) continue;
    check(await arrived(np, id), `…which starts on ${label}`, `…which did not start on ${label}`);
    check((await where(np)) === '/', '…with "/" in its address bar', `…with ${await where(np)} in its address bar`);
    if (id === 'stoplookup') {
      // 6. A reload of the new tab lands on the Map, as every reload always has.
      await np.reload({ waitUntil: 'domcontentloaded' });
      check(await arrived(np, 'map'), 'reloading that new tab lands on the Map, as a reload always has', `reloading that new tab landed on ${await activeBarTab(np)}`);
    }
    await np.close();
  }
  check(await arrived(page, 'quote'), 'the tab they were clicked in is still on Quote', `the tab they were clicked in moved to ${await activeBarTab(page)}`);

  // 4. Routing opened in a new tab starts on Build — even with Shadow remembered — and never fetches the Shadow.
  {
    await page.evaluate(() => { try { localStorage.setItem('routing.tab', 'shadow'); } catch { /* private mode */ } });
    const before = ctx.requests.length;
    const { np, asked } = await openNewTab(ctx, page.locator('header nav a', { hasText: 'Routing (beta)' }).first(), 'middle');
    check(np && asked === '/?tab=routing', 'middle-click on "Routing (beta)" opened a new tab at /?tab=routing', `middle-click on "Routing (beta)" opened ${np ? asked : 'no tab'}`);
    if (np) {
      check(await arrived(np, 'routing'), '…which starts on Routing', '…which did not start on Routing');
      await np.waitForTimeout(1200);
      const sub = await np.evaluate(() => [...document.querySelectorAll('header button')].filter((b) => /^(Build|Engine|Shadow)$/.test((b.innerText || '').trim()) && b.style.background).map((b) => b.innerText.trim()));
      check(sub.length === 1 && sub[0] === 'Build', '…on Build, though Shadow was the last sub-tab used', `…on ${sub.join(', ') || 'no sub-tab'}`);
      const shadow = ctx.requests.slice(before).filter((r) => /\/assets\/ClaudeShadowScreen-/.test(r.url));
      check(shadow.length === 0, '…and the Shadow\'s code was never fetched for it', `…and the Shadow's code was fetched (${shadow.length}x) — it was mounted for a render`);
      await np.close();
    }
  }

  // 5. Only screens this build offers.
  for (const [url, why] of [['/?tab=nope', 'an unknown screen'], ['/?tab=uatbench', 'the UAT bench off a UAT host'], ['/?tab=QUOTE', 'a mis-cased screen']]) {
    await page.goto(`${ORIGIN}${url}`, { waitUntil: 'domcontentloaded' });
    check(await arrived(page, 'map'), `${url} (${why}) opens the Map`, `${url} (${why}) opened ${await activeBarTab(page)}`);
    check((await where(page)) === '/', '…and the address bar goes back to "/"', `…and the address bar reads ${await where(page)}`);
  }

  // 6. ?write=1 rides along into every link; the page keeps it.
  await page.goto(`${ORIGIN}/?write=1&tab=quote`, { waitUntil: 'domcontentloaded' });
  check(await arrived(page, 'quote'), '/?write=1&tab=quote starts on Quote', '/?write=1&tab=quote did not start on Quote');
  check((await where(page)) === '/?write=1', '…and keeps ?write=1 in the address bar', `…and the address bar reads ${await where(page)}`);
  const hrefs = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('header nav a')].map((a) => [(a.innerText || '').trim(), a.getAttribute('href')])));
  check(hrefs.Quote === '/?write=1&tab=quote' && hrefs.Map === '/?write=1', 'the links carry ?write=1 into the new tab', `the links read ${JSON.stringify(hrefs)}`);

  check(!ctx.errors.length, 'no uncaught errors on any desktop tab', `uncaught errors: ${ctx.errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

// ── DESKTOP, 1280 — Stops under More ─────────────────────────────────────────────────────────────
console.log('desktop 1280');
{
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const b = [...document.querySelectorAll('header button')].find((x) => /^more/i.test((x.innerText || '').trim())); if (b) b.click(); });
  await page.waitForTimeout(300);
  const stops = page.locator('[role="menu"] a[role="menuitem"]', { hasText: /^Stops/ }).first();
  check((await stops.getAttribute('href').catch(() => null)) === '/?tab=stoplookup', 'More → Stops is a link to /?tab=stoplookup when the bar has no room for it', 'More → Stops is not a link to /?tab=stoplookup');
  const { np, asked } = await openNewTab(ctx, stops, 'ctrl');
  check(np && asked === '/?tab=stoplookup', 'Ctrl-click on More → Stops opened a new tab at /?tab=stoplookup', `Ctrl-click on More → Stops opened ${np ? asked : 'no tab'}`);
  if (np) { check(await arrived(np, 'stoplookup'), '…which starts on Stop lookup', '…which did not start on Stop lookup'); await np.close(); }
  check(!ctx.errors.length, 'no uncaught errors', `uncaught errors: ${ctx.errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

// ── PHONE, 390 ───────────────────────────────────────────────────────────────────────────────────
console.log('phone 390');
{
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await tryClick(page.locator('button[title="Version menu"]').first(), {}, true);
  await page.waitForTimeout(400);
  const rows = await page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => ({
    // textContent, not innerText: the More fold is drawn in capitals, and its label is "More".
    tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().replace(/\s+/g, ' ').replace(/\s*\d+$/, ''), href: el.getAttribute('href'), target: el.getAttribute('target'),
  })));
  const want = {
    Map: '/', 'Routing (beta)': '/?tab=routing', 'New Order': '/?tab=neworder', Quote: '/?tab=quote',
    'Manifest check': '/?tab=manifest', 'Customer emails': '/?tab=comms', 'Stop lookup': '/?tab=stoplookup', 'Print labels': '/?tab=labels',
    'Flag history': '/?tab=flaghistory', 'Address history': '/?tab=addrhistory', Performance: '/?tab=performance',
    'Account & logins': '/?tab=users', Diagnostics: '/?tab=diag',
  };
  for (const [label, href] of Object.entries(want)) {
    const r = rows.find((x) => x.text === label);
    check(r && r.tag === 'a' && r.href === href && r.target === '_blank', `phone "${label}" is a link to ${href}`, `phone "${label}" is ${r ? `<${r.tag} href=${r.href} target=${r.target}>` : 'missing'}`);
  }
  for (const label of ['Messages', 'More', 'Roll back the app', 'Debug this view']) {
    const r = rows.find((x) => x.text === label);
    check(r && r.tag === 'button', `phone "${label}" stays a button`, `phone "${label}" is ${r ? `<${r.tag}>` : 'missing'}`);
  }
  const pages = ctx.pages().length;
  const tapped = await tryClick(page.locator('[role="menu"] a[role="menuitem"]', { hasText: /^\s*Quote\s*$/ }).first(), {}, true);
  check(tapped && await arrived(page, 'quote'), 'a tap on "Quote" opened Quote in this tab', 'a tap on the "Quote" link did not open Quote');
  if (tapped) check(ctx.pages().length === pages && (await where(page)) === '/', '…with no new tab, the address bar still "/"', `…pages ${ctx.pages().length - pages} new, address ${await where(page)}`);
  check(!ctx.errors.length, 'no uncaught errors', `uncaught errors: ${ctx.errors.slice(0, 3).join(' | ')}`);
  await ctx.close();
}

await browser.close();
server.close();
if (fails.length) { console.error(`\nverify-new-tab: ${fails.length} failure(s)`); process.exit(1); }
console.log('\nverify-new-tab: every screen opens in a new tab, and a plain click still switches in place');
