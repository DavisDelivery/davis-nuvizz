#!/usr/bin/env node
// scripts/verify-stop-lookup.mjs — EVERY CONTROL ON THE STOP LOOKUP SCREEN, TAPPED, ON A PHONE AND A DESKTOP.
//
// Chad, 2026-09-30, a phone photo of "22 businesses match 'master'": "clicking this and nothing happens
// doens't show me the load these are the things i've told you to look for i want you to build this
// entire screen and test everything in it."
//
// The tap DID something. The customer's answer takes about ten seconds to read, and its only sign was
// "Looking…" on the search button — 889px above the phone's view. The layout guards could not see that:
// they measure a screen at rest, and a screen at rest was fine. So this one drives the real bundle
// through every control and holds every tap to one rule:
//
//   A TAP MUST CHANGE SOMETHING IN VIEW WITHIN 250ms.
//
// Every search answers from a stub AFTER a delay, so the first 250ms after a tap belong to the screen
// alone: a control whose only feedback is off screen, or arrives with the answer, fails here by name.
// On top of that rule each step says what the tap must have done — which request it sent, what opened.
//
// NEVER A REAL REQUEST. Every /.netlify/functions/ call is answered here; every other host is aborted.
// The two buttons on this screen that spend NuVizz calls in production (Ask NuVizz, the activity
// timeline) are tapped against stubs, so they are tested and cost nothing.
//
//   node scripts/verify-stop-lookup.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8823)   SHOTS=dir  screenshots per step
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { STOP_LOOKUP_DOSSIER, STOP_LOOKUP_NOTFOUND } from './lib/stop-lookup-fixture.mjs';
import { CUSTOMER_VIEW, ORDER_DETAIL, ORDER_EVENTS } from './lib/customer-view-fixture.mjs';
import { CUSTOMER_YEAR } from './lib/customer-year-fixture.mjs';
import { PLACE_VIEW } from './lib/place-search-fixture.mjs';
import { driverWeekAnswer } from './lib/driver-week-fixture.mjs';
import { CUSTOMER_CHOOSE, rowLoadAnswer, isRowLoadAsk, orderOn, FUTURE_DAY } from './lib/stop-lookup-flow-fixture.mjs';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8823;
const SHOTS = process.env.SHOTS || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
/** How long every search takes to answer. Long enough that feedback inside FEEDBACK_MS is the screen's own. */
const DELAY_MS = 900;
const FEEDBACK_MS = 250;
const ACTION_MS = 15000;

const GUARD_MS = Number(process.env.STOP_LOOKUP_TIMEOUT_MS) || 8 * 60 * 1000;
const watchdog = setTimeout(() => {
  console.error(`\n\x1b[31m✗ verify-stop-lookup exceeded ${Math.round(GUARD_MS / 1000)}s — failing rather than hanging the build\x1b[0m`);
  process.exit(1);
}, GUARD_MS);

const fails = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { fails.push(m); console.error(`  \x1b[31m✗\x1b[0m ${m}`); };

// ── THE STUBS ───────────────────────────────────────────────────────────────────────────────────
const PROMPTED_MISS = { ok: true, nuvizzCalls: 1, mode: 'stop', prompted: { attempted: true, ok: false, reason: 'not_found', text: 'NuVizz has no order 000000000.' } };
const ROSTER = { ok: true, drivers: [], roster: [], loads: [], at: '2026-09-18T12:00:00Z', count: 0 };
// Order pages whose one day is a case the load panel must say plainly (stop-lookup-flow-fixture.mjs).
const ORDERS = {
  '007199999': orderOn(STOP_LOOKUP_DOSSIER, '007199999', { date: FUTURE_DAY, route: 'GAINESVILLE 1', seq: 4 }),
  '007150001': orderOn(STOP_LOOKUP_DOSSIER, '007150001', { date: '2026-09-16', route: 'BRENT 1', driver: 'Brent  Boyd', seq: 1 }),
  '007160001': orderOn(STOP_LOOKUP_DOSSIER, '007160001', { date: '2026-09-15', route: 'FRANK 1', driver: 'FRANK OKINE', currentDriver: 'SAMUEL OSEI', seq: 4 }),
};
// A second business, answered SLOWER than the first, so a switch proves the older answer is dropped.
const GOODS_VIEW = { ...CUSTOMER_VIEW, query: 'earthly', view: { ...CUSTOMER_VIEW.view, name: 'EARTHLY GOODS', nameKey: 'earthly_goods' } };
function answer(u) {
  if (u.includes('stop-lookup-prompted')) return { body: PROMPTED_MISS, delay: DELAY_MS };
  if (u.includes('nuvizz-stop-events')) return { body: ORDER_EVENTS, delay: DELAY_MS };
  if (u.includes('stop-lookup')) {
    const q = new URL(u).searchParams;
    if (q.get('detail')) return { body: ORDER_DETAIL, delay: DELAY_MS };
    if (q.get('year')) return { body: CUSTOMER_YEAR, delay: DELAY_MS };
    if (q.get('nameKey') === 'earthly_goods') return { body: GOODS_VIEW, delay: DELAY_MS * 3 };
    if (q.get('name')) return { body: q.get('nameKey') || !/earthly/i.test(q.get('name')) ? CUSTOMER_VIEW : CUSTOMER_CHOOSE, delay: DELAY_MS };
    if (q.get('addr') || q.get('city') || q.get('zip')) return { body: PLACE_VIEW, delay: DELAY_MS };
    if (q.get('stop') === '000000000') return { body: STOP_LOOKUP_NOTFOUND, delay: DELAY_MS };
    if (ORDERS[q.get('stop')]) return { body: ORDERS[q.get('stop')], delay: DELAY_MS };
    return { body: STOP_LOOKUP_DOSSIER, delay: DELAY_MS };
  }
  if (u.includes('driver-loads')) return { body: isRowLoadAsk(u) ? rowLoadAnswer(u) : driverWeekAnswer(u), delay: DELAY_MS };
  if (u.includes('roster') || u.includes('drivers')) return { body: ROSTER, delay: 0 };
  return { body: { ok: true, stops: [], entries: [], items: [], count: 0 }, delay: 0 };
}

// ── WHAT IS ON SCREEN ───────────────────────────────────────────────────────────────────────────
/** Everything a person can SEE in the viewport: visible text, and the open/busy/disabled state of
 *  every control in view. Two equal signatures either side of a tap mean the tap changed nothing. */
const VIEW_SIG = () => {
  const vh = innerHeight, vw = innerWidth, out = [];
  const inView = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim();
    if (!t || !n.parentElement) continue;
    const el = n.parentElement, cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || !inView(el.getBoundingClientRect())) continue;
    out.push(`${t}@${Math.round(el.getBoundingClientRect().top / 4)}`);
  }
  // Controls by what a person SEES of their state — paint, not the `disabled` flag: a button that
  // turns disabled with no change of look is no feedback at all.
  for (const el of document.querySelectorAll('button,input,[aria-busy],[role="status"],[data-load-map]')) {
    if (!inView(el.getBoundingClientRect())) continue;
    const cs = getComputedStyle(el);
    out.push(`<${el.tagName} ${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 24)}|${el.getAttribute('aria-expanded')}|${el.getAttribute('aria-pressed')}|${cs.opacity}|${cs.backgroundColor}|${cs.color}|${cs.borderColor}|${el.value ?? ''}>`);
  }
  return out.join('\n');
};

/** Tap, and fail by name if nothing in view changed within FEEDBACK_MS. */
async function tap(page, loc, what, { atTop = false } = {}) {
  await loc.waitFor({ state: 'visible', timeout: ACTION_MS });
  // `atTop` puts the control at the top of the view first — where the phone's answer-scroll leaves
  // the chooser, and so where Chad was when his tap did nothing he could see.
  if (atTop) await loc.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  else await loc.scrollIntoViewIfNeeded();
  // The pointer rests on the control BEFORE the first look too, so its hover colour is in both and
  // never counts as the tap's feedback. A phone has no hover; a hover shade is not an answer.
  await loc.hover({ timeout: ACTION_MS }).catch(() => {});
  await page.waitForTimeout(60);
  const before = await page.evaluate(VIEW_SIG);
  await loc.click({ timeout: ACTION_MS });
  await page.waitForTimeout(FEEDBACK_MS);
  const after = await page.evaluate(VIEW_SIG);
  if (before === after) throw new Error(`tapping ${what} changed nothing in view within ${FEEDBACK_MS}ms`);
  if (process.env.DEBUG_TAPS) {
    const a = new Set(before.split('\n')), b = new Set(after.split('\n'));
    console.log(`      [${what}] +${[...b].filter((x) => !a.has(x)).slice(0, 4).join(' ; ')}  -${[...a].filter((x) => !b.has(x)).slice(0, 4).join(' ; ')}`);
  }
}
/** Settled: every stubbed answer delivered and the screen's busy line gone. Counted at the stub, not
 *  read off the screen — a screen that shows nothing while it reads must not look settled early. */
const idle = async (page) => {
  const dev = DEVS.get(page);
  const until = Date.now() + ACTION_MS;
  while (dev.pending > 0 && Date.now() < until) await page.waitForTimeout(50);
  if (dev.pending > 0) throw new Error('a stubbed answer never finished');
  await page.waitForFunction(() => !document.querySelector('[data-lookup-busy]'), null, { timeout: ACTION_MS });
  await page.waitForTimeout(100);
};
const DEVS = new Map();
const text = (page) => page.evaluate(() => document.body.innerText);
const inViewNow = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
}, sel);

/** Run one named step; a throw is a failure with the step's name on it, and the device's. */
async function step(dev, name, fn) {
  try { await fn(); ok(`${dev.name}: ${name}`); } catch (e) { bad(`${dev.name}: ${name} — ${String(e.message || e).split('\n')[0]}`); }
  if (SHOTS) await dev.page.screenshot({ path: join(SHOTS, `${dev.name}-${String(++dev.shot).padStart(2, '0')}.png`) }).catch(() => {});
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── GETTING THERE ───────────────────────────────────────────────────────────────────────────────
async function openLookup(dev, { keepRecent = false } = {}) {
  const { page } = dev;
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((keep) => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('dd_stop_lookup') && !(keep && k === 'dd_stop_lookup_recent')) localStorage.removeItem(k);
  }, keepRecent);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  if (dev.mobile) {
    await page.locator('button[title="Version menu"]').first().click();
    await page.waitForTimeout(300);
    const item = page.getByRole('menuitem', { name: /stop lookup/i }).first();
    if (!(await item.isVisible().catch(() => false))) { await page.getByRole('menuitem', { name: /^\s*more\s*$/i }).first().click(); await page.waitForTimeout(300); }
    await item.click();
  } else {
    // On the bar itself since v1.99.11, right of Routing, called "Stops" — one click, never through More.
    await page.locator('header nav').getByRole('button', { name: 'Stops', exact: true }).click();
  }
  await page.getByRole('heading', { name: 'Stop lookup' }).waitFor({ timeout: ACTION_MS });
  await page.waitForTimeout(300);
}
const orderBox = (page) => page.getByLabel('Find a customer by name, or a stop by PRO or stop number');
const lookUp = (page) => page.getByRole('button', { name: /^(look up|looking…)$/i });
async function searchOrder(dev, term) {
  await orderBox(dev.page).fill(term);
  await tap(dev.page, lookUp(dev.page), `Look up (“${term}”)`);
  await idle(dev.page);
}
const lastAsk = (dev, part) => [...dev.asks].reverse().find((u) => u.includes(part)) || '';

// ── THE SCREEN, CONTROL BY CONTROL ──────────────────────────────────────────────────────────────
async function sweep(dev) {
  const { page } = dev;
  await openLookup(dev);

  if (!dev.mobile) {
    await step(dev, 'the screen is the "Stops" tab on the bar, right of Routing, and More no longer lists it', async () => {
      const tabs = await page.locator('header nav button').evaluateAll((els) => els.map((e) => e.innerText.trim()));
      const at = tabs.indexOf('Stops');
      must(at > 0 && /^Routing/.test(tabs[at - 1]), `the bar reads: ${tabs.join(' | ')}`);
      await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^more$/i.test((x.innerText || '').trim())); if (b) b.click(); });
      await page.waitForTimeout(300);
      const inMore = await page.evaluate(() => [...document.querySelectorAll('button')].filter((x) => /^(stops|stop lookup)$/i.test((x.innerText || '').trim())).length);
      await page.keyboard.press('Escape');
      must(inMore === 1, `the screen is offered ${inMore} times with More open — once on the bar is the only place`);
    });
  }

  // 1. CHAD'S TAP. Several businesses match; the tapped one says so AT ONCE, in view.
  await step(dev, 'a customer name that several businesses match lists them to pick from', async () => {
    await orderBox(page).fill('earthly');
    await orderBox(page).press('Enter');
    await idle(page);
    must(/22 businesses match/.test(await text(page)), 'no chooser');
  });
  await step(dev, 'tapping a business says it is opening, on that row and at the top of the view; a second tap on it starts nothing; another business takes over', async () => {
    // The box is edited after the list appeared: the pick must still ask the list's own question.
    await orderBox(page).fill('zzz');
    const goods = page.getByRole('button', { name: /^EARTHLY GOODS/ }).first();
    const asksBefore = dev.asks.length;
    await tap(page, goods, 'a business in the chooser', { atTop: true });
    must(await page.locator('button[aria-busy="true"]').filter({ hasText: /Opening/ }).isVisible(), 'the tapped row does not say Opening');
    must(await inViewNow(page, '[data-lookup-busy]'), 'no status line in view while the customer is read');
    must(/Opening EARTHLY GOODS/.test(await page.locator('[data-lookup-busy]').innerText()), 'the status line does not name the business');
    await goods.click({ force: true, timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(150);
    must(dev.asks.slice(asksBefore).filter((u) => u.includes('stop-lookup')).length === 1, 'a second tap on the opening business started another read');
    // A mis-tap is not a wait: another business replaces the read, and the slower answer to the
    // first is dropped when it lands.
    await tap(page, page.getByRole('button', { name: /EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST/ }).first(), 'another business while the first is opening');
    must(/Opening EARTHLY ALTERNATIVE/.test(await page.locator('[data-lookup-busy]').innerText()), 'the status line did not switch to the new business');
    await idle(page);
    must(!(await text(page)).includes('EARTHLY GOODS'), 'the older, slower answer painted over the business picked last');
    const ask = lastAsk(dev, 'nameKey=');
    must(/name=earthly(&|$)/.test(ask), `the pick asked for the box's new text, not the list's question: ${ask}`);
    must(ask.includes(`nameKey=${CUSTOMER_VIEW.view.nameKey}`), 'the pick did not send the business key');
    must((await text(page)).includes('EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST') && !/businesses match/.test(await text(page)), 'the customer did not open');
  });

  // 2. THE CUSTOMER'S WINDOW.
  for (const [label, re] of [['7 days', dev.mobile ? /^7d$/ : /^Last 7 days$/], ['14 days', dev.mobile ? /^14d$/ : /^Last 14 days$/], ['Today', /^Today$/]]) {
    await step(dev, `the ${label} window re-reads the same customer`, async () => {
      const n = dev.asks.length;
      await tap(page, page.getByRole('group', { name: 'The customer\'s window' }).getByRole('button', { name: re }), `the ${label} pill`);
      await idle(page);
      const ask = dev.asks.slice(n).find((u) => u.includes('stop-lookup')) || '';
      must(/from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d/.test(ask) && ask.includes('nameKey='), `no re-read with the window and the customer: ${ask}`);
    });
  }
  await step(dev, 'a typed From date re-reads the window', async () => {
    const n = dev.asks.length;
    await page.getByLabel('From date', { exact: true }).fill('2026-09-10');
    await page.waitForTimeout(FEEDBACK_MS);
    must(await inViewNow(page, '[data-lookup-busy]') || dev.asks.length > n, 'nothing happened after the date was typed');
    await idle(page);
    must(dev.asks.slice(n).some((u) => u.includes('from=2026-09-10')), 'the typed date was not asked for');
  });
  await step(dev, 'the year button asks for the year, and "Last 14 days" comes back out of it', async () => {
    await tap(page, page.getByRole('group', { name: 'The customer\'s window' }).getByRole('button', { name: dev.mobile ? /^\d{4}$/ : /^All of \d{4}$/ }), 'the year button');
    await idle(page);
    must(lastAsk(dev, 'stop-lookup').includes('year='), 'no year= ask');
    await tap(page, page.getByRole('button', { name: /^Last 14 days$/ }).first(), 'Last 14 days (out of the year)');
    await idle(page);
    must(!lastAsk(dev, 'stop-lookup').includes('year='), 'still asking for the year');
  });

  // 3. AN ORDER ON THE CUSTOMER'S ROW.
  await step(dev, 'an order number opens its panel under the row, and tapping it again closes it', async () => {
    const pro = page.getByRole('button', { name: '007180001', exact: true }).first();
    await tap(page, pro, 'the order 007180001');
    await page.getByRole('button', { name: 'Close order detail' }).waitFor({ timeout: ACTION_MS });
    await tap(page, page.getByRole('button', { name: /Show the activity timeline/ }).first(), 'Show the activity timeline (stubbed — no call spent)');
    await page.waitForFunction(() => /DISPATCHED/.test(document.body.innerText), null, { timeout: ACTION_MS });
    await tap(page, pro, 'the open order 007180001 (to close it)');
    must(!(await page.getByRole('button', { name: 'Close order detail' }).isVisible().catch(() => false)), 'the panel did not close');
  });

  // 4. "DOESN'T SHOW ME THE LOAD" — the route opens the load under the row.
  await step(dev, 'a row\'s route opens that load under the row — map, stops, this order marked — without leaving the customer', async () => {
    const route = page.getByRole('button', { name: 'ATLANTA SOUTHWEST 3', exact: true }).first();
    await tap(page, route, 'the route ATLANTA SOUTHWEST 3');
    await page.getByRole('region', { name: 'ATLANTA SOUTHWEST 3 — the load' }).getByText('this order', { exact: true }).waitFor({ timeout: ACTION_MS });
    const ask = lastAsk(dev, 'driver-loads');
    must(/from=2026-09-18&to=2026-09-18/.test(ask) && /driver=ANDERSON/.test(ask), `the load was asked for wrongly: ${ask}`);
    const panel = page.getByRole('region', { name: 'ATLANTA SOUTHWEST 3 — the load' });
    must(await panel.locator('[data-load-map]').count() > 0 || /The map could not load/.test(await panel.innerText()), 'no map area in the load');
    must(/6 stops/.test(await panel.innerText()), 'the load does not say its stops');
    must((await text(page)).includes('EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST'), 'the customer left the screen');
    await tap(page, route, 'the open route (to close it)');
    must(await panel.count() === 0, 'the load did not close');
  });
  await step(dev, 'another of the customer\'s orders tapped inside the load opens ONCE, inside the load — one panel, one priced timeline button', async () => {
    const route = page.getByRole('button', { name: 'ATLANTA SOUTHWEST 3', exact: true }).first();
    await tap(page, route, 'the route ATLANTA SOUTHWEST 3');
    const panel = page.getByRole('region', { name: 'ATLANTA SOUTHWEST 3 — the load' });
    await panel.getByText('this order', { exact: true }).waitFor({ timeout: ACTION_MS });
    await tap(page, panel.locator('li').filter({ hasText: '007180003' }).getByRole('button').first(), 'the customer\'s order 007180003 inside the load');
    await panel.getByRole('button', { name: 'Close order detail' }).waitFor({ timeout: ACTION_MS });
    must(await page.getByRole('button', { name: 'Close order detail' }).count() === 1, `${await page.getByRole('button', { name: 'Close order detail' }).count()} order panels for one order`);
    await panel.getByRole('button', { name: /Show the activity timeline/ }).waitFor({ timeout: ACTION_MS });
    const priced = page.getByRole('button', { name: /Show the activity timeline/ });
    must(await priced.count() === 1, `${await priced.count()} priced timeline buttons for one order: ${(await priced.evaluateAll((els) => els.map((e) => `${e.innerText.slice(0, 50)} @${Math.round(e.getBoundingClientRect().top + scrollY)} in ${e.closest('section,[role=region],li,tr')?.getAttribute('aria-label') || e.closest('section,[role=region],li,tr')?.tagName}`))).join(' | ')}`);
    // Closing the load closes an order opened inside it — nothing is left open out of sight.
    await tap(page, panel.getByRole('button', { name: 'Close', exact: true }), 'Close on the load');
    must(await page.getByRole('button', { name: 'Close order detail' }).count() === 0, 'an order stayed open after its load closed');
  });
  await step(dev, 'a driver name two people answer to asks which, then a route none of their loads carry lists the day\'s loads to pick', async () => {
    const rows = page.getByRole('button', { name: 'ATLANTA SOUTHWEST 3', exact: true });
    await tap(page, rows.nth(1), 'ROBERT MENSAH-ADDAI\'s route');
    await tap(page, page.getByRole('button', { name: /^ROBERT MENSAH-ADDAI · 1 load$/ }), 'the right ROBERT');
    must(/key=/.test(lastAsk(dev, 'driver-loads')), 'the second ask did not go by key');
    await page.getByText(/No load named ATLANTA SOUTHWEST 3/).waitFor({ timeout: ACTION_MS });
    await tap(page, page.getByRole('button', { name: /^ROBERT 1 · 3 stops$/ }), 'ROBERT 1 in the day\'s loads');
    await page.getByText(/ROBERT 1 — /).waitFor({ timeout: ACTION_MS });
    must(/This order is not on ROBERT 1/.test(await page.getByRole('region', { name: 'ATLANTA SOUTHWEST 3 — the load' }).innerText()), 'a load that does not hold the order does not say so');
    await tap(page, page.getByRole('region', { name: 'ATLANTA SOUTHWEST 3 — the load' }).getByRole('button', { name: 'Close', exact: true }), 'Close on the load');
  });

  // 5. THE REST OF THE CUSTOMER'S PAGE.
  await step(dev, 'Edit on a dock opens the notes form under the card, and Cancel closes it', async () => {
    await tap(page, page.getByRole('button', { name: 'Edit', exact: true }).first(), 'Edit (receiving hours)');
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true }).filter({ visible: true }).first();
    await tap(page, cancel, 'Cancel');
    must(await page.getByRole('button', { name: 'Cancel', exact: true }).filter({ visible: true }).count() === 0, 'the form is still open');
  });
  await step(dev, 'an older delivery chip opens its order', async () => {
    await tap(page, page.getByRole('button', { name: /007100077/ }).first(), 'the older delivery 007100077');
    await page.getByRole('button', { name: 'Close order detail' }).waitFor({ timeout: ACTION_MS });
    await tap(page, page.getByRole('button', { name: 'Close order detail' }), 'Close on the order');
  });
  await step(dev, '"Where we looked" opens and closes', async () => {
    const led = page.getByRole('button', { name: /Where we looked/ }).first();
    const was = await led.getAttribute('aria-expanded');
    await tap(page, led, 'Where we looked');
    must((await led.getAttribute('aria-expanded')) !== was, 'it did not toggle');
  });

  // 6. AN ORDER BY NUMBER.
  await step(dev, 'a PRO opens its full history; a day opens its record and its route opens the load', async () => {
    await searchOrder(dev, '007174397');
    must(/TITAN ELECTRIC/.test(await text(page)), 'the order did not open');
    await tap(page, page.getByRole('button', { name: 'PEACHTREE CORNERS 2', exact: true }).first(), 'the route PEACHTREE CORNERS 2');
    await page.getByRole('region', { name: 'PEACHTREE CORNERS 2 — the load' }).getByText('this order', { exact: true }).waitFor({ timeout: ACTION_MS });
    must(/from=2026-09-17&to=2026-09-17/.test(lastAsk(dev, 'driver-loads')), 'the wrong day was asked for');
    await tap(page, page.getByRole('region', { name: 'PEACHTREE CORNERS 2 — the load' }).getByRole('button', { name: 'Close', exact: true }), 'Close on the load');
    await tap(page, page.getByRole('button', { name: /Sep 1[5-7]|9\/1[5-7]/ }).first(), 'a day of the order');
    await page.getByRole('button', { name: 'Close order detail' }).waitFor({ timeout: ACTION_MS });
    await tap(page, page.getByRole('button', { name: 'Close order detail' }), 'Close on the day');
  });
  await step(dev, 'a driver the alias list renamed is never "no load": the day\'s drivers are listed, and picking one opens the load that holds the order', async () => {
    await searchOrder(dev, '007150001');
    await tap(page, page.getByRole('button', { name: 'BRENT 1', exact: true }).first(), 'the route BRENT 1 (driver renamed)');
    const panel = page.getByRole('region', { name: 'BRENT 1 — the load' });
    await panel.getByText(/No driver in our records for .* is called/).waitFor({ timeout: ACTION_MS });
    must(!/no load to open/i.test(await panel.innerText()), 'it says there is no load');
    await tap(page, panel.getByRole('button', { name: /^Brent Bryd · 1 load$/i }), 'the renamed driver in the day\'s list');
    await panel.getByText('this order', { exact: true }).waitFor({ timeout: ACTION_MS });
    must(/key=/.test(lastAsk(dev, 'driver-loads')), 'the pick did not go by key');
  });
  await step(dev, 'a route whose load does not hold the order (moved that day) says so above the load', async () => {
    await searchOrder(dev, '007160001');
    await tap(page, page.getByRole('button', { name: 'FRANK 1', exact: true }).first(), 'the route FRANK 1 (order moved)');
    const panel = page.getByRole('region', { name: 'FRANK 1 — the load' });
    await panel.getByText(/This order is not on FRANK 1/).waitFor({ timeout: ACTION_MS });
    must(await panel.getByText('this order', { exact: true }).count() === 0, 'an order not on the load is marked on it');
  });
  await step(dev, 'a route on a day that has not happened says the load has not run yet — never that there is no load', async () => {
    await searchOrder(dev, '007199999');
    await tap(page, page.getByRole('button', { name: 'GAINESVILLE 1', exact: true }).first(), 'the route GAINESVILLE 1 (a future day)');
    await page.getByText(/GAINESVILLE 1 runs .*, which has not happened yet/).waitFor({ timeout: ACTION_MS });
    must(!/no load/i.test(await page.getByRole('region', { name: 'GAINESVILLE 1 — the load' }).innerText()), 'it says there is no load');
    await searchOrder(dev, '007174397');
  });
  await step(dev, 'one of the customer\'s other orders opens that order', async () => {
    await tap(page, page.getByRole('button', { name: /007100001/ }).first(), 'the customer\'s order 007100001');
    await idle(page);
    must(lastAsk(dev, 'stop-lookup').includes('stop=007100001'), 'it did not look the order up');
  });
  await step(dev, 'an order we have never seen offers the priced NuVizz ask, and the answer says so (stubbed — no call spent)', async () => {
    await searchOrder(dev, '000000000');
    await tap(page, page.getByRole('button', { name: /Ask NuVizz for this order — 1 call/ }), 'Ask NuVizz — 1 call');
    await page.getByText('NuVizz has nothing either.').waitFor({ timeout: ACTION_MS });
    must(/1 NuVizz call — on request/.test(await text(page)), 'the spend is not on the header chip');
  });
  await step(dev, 'the X in the order box clears the box and its answer', async () => {
    await tap(page, page.getByRole('button', { name: 'Clear the order search' }), 'the X in the order box');
    must((await orderBox(page).inputValue()) === '', 'the box still has text');
    must(/Recent lookups/.test(await text(page)), 'the answer is still on screen');
  });

  // 7. AN ADDRESS, A CITY OR A ZIP.
  await step(dev, 'a city search finds its stops, and a stop\'s route opens its load', async () => {
    await page.getByLabel('City', { exact: true }).fill('ATLANTA');
    await tap(page, page.getByRole('button', { name: /^(Find stops|Searching…)$/ }), 'Find stops');
    await idle(page);
    must(lastAsk(dev, 'stop-lookup').includes('city=ATLANTA'), 'no city ask');
    await tap(page, page.getByRole('button', { name: 'ATLANTA SOUTHWEST 3', exact: true }).first(), 'a route in the address results');
    await page.getByRole('region', { name: 'ATLANTA SOUTHWEST 3 — the load' }).waitFor({ timeout: ACTION_MS });
  });
  await step(dev, 'a date button on the address search re-searches the same place', async () => {
    const n = dev.asks.length;
    await tap(page, page.getByRole('group', { name: 'Dates to search' }).getByRole('button', { name: 'This week' }), 'This week (address dates)');
    await idle(page);
    must(dev.asks.slice(n).some((u) => u.includes('city=ATLANTA')), 'no re-search');
  });
  await step(dev, 'Clear on the address search empties it and its answer', async () => {
    await tap(page, page.getByRole('button', { name: 'Clear', exact: true }), 'Clear (address)');
    must((await page.getByLabel('City', { exact: true }).inputValue()) === '', 'the city is still typed');
  });

  // 8. A DRIVER'S LOADS.
  await step(dev, 'Show loads with no name lists who ran loads, and a name opens that driver\'s loads', async () => {
    await tap(page, page.getByRole('button', { name: /^(Show loads|Reading…)$/ }), 'Show loads');
    await idle(page);
    await tap(page, page.getByRole('button', { name: /ROBERT MENSAH-ADDAI/ }).first(), 'a driver in the list');
    await idle(page);
    must(/Driver.s loads/.test(await text(page)) && /ROBERT MENSAH-ADDAI/.test(await text(page)), 'the week did not open');
  });
  await step(dev, 'Map & stops opens a load and closes it again', async () => {
    // Case-blind: open, the phone's button reads "Hide map & stops" — the same button.
    const btn = page.getByRole('button', { name: /map & stops/i }).first();
    await tap(page, btn, 'Map & stops');
    must((await btn.getAttribute('aria-expanded')) === 'true', 'the load did not open');
    await tap(page, btn, 'Map & stops (to close)');
  });
  await step(dev, 'a date button re-reads the same driver', async () => {
    const n = dev.asks.length;
    await tap(page, page.getByRole('group', { name: 'Dates to show' }).getByRole('button', { name: 'Last week' }), 'Last week (driver dates)');
    await idle(page);
    must(dev.asks.slice(n).some((u) => u.includes('driver-loads') && (u.includes('key=') || u.includes('driver='))), 'no re-read for the driver');
  });
  await step(dev, 'the X on the driver clears the name and the week', async () => {
    await tap(page, page.getByRole('button', { name: 'Clear the driver' }), 'the X on the driver');
    must(await page.getByRole('region', { name: 'Driver\'s week' }).count() === 0, 'the week is still on screen');
  });

  // 9. RECENT LOOKUPS.
  await step(dev, 'a recent lookup runs again when tapped', async () => {
    await openLookup(dev, { keepRecent: true });
    must(/Recent lookups/.test(await text(page)), 'no recent lookups');
    await tap(page, page.getByRole('region', { name: 'Recent lookups' }).getByRole('button').filter({ hasNotText: 'Clear list' }).first(), 'a recent lookup');
    await idle(page);
  });
  await step(dev, 'Clear list empties the recent lookups', async () => {
    await openLookup(dev, { keepRecent: true });
    await tap(page, page.getByRole('button', { name: 'Clear list' }), 'Clear list');
    must(/Nothing looked up on this device yet/.test(await text(page)), 'the list is still there');
  });
}

// ── RUN ─────────────────────────────────────────────────────────────────────────────────────────
const srv = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' }); return res.end(b); } catch { /* next */ }
  }
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(PORT, r));
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });

console.log('\nStop lookup — every control, tapped\n');
for (const d of [{ name: 'phone 390', width: 390, height: 844, mobile: true }, { name: 'desktop 1440', width: 1440, height: 900, mobile: false }]) {
  console.log(`\x1b[1m${d.name}\x1b[0m`);
  const ctx = await browser.newContext({ viewport: { width: d.width, height: d.height }, isMobile: d.mobile, hasTouch: d.mobile, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const dev = { ...d, page, asks: [], shot: 0, leaked: [], pending: 0 };
  DEVS.set(page, dev);
  page.setDefaultTimeout(ACTION_MS);
  // Every other host is refused, and anything that reaches the network is written down: this guard
  // may never send a real request, least of all to a NuVizz-backed endpoint.
  await page.route((url) => url.hostname !== '127.0.0.1', (route) => { dev.leaked.push(route.request().url()); return route.abort(); });
  await page.route('**/.netlify/functions/**', async (route) => {
    const u = route.request().url();
    dev.asks.push(decodeURIComponent(u.replace(/^.*\/\.netlify\/functions\//, '')).replace(/\+/g, ' '));
    const a = answer(u);
    dev.pending += 1;
    try {
      if (a.delay) await new Promise((r) => setTimeout(r, a.delay));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(a.body) }).catch(() => {});
    } finally { dev.pending -= 1; }
  });
  page.on('dialog', (x) => x.accept());
  try { await sweep(dev); } catch (e) { bad(`${d.name}: the sweep stopped — ${String(e.message || e).split('\n')[0]}`); }
  const external = dev.leaked.filter((u) => !/googleapis|gstatic|fonts\./.test(u));
  if (external.length) bad(`${d.name}: requests left for other hosts (refused): ${[...new Set(external)].slice(0, 3).join(', ')}`);
  await ctx.close();
  console.log('');
}
await browser.close();
srv.close();
clearTimeout(watchdog);
if (fails.length) { console.log(`\x1b[31m✗ ${fails.length} step(s) failed\x1b[0m\n`); process.exit(1); }
console.log('\x1b[32m✓ every control on Stop lookup answers a tap, on a phone and a desktop\x1b[0m\n');
