#!/usr/bin/env node
// scripts/verify-loads-tab.mjs — DOES THE LOADS TAB ACTUALLY SHOW THE EMPTY LOADS?
//
// Chad, on the Routing rail reading Routes (3) beside Loads (3) with the same three loads
// under both: "Where are all my empty loads. Routes are loads that have stops on them and
// loads should just be all the empty loads."
//
// test/day-loads.test.mjs proves splitDayLoads sorts a row into the right bucket. It cannot
// prove the RAIL is fed the right bucket, that the two tabs stopped repeating each other on a
// real board, or that the phone got the same change as the desktop — and this app has shipped
// a screen into one navigation and not the other twice. A tab that shows the wrong list is
// exactly what Chad reported, and it was a wiring fact, not a logic one. So this drives the
// real bundle against a fixture board with all four kinds of load on it.
//
//   node scripts/verify-loads-tab.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8809)
//     SHOT=path.png  also write a screenshot of the desktop rail
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8809;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { fails.push(m); console.error(`  \x1b[31m✗\x1b[0m ${m}`); };

// A HARD CEILING ON THE WHOLE RUN. The first version of this guard had none, and the smoke
// job it joined then ran twenty minutes without finishing — three times its healthy six — on
// two runs, with the log unreadable while in progress. WHAT THAT DOES NOT ESTABLISH is that
// this guard was the thing stalling: it was the only step that changed, which is a suspicion,
// not a measurement, and the log that would have settled it could not be read. So the fix is
// not aimed at a diagnosis nobody has. Fourteen browser contexts, each with clicks that
// `.catch()` their own timeouts, is a lot of places for a wait to go quiet, and a step that
// never finishes is worse than one that fails: red tells you something, a spinner tells you
// nothing and blocks the merge either way. Locally the whole run is ~52s.
const GUARD_MS = Number(process.env.LOADS_TAB_TIMEOUT_MS) || 8 * 60 * 1000;
const PAGE_MS = Number(process.env.LOADS_TAB_ACTION_MS) || 15000;
const watchdog = setTimeout(() => {
  console.error(`\n\x1b[31m✗ verify-loads-tab exceeded ${Math.round(GUARD_MS / 1000)}s — failing rather than hanging the build\x1b[0m`);
  process.exit(1);
}, GUARD_MS);

// A FIXTURE BOARD WITH ALL FOUR KINDS OF LOAD ON IT, which is the only way to tell the buckets
// apart: two loads built on the board, three empty trailers, and one the roster says carries
// twelve orders whose stops have not arrived. That last one is the reason the split is by
// onBoard — it belongs to neither tab under the obvious rule, and vanishing is the failure.
const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DEG = 1 / 69.055;
const stopsFor = (routeName, loadId, loadNbr, n, base) => Array.from({ length: n }, (_, i) => ({
  stopNbr: `${base}${i}`, pro: `${base}${i}`, businessName: `${routeName} CO ${i + 1}`,
  addr1: `${100 + i} Fixture Rd`, city: 'BUFORD', state: 'GA', zip: '30518',
  lat: DEPOT.lat + (10 + i) * DEG, lng: DEPOT.lng,
  cartons: 2, volume: 0, weight: 500,
  status: '10', normalizedStatus: 'PLANNED', stopType: 'DL',
  loadNbr, routeName, loadId, routeSeq: i + 1,
  driverName: 'TEST DRIVER', driverUserName: 'tdriver',
  matchKey: `${loadId}_${i}`,
}));
const STOPS = [
  ...stopsFor('CHAD', 'ld-one', 'DAVIS000200601', 3, '9010'),
  ...stopsFor('ESTES', 'ld-two', 'DAVIS000200602', 2, '9020'),
];
const BUILT = [
  { loadId: 'ld-one', name: 'CHAD', loadNbr: 'DAVIS000200601', status: 'Dispatched', trips: 3 },
  { loadId: 'ld-two', name: 'ESTES', loadNbr: 'DAVIS000200602', status: 'Planned', trips: 2 },
];
const EMPTIES = ['1 SATL', '1 WATL', 'ALPHA'].map((name, i) => ({
  loadId: `ld-empty-${i}`, name, loadNbr: `DAVIS00020070${i}`, status: 'Draft', trips: 0,
}));
const OFF_BOARD = { loadId: 'ld-t9', name: 'TRAILER 9', loadNbr: 'DAVIS000200609', status: 'Planned', trips: 12 };
// A capture stamp the page can render an age from. Fixed, so the assertions never race a clock.
const ROSTER_AT = new Date(Date.now() - 6 * 3600 * 1000).toISOString();

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

/** Open Routing with the rail on Routes/Loads, Loads selected, and this roster in the vendor. */
async function openLoadsTab({ mobile, roster, liveRoster, rosterFail }) {
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  // Every locator wait is bounded. Without this a `.click().catch(() => {})` on a control that
  // never appears sits on Playwright's 30s default, and there are a dozen of them here.
  page.setDefaultTimeout(PAGE_MS);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The rail mode and sub-tab are persisted choices, and Chad's are Routes/Loads + Loads.
  await page.addInitScript(() => {
    try { localStorage.setItem('routing.rightPanel', 'routesLoads'); localStorage.setItem('routing.routesLoadsTab', 'loads'); } catch { /* ignore */ }
  });
  const asked = [];
  await page.route('**/.netlify/functions/**', (route) => {
    const u = route.request().url();
    const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.includes('nuvizz-loads-roster')) {
      if (rosterFail) { asked.push('fail'); return json({ ok: false, reason: 'roster failed' }); }
      // THE VENDOR'S TWO ANSWERS ARE DIFFERENT, deliberately. `roster` is what the CACHE
      // holds and `liveRoster` (when given) is what NuVizz would say right now — which is the
      // whole shape of Chad's Saturday: a capture taken this morning, before Tuesday's empty
      // trailers existed, frozen until the next scan day because nothing could re-pull it.
      const live = /[?&]live=1/.test(u);
      asked.push(live ? 'live' : 'cache');
      const rows = live && liveRoster ? liveRoster : roster;
      return json({ ok: true, source: live ? 'live' : 'cache', at: ROSTER_AT, count: rows.length, loads: rows });
    }
    if (u.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: STOPS, count: STOPS.length, source: 'fixture' });
    if (u.includes('route-departures')) return json({ ok: true, published: false, usedByBoard: false, table: null });
    if (u.includes('travel-model')) return json({ ok: true, legs: {}, legCount: 0, googleEnabled: false });
    return json({ ok: true, stops: [], rows: [], results: [], items: [], entries: [], count: 0 });
  });
  for (const host of ['googleapis.com', 'gstatic.com', 'google.com']) await page.route(`**://*.${host}/**`, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  if (mobile) {
    await page.locator('[data-phone-menu-trigger], header button').first().click().catch(() => {});
    await page.waitForTimeout(700);
  }
  await page.getByText('Routing (beta)', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1800);
  return { page, ctx, errors, asked };
}

// The panel's own text, isolated from the rest of the screen: the bottom grid ALSO lists loads
// (deliberately — Chad keeps that view in full), so asserting on document.innerText would let
// a grid row stand in for a rail row and pass a broken tab.
async function panelText(page) {
  return page.evaluate(() => {
    // The panel names itself (data-day-loads-panel). The placeholder fallback below is
    // deliberately LOOSE — it matches the pre-fix wording too — so that running this guard
    // against an older build fails on WHAT THE TAB SHOWS rather than on "the panel was not
    // found", which is the same red for a different reason and proves nothing about the bug.
    const named = document.querySelector('[data-day-loads-panel]');
    if (named) return named.innerText || '';
    const anchor = Array.from(document.querySelectorAll('input'))
      .find((i) => /^Search .*loads/i.test(i.getAttribute('placeholder') || ''));
    if (!anchor) return null;
    let el = anchor;
    for (let i = 0; i < 6 && el.parentElement; i += 1) el = el.parentElement;
    return el.innerText || '';
  });
}

const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

async function run(label, { mobile, roster, liveRoster, rosterFail }, check) {
  // The elapsed stamp is not decoration: the run that would not finish left a log nobody could
  // read, so "which of the fourteen states was it on" had no answer at all. Now the last line
  // printed names it, and the next stall diagnoses itself instead of being guessed at.
  console.log(`\n${label}  [${secs()}]`);
  const { page, ctx, errors, asked } = await openLoadsTab({ mobile, roster, liveRoster, rosterFail });
  // ON A PHONE THE RAIL IS TWO TAPS, NOT ONE, and they are not the taps the desktop takes —
  // which is the whole reason this guard walks both views. The bottom sheet's middle tab is
  // labelled with the MODE ("Routes (1)"), not with the sub-tab; the Routes/Loads toggle only
  // exists once that sheet panel is open, and the persisted sub-tab decides which half shows.
  if (mobile) {
    await page.getByRole('button', { name: /^Routes/ }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    // Belt and braces: if the persisted sub-tab did not survive, take the toggle by hand.
    const seen = await page.evaluate(() => !!document.querySelector('[data-day-loads-panel]')
      || Array.from(document.querySelectorAll('input'))
        .some((i) => /^Search .*loads/i.test(i.getAttribute('placeholder') || '')));
    if (!seen) {
      await page.getByRole('button', { name: /^Loads/ }).first().click().catch(() => {});
      await page.waitForTimeout(700);
    }
  }
  const text = await panelText(page);
  if (text == null) bad(`${label}: the Loads panel never rendered (no search field found)`);
  else await check(text, page, { asked });
  if (errors.length) bad(`${label}: page errors — ${errors.join(' | ')}`);
  if (!mobile && process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false }).catch(() => {});
  await ctx.close();
}

const FULL = [...BUILT, ...EMPTIES, OFF_BOARD];

for (const mobile of [false, true]) {
  const view = mobile ? 'phone 390px' : 'desktop 1600px';

  await run(`A full board — ${view}`, { mobile, roster: FULL }, (text) => {
    for (const e of EMPTIES) {
      if (text.includes(e.name)) ok(`${e.name} — the empty trailer is on the Loads tab`);
      else bad(`${e.name} is missing from the Loads tab (${view})`);
    }
    for (const b of BUILT) {
      if (text.includes(b.name)) bad(`${b.name} is repeated on the Loads tab — that IS the bug (${view})`);
      else ok(`${b.name} stays in Routes and is not repeated here`);
    }
    if (/Has orders, not on the board \(1\)/i.test(text)) ok('the load whose stops never arrived has its own section, not a hiding place');
    else bad(`no "Has orders, not on the board (1)" section (${view})`);
    if (text.includes('TRAILER 9')) ok('…and TRAILER 9 is listed in it');
    else bad(`TRAILER 9 vanished from both tabs (${view})`);
    if (/3 empty/.test(text) && /2 built in Routes/.test(text) && /1 not on the board/.test(text)) ok('the header counts this panel’s own rows: 3 empty · 2 built in Routes · 1 not on the board');
    else bad(`header line wrong (${view}): ${JSON.stringify((text.split('\n').find((l) => /empty/.test(l)) || '').slice(0, 120))}`);
  });

  await run(`A day whose roster could not be read — ${view}`, { mobile, rosterFail: true }, (text) => {
    // ABSENT IS NOT ZERO, and the previous test for it — `loadRosterList.length > 0` — could
    // not tell "the vendor said none" from "we never got an answer": both are an empty array.
    if (/could not be read/i.test(text)) ok('it says the roster could not be read');
    else bad(`an unreadable roster does not say so (${view}): ${JSON.stringify(text.slice(0, 220))}`);
    if (/Nothing empty left to fill/i.test(text)) bad(`an unreadable roster claims the day is fully built (${view})`);
    else ok('…and does not claim the day is fully built');
    if (/Load roster not pulled for this day/i.test(text)) ok('…and the freshness line agrees with the empty state');
    else bad(`the freshness line does not report the absence (${view})`);
  });

  await run(`A day with no empty loads left — ${view}`, { mobile, roster: BUILT }, (text) => {
    if (/Nothing empty left to fill/i.test(text)) ok('it says every load is already built and sends the reader to Routes');
    else bad(`a fully-built day does not say so (${view}): ${JSON.stringify(text.slice(0, 200))}`);
    if (/could not be read/i.test(text)) bad(`a fully-built day claims the roster is missing (${view})`);
    else ok('…and does not claim the roster is missing');
    if (/2 loads · cached/i.test(text)) ok('…and says how old the roster behind that claim is');
    else bad(`no roster age on a cached roster (${view}): ${JSON.stringify((text.split('\n').find((l) => /cached|roster/i.test(l)) || '').slice(0, 120))}`);
  });

  // ── CHAD'S SATURDAY, DRIVEN END TO END ────────────────────────────────────
  // The cache holds this morning's capture — three loads, all of them carrying stops, taken
  // before Tuesday's empty trailers existed. NuVizz would say something different right now.
  // NO REFRESH CONTROL, AND NO SURFACE MAY SPEND A CALL ON ITS OWN.
  //
  // This block used to press a "Refresh" on the tab and assert a ?live=1 went out. Chad: "I
  // don't need a roster refresh button remove it." Since v0.93.9 the Scan now control pulls the
  // roster for the board date on screen AND the next business day, so a second control bought
  // nothing and cost a second copy of the state — this rail and the bottom grid each held their
  // own roster, so refreshing one left the other showing the older answer for the same day.
  //
  // The rule is now the opposite of what it was, so the test is too: opening the tab spends
  // NOTHING, there is no Refresh inside it, and the freshness line still says how old the list
  // is — which is the only thing that can tell "no empty loads" from "nobody asked today".
  await run(`The Loads tab spends nothing and offers no Refresh — ${view}`,
    { mobile, roster: BUILT, liveRoster: [...BUILT, ...EMPTIES] }, async (text, page, { asked }) => {
      if (asked.includes('live')) bad(`something spent a live roster call without being asked (${view})`);
      else ok('opening the tab spends no vendor call — cache only');

      const found = await page.evaluate(() => {
        const panel = document.querySelector('[data-day-loads-panel]');
        if (!panel) return { panel: false };
        return {
          panel: true,
          refresh: Array.from(panel.querySelectorAll('button'))
            .map((x) => (x.innerText || '').trim()).filter((t) => /^Refresh/i.test(t)),
        };
      });
      if (!found.panel) { bad(`no Loads panel at all (${view})`); return; }
      if (found.refresh.length) bad(`a Refresh control is still on the Loads tab (${view}): ${JSON.stringify(found.refresh)}`);
      else ok('there is no Refresh control on the tab');

      // The line is what survives the button, so it has to be there. Matched on the rail's own
      // wording (rosterFreshness -> "N loads · cached 6h ago"), NOT the grid's "Load roster:"
      // prefix — the two surfaces render the same fact with different chrome, and asserting one
      // panel's copy against the other's is how a green run stops meaning anything.
      if (/·\s*(cached|straight from NuVizz)/i.test(text || '') || /not pulled/i.test(text || '')) {
        ok('…and the freshness line still says where the list came from');
      } else bad(`the freshness line is gone too (${view}) — absent can no longer be told from zero`);

      await page.waitForTimeout(600);
      if (asked.includes('live')) bad(`the tab spent a live call with nobody pressing anything (${view})`);
      else ok('…and still nothing has reached NuVizz');
    });
}

// ── AND THE BOTTOM GRID, WHICH IS WHERE CHAD LOOKED ───────────────────────────────────────
// "even on the bottom panel the empty loads are missing." The grid renders every empty load it
// is handed — measured at 100 of 100 — so the fault was never here; it was that the roster it
// is handed can be a frozen capture, and the grid said nothing about that either. It has the
// same freshness line and the same one-call Refresh now, and this drives both.
async function gridLoadsText(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    const t = tables.find((tb) => /%\s*Done/i.test(tb.querySelector('thead')?.innerText || ''));
    if (!t) return null;
    // The grid's Loads pane: the scroller plus the freshness bar that sits above it.
    const pane = t.closest('.overflow-auto')?.parentElement;
    return (pane || t).innerText || '';
  });
}

for (const mobile of [false, true]) {
  const view = mobile ? 'phone 390px' : 'desktop 1600px';
  console.log(`\nThe bottom grid's Loads view — ${view}  [${secs()}]`);
  // THE CACHE IS THE ONLY SOURCE NOW. This block used to open on a BUILT-only capture and press
  // Refresh to bring the rest in; with the button gone, the roster the scanner captured IS what
  // the grid shows, so the fixture seeds it directly. The assertions below are unchanged and
  // still the ones that matter — every empty renders, and the off-board load is not called
  // empty. (A line saying what the rows were made of used to be asserted here too; Chad:
  // "I don't need the panel to state what they are" — it is gone, and so is the assertion.)
  //
  // The BUILT-only case did not disappear with the button: it is asserted in the rail block
  // above ("with a capture that has no empties, it shows none"), which is where the
  // absent-is-not-zero rule lives.
  const FULL_ROSTER = [...BUILT, ...EMPTIES, OFF_BOARD];
  const { page, ctx, errors, asked } = await openLoadsTab({ mobile, roster: FULL_ROSTER, liveRoster: FULL_ROSTER });
  // The grid's own Stops/Loads toggle reads "Loads <count>"; the rail's reads "Loads (N)".
  const opened = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /^Loads\s+\d+$/.test((x.innerText || '').replace(/\n/g, ' ').trim()));
    if (!b) return false;
    b.click();
    return true;
  });
  if (!opened) bad(`the bottom grid's Loads view is not reachable (${view})`);
  else {
    await page.waitForTimeout(1400);
    const before = await gridLoadsText(page);
    if (before == null) bad(`the bottom grid's Loads table never rendered (${view})`);
    else {
      if (/cached/i.test(before)) ok('the grid says the roster it is showing is a cache, and how old');
      else bad(`no roster freshness line on the grid (${view}): ${JSON.stringify(before.slice(0, 200))}`);
      if (EMPTIES.every((e) => before.includes(e.name))) ok(`…and all ${EMPTIES.length} empty trailers are on it, straight from the capture`);
      else bad(`the grid dropped empties the capture holds (${view})`);
      // CHAD'S EXACT REPORT, RENDERED. "the routes panel on right is now populating my loads
      // panel on the bottom." With a roster holding only the built loads, the grid's Loads
      // view IS the Routes list — the same two rows, correctly — and until now nothing on the
      // screen said whether that was the day or a fault. The line has to be readable off the
      // NO REFRESH ON THE GRID EITHER — the same removal, on the other surface. Writing this
      // assertion once per view is what stops the two drifting: this repo has shipped a control
      // into one navigation and not the other twice.
      const stillThere = await page.evaluate(() => {
        const tables = Array.from(document.querySelectorAll('table'));
        const t = tables.find((tb) => /%\s*Done/i.test(tb.querySelector('thead')?.innerText || ''));
        const pane = t?.closest('.overflow-auto')?.parentElement;
        if (!pane) return null;
        return Array.from(pane.querySelectorAll('button'))
          .map((x) => (x.innerText || '').trim()).filter((t2) => /^Refresh/i.test(t2));
      });
      if (stillThere === null) bad(`could not find the grid's Loads pane (${view})`);
      else if (stillThere.length) bad(`a Refresh control is still on the grid (${view}): ${JSON.stringify(stillThere)}`);
      else ok('there is no Refresh control on the grid either');
      if (asked.includes('live')) bad(`the grid spent a live roster call on open (${view}); asks were ${JSON.stringify(asked)}`);
      else ok('…and opening the Loads view spends no vendor call');
      {
        const after = before;
        const back = EMPTIES.filter((e) => (after || '').includes(e.name)).length;
        if (back === EMPTIES.length) ok(`…and all ${EMPTIES.length} empty trailers arrive in the grid`);
        else bad(`only ${back}/${EMPTIES.length} empties came back in the grid (${view})`);
        // AND THE OFF-BOARD LOAD IS NOT CALLED EMPTY. `empty` was hardcoded true for every
        // roster row the board had no stops for, so TRAILER 9 — which NuVizz says carries
        // twelve trips — rendered "No orders yet" beside a Stops column reading 12. Two cells
        // contradicting each other, and the wrong one is the one that gets acted on: nobody
        // plans freight onto a load that already has twelve stops. The rail has shown this
        // bucket under its own heading since v0.93.2; the grid was still calling it empty.
        if ((after || '').includes(OFF_BOARD.name)) {
          ok(`the off-board load ${OFF_BOARD.name} reaches the grid at all`);
          const row = await page.evaluate((name) => {
            const tr = Array.from(document.querySelectorAll('tr')).find((r) => (r.innerText || '').includes(name));
            return tr ? (tr.innerText || '').replace(/\s+/g, ' ').trim() : null;
          }, OFF_BOARD.name);
          if (/Not on this board/.test(row || '')) ok(`…labelled "Not on this board · ${OFF_BOARD.trips} trips", not "No orders yet"`);
          else bad(`the grid calls a ${OFF_BOARD.trips}-trip load empty (${view}): ${JSON.stringify(row)}`);
          if (!/No orders yet/.test(row || '')) ok('…and it does not also claim it has no orders');
          else bad(`the off-board row still says "No orders yet" (${view}): ${JSON.stringify(row)}`);
        } else bad(`the off-board load ${OFF_BOARD.name} never reached the grid (${view})`);
      }
    }
  }
  if (errors.length) bad(`grid ${view}: page errors — ${errors.join(' | ')}`);
  await ctx.close();
}

clearTimeout(watchdog);
await browser.close();
server.close();
// closeAllConnections: a keep-alive socket Chromium left open makes server.close() wait for
// it forever, and the process then never exits even though every check has finished. The
// explicit exit is what verify-route-preflight and verify-flag-detail both do, for this
// reason; this guard shipped without it and that is the deviation that cost the build.
server.closeAllConnections?.();
console.log(fails.length
  ? `\n\x1b[31m${fails.length} problem(s) with the Loads tab\x1b[0m  [${secs()}]`
  : `\n\x1b[32m✓ the Loads tab shows the empty loads, on both views\x1b[0m  [${secs()}]`);
process.exit(fails.length ? 1 : 0);
