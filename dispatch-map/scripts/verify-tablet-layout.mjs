// TABLET LAYOUT GUARD — the view nobody was looking at.
//
// Chad, on an iPad: "FORMATTING ISSUES ON IPAD".
//
// He was right, and the reason nothing caught it is structural rather than careless. This app
// deliberately has two views: below MOBILE_BREAKPOINT (768px) it renders the phone layout,
// above it the desktop one. An iPad is 1024-1194px wide, so it gets the DESKTOP layout — a
// layout designed for a mouse — and it is a TOUCH device.
//
// Every guard the build had looks at one end or the other:
//   verify-mobile-layout   390 / 360     collisions, clipping, touch floor
//   verify-desktop-layout  1440 / 1920   occupancy only — no collision check at all
//
// So a tablet is measured by neither, and the first sweep at iPad width found it: 43 controls
// under the 44px touch floor (nav tabs at 32px, Build/Engine at 26px, one at 18x26), a Status
// dropdown anchored `right-0` that hung off the LEFT edge of the screen once its toolbar
// wrapped, and a collision between that menu and the Stops pill in portrait.
//
// ── THE ONE LINE THAT MAKES THIS GUARD REAL ─────────────────────────────────
// hasTouch: true. index.css gates the whole fingertip floor on `pointer: coarse`, so a run
// without it exercises the MOUSE layout at iPad width and passes while the actual device
// fails. That is not a hypothetical — it is what the desktop guard has always done.
import { chromium } from 'playwright-core';
import { STOP_LOOKUP_DOSSIER, STOP_LOOKUP_NOTFOUND } from './lib/stop-lookup-fixture.mjs';
import { CUSTOMER_VIEW, ORDER_DETAIL } from './lib/customer-view-fixture.mjs';
import { PLACE_VIEW } from './lib/place-search-fixture.mjs';
import { labelsAnswer } from './lib/labels-fixture.mjs';
import { CUSTOMER_YEAR } from './lib/customer-year-fixture.mjs';
import { CLAUDE_SHADOW_STATUS } from './lib/claude-shadow-fixture.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { MEASURE } from './lib/layout-measure.mjs';

const DIST = process.argv[2] || 'dist';
const PORT = Number(process.env.PORT || 4183);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

// The sizes Davis actually holds. Landscape is how a routing board gets used; portrait is
// where a wrapping toolbar puts a dropdown somewhere nobody designed for.
const TABLETS = [
  { name: 'iPad Pro 11 landscape', width: 1194, height: 834 },
  { name: 'iPad Air landscape', width: 1180, height: 820 },
  { name: 'iPad 10.2 landscape', width: 1080, height: 810 },
  { name: 'iPad portrait', width: 820, height: 1180 },
];

const SCREENS = [
  { key: 'map', label: 'Map', nav: /^map$/i },
  { key: 'routing', label: 'Routing (beta)', nav: /routing/i },
  { key: 'neworder', label: 'New Order', nav: /new order/i },
  { key: 'quote', label: 'Quote', nav: /quote/i },
  { key: 'manifest', label: 'Manifest check', nav: /manifest check/i, inMore: true },
  { key: 'comms', label: 'Customer emails', nav: /customer emails/i, inMore: true },
  { key: 'stoplookup', label: 'Stop lookup', nav: /stop lookup/i, inMore: true },
  { key: 'labels', label: 'Print labels', nav: /^print labels/i, inMore: true },
  { key: 'flaghistory', label: 'Flag history', nav: /flag history/i, inMore: true },
  { key: 'addrhistory', label: 'Address history', nav: /address history/i, inMore: true },
  { key: 'claudeshadow', label: 'Claude shadow', nav: /claude shadow/i, inMore: true },
  { key: 'diagnostics', label: 'Diagnostics', nav: /diagnostics/i, inMore: true },
];

// AT REST IS NOT ENOUGH, and the phone guard learned this the expensive way. Every defect
// Chad photographed needed a tap first: the Status menu is not in the DOM until it is opened.
const PROBES = {
  routing: [{ name: 'Status menu', open: async (page) => openByName(page, /^status/i) }],
  map: [{ name: 'Status menu', open: async (page) => openByName(page, /^status/i) }],
  // The queue's sub-tabs at iPad width: a segmented bar on a 1024px tablet and a chip row on a
  // 768px one, with a six-input editor opening under whichever is showing. Nothing measured any
  // sub-view of this screen before — PROBES listed only routing and map.
  // A lookup's whole answer is behind one submit, so at rest this guard would measure a search
  // box and nothing else. Same reasoning as the phone guard's probe of this screen.
  stoplookup: [
    { name: 'a customer looked up', open: async (page) => {
      const box = page.getByLabel(/find a customer by name/i).first();
      if (!(await box.isVisible().catch(() => false))) return false;
      await box.fill('earthly alternative');
      return openByName(page, /^look up$/i);
    } },
    { name: 'an order opened', open: async (page) => {
      const box = page.getByLabel(/find a customer by name/i).first();
      if (!(await box.isVisible().catch(() => false))) return false;
      await box.fill('earthly alternative');
      if (!(await openByName(page, /^look up$/i))) return false;
      await page.waitForTimeout(500);
      if (!(await openByName(page, /^007180002$/))) return false;
      await page.waitForTimeout(500);
      // EVERY PROBE PROVES ITS STATE. A probe that only proves it clicked something measures
      // whatever happened to be on screen and calls it by the state's name.
      return page.getByText(/proof of delivery/i).first().isVisible().catch(() => false);
    } },
    { name: 'a customer year', open: async (page) => {
      await closeOrderDrawer(page);
      const box = page.getByLabel(/find a customer by name/i).first();
      if (!(await box.isVisible().catch(() => false))) return false;
      await box.fill('earthly alternative');
      if (!(await openByName(page, /^look up$/i))) return false;
      await page.waitForTimeout(500);
      if (!(await openByName(page, /^(all of )?20\d\d$/i))) return false;
      await page.waitForTimeout(500);
      return page.getByText(/month by month/i).first().isVisible().catch(() => false);
    } },
    { name: 'nothing on file, NuVizz offered', open: async (page) => {
      await closeOrderDrawer(page);
      const box = page.getByLabel(/find a customer by name/i).first();
      if (!(await box.isVisible().catch(() => false))) return false;
      await box.fill('000000000');
      if (!(await openByName(page, /^look up$/i))) return false;
      await page.waitForTimeout(500);
      return page.getByRole('button', { name: /ask nuvizz for this order/i }).first().isVisible().catch(() => false);
    } },
    { name: 'a stop looked up', open: async (page) => {
      await closeOrderDrawer(page);
      const box = page.getByLabel(/find a customer by name/i).first();
      if (!(await box.isVisible().catch(() => false))) return false;
      await box.fill('007174397');
      if (!(await openByName(page, /^look up$/i))) return false;
      await page.waitForTimeout(500);
      return page.getByText(/every time this address moved/i).first().isVisible().catch(() => false);
    } },
    // THE CUSTOMER EDITOR OPEN (v1.53.0). The tallest single form in the app after the Map's
    // stop card: seven receiving-hour rows of two time inputs each, a flag block, a contacts
    // list and a Save/Cancel bar — dropped INLINE under a card that already has two docks
    // listed above it. Nothing of it exists until Edit is pressed, and the button it is
    // pressed from only exists because the fixture carries two docks. Last in the list so no
    // later probe inherits an open form and measures a thousand extra pixels.
    { name: 'editing a customer dock', open: async (page) => {
      await closeOrderDrawer(page);
      const box = page.getByLabel(/find a customer by name/i).first();
      if (!(await box.isVisible().catch(() => false))) return false;
      await box.fill('earthly alternative');
      if (!(await openByName(page, /^look up$/i))) return false;
      await page.waitForTimeout(500);
      if (!(await openByName(page, /^edit$/i))) return false;
      await page.waitForTimeout(500);
      // PROVES ITS STATE, like every probe here: the panel names the dock it is editing.
      return page.getByText(/editing this dock/i).first().isVisible().catch(() => false);
    } },
    // ADDRESS / CITY SEARCH (v1.62.0) — its own form beside the order box since v1.63.0, so no
    // tab to pick first. Four fields, three date settings and the whole place answer.
    { name: 'an address searched', open: async (page) => {
      await closeOrderDrawer(page);
      const street = page.getByLabel(/street address/i).first();
      if (!(await street.isVisible().catch(() => false))) return false;
      await street.fill('1100 Northside Dr');
      await page.getByLabel(/^city$/i).first().fill('Atlanta');
      if (!(await openByName(page, /^find stops$/i))) return false;
      await page.waitForTimeout(500);
      return page.getByText(/every stop at/i).first().isVisible().catch(() => false);
    } },
    { name: 'an address searched over a range', open: async (page) => {
      if (!(await openByName(page, /^range$/i))) return false;
      await page.waitForTimeout(500);
      const dates = await page.getByLabel(/first day to search/i).first().isVisible().catch(() => false);
      return dates && page.getByText(/every stop at/i).first().isVisible().catch(() => false);
    } },
    // RECENT LOOKUPS (v1.63.0). Every probe above left a search behind; clearing the address
    // form takes the answer away and puts the landing back, with the list on it.
    { name: 'recent lookups listed', open: async (page) => {
      await closeOrderDrawer(page);
      if (!(await openByName(page, /^clear$/i))) return false;
      await page.waitForTimeout(400);
      return page.getByRole('button', { name: /1100 northside dr/i }).first().isVisible().catch(() => false);
    } },
  ],
  // PRINT LABELS (v1.67.0): the order cards two across at iPad width, ticked, and the big-batch
  // question — none of which exists until a shipper is picked. No reload between probes here, so
  // each picks its own shipper rather than trusting the last one's.
  labels: [
    { name: 'a shipper picked', open: async (page) => {
      if (!(await openByName(page, /^estes/i))) return false;
      await page.waitForTimeout(500);
      return page.getByRole('button', { name: /^print labels for estes-/i }).first().isVisible().catch(() => false);
    } },
    { name: 'orders ticked', open: async (page) => {
      if (!(await openByName(page, /^estes/i))) return false;
      await page.waitForTimeout(500);
      const boxes = page.getByRole('checkbox', { name: /^select estes-/i });
      if ((await boxes.count()) < 2) return false;
      await boxes.nth(0).check();
      await boxes.nth(1).check();
      await page.waitForTimeout(300);
      return page.getByRole('button', { name: /^print selected \(2/i }).first().isVisible().catch(() => false);
    } },
    { name: 'a big batch asks first', open: async (page) => {
      if (!(await openByName(page, /^uline/i))) return false;
      await page.waitForTimeout(500);
      if (!(await openByName(page, /^print all/i))) return false;
      await page.waitForTimeout(300);
      return page.getByText(/this prints \d+ pages/i).first().isVisible().catch(() => false);
    } },
  ],
  addrhistory: [
    { name: 'Problem queue — row editor open', open: async (page) => {
      const tab = page.getByRole('tab', { name: /problem addresses/i }).first();
      if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(300); }
      return openByName(page, /^correct$/i);
    } },
    // "NuVizz changed it" is a TAB (role=tab), not a button — the phone guard has always opened
    // it as one. This probe asked for a button by that name, got nothing, and was silently
    // skipped on every tablet from the day it was written; the loud-failure rule above is what
    // finally said so. Opened the way the phone opens it, and PROVEN open before measuring.
    // The Uline review renders the DESKTOP branch here: a 320px list beside the building, two
    // picture panes side by side, and the answer buttons — the layout most likely to crowd at
    // tablet width. Proven open (tab selected, answer on screen) before it is measured.
    { name: 'Uline straight truck tab', open: async (page) => {
      const tab = page.getByRole('tab', { name: /uline straight truck/i }).first();
      if (!(await tab.isVisible().catch(() => false))) return false;
      await tab.click().catch(() => {});
      await page.waitForTimeout(400);
      return page.getByRole('button', { name: /no tractor trailer/i }).first().isVisible().catch(() => false);
    } },
    { name: 'Carrier-changed section', open: async (page) => {
      const tab = page.getByRole('tab', { name: /nuvizz changed it/i }).first();
      if (!(await tab.isVisible().catch(() => false))) return false;
      await tab.click().catch(() => {});
      await page.waitForTimeout(400);
      return page.getByRole('tab', { name: /nuvizz changed it/i, selected: true }).first().isVisible().catch(() => false);
    } },
    // Full screen inside the browser: the bar carries the name, the answers, Close and the
    // building-type chips — the row most likely to crowd at tablet width. Proven open first.
    // LAST in this list on purpose: it leaves a full-screen view over the page, and the states
    // of one screen run WITHOUT a reload between them — any probe after it would be clicking
    // through the dialog.
    { name: 'Uline — full screen in the browser', open: async (page) => {
      const tab = page.getByRole('tab', { name: /uline straight truck/i }).first();
      if (!(await tab.isVisible().catch(() => false))) return false;
      await tab.click().catch(() => {});
      await page.waitForTimeout(400);
      const full = page.getByRole('button', { name: /^full screen$/i }).first();
      if (!(await full.isVisible().catch(() => false))) return false;
      await full.click().catch(() => {});
      await page.waitForTimeout(400);
      return page.getByRole('dialog').first().isVisible().catch(() => false);
    } },
  ],
};

async function openByName(page, re) {
  const btn = page.getByRole('button', { name: re }).first();
  if (!(await btn.isVisible().catch(() => false))) return false;
  await btn.click().catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

/**
 * THE OPEN ORDER SURVIVES RE-READS BY DESIGN — StopLookupScreen keeps it open under its row so
 * a rep asking about three orders does not lose the customer. Every Stop lookup probe that
 * runs AFTER "an order opened" therefore inherits one, and while it was a right-hand DRAWER it
 * covered the search bar on a landscape iPad: the click aimed at "Look up" was swallowed by
 * Playwright's actionability check, openByName still returned true, the follow-up check found
 * nothing, and the state was SKIPPED — which is how "nothing on file, NuVizz offered" went
 * unmeasured on all four tablets in the v1.49.0 pass while the run reported green.
 *
 * Since v1.52.0 the panel is INLINE and covers nothing, so it can no longer swallow a click.
 * It is still closed between probes, for a different and still-good reason: an expanded panel
 * left open under the previous probe's row is a thousand extra pixels in every later
 * measurement, and a guard should measure the state it names and not the one before it.
 */
async function closeOrderDrawer(page) {
  const close = page.getByRole('button', { name: /^close order detail$/i }).first();
  if (!(await close.isVisible().catch(() => false))) return;
  await close.click().catch(() => {});
  await page.waitForTimeout(300);
}

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try {
      const b = await readFile(c);
      res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' });
      return res.end(b);
    } catch { /* fall through to the SPA shell */ }
  }
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(PORT, r));

async function gotoScreen(page, screen) {
  // The tablet uses the DESKTOP nav — a top bar, with the tail of it behind "More".
  // The "More" group is opened the way the desktop guard opens it — by innerText rather than
  // an accessible name. The chevron and the count in that button make getByRole('button',
  // {name:/^more$/}) miss it, which silently skipped four screens on the first run of this
  // guard and reported them as "not reachable" instead of failing.
  if (screen.inMore) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^more/i.test((x.innerText || '').trim()));
      if (b) b.click();
    });
    await page.waitForTimeout(400);
  }
  const target = page.getByRole('menuitem', { name: screen.nav }).first();
  const btn = page.getByRole('button', { name: screen.nav }).first();
  const use = (await target.isVisible().catch(() => false)) ? target : btn;
  if (!(await use.isVisible().catch(() => false))) return false;
  await use.click();
  await page.waitForTimeout(900);
  return true;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
let failures = 0;
let checked = 0;

console.log('\nTablet layout guard — the desktop layout, on a device with fingers\n');
for (const dev of TABLETS) {
  console.log(`\x1b[1m${dev.name} (${dev.width}×${dev.height})\x1b[0m`);
  const ctx = await browser.newContext({
    viewport: { width: dev.width, height: dev.height },
    // THE LOAD-BEARING FLAG. Without it `pointer: coarse` never matches and this guard
    // measures a layout no iPad ever renders. See the header.
    hasTouch: true,
    isMobile: false,
    deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/604.1',
  });
  const page = await ctx.newPage();
  // STUBS WITH ROWS IN THEM, because an empty screen is not the screen that ships.
  //
  // The first version returned empty arrays for everything, and the guard duly reported a
  // 526px empty white panel on Customer emails as dead space at all three landscape sizes.
  // It was right about the pixels and wrong about the defect: with no log rows, an empty
  // list IS the correct render. Measuring a state production never reaches produces
  // findings nobody can act on, and teaches whoever reads the output to discount it.
  await page.route('**/.netlify/functions/**', (route) => {
    const u = route.request().url();
    const J = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // THE PROBLEM-ADDRESS QUEUE — seeded with the worst rows, per the rule above. One of each
    // signal; a 44-character business name; a street that wraps twice at 360px; a row already
    // waved off; a row with NO stopId (excluded from select-all, so its explanatory line
    // renders); and a delivered row (also excluded, different line). The checkbox column, the
    // per-row buttons and the group-push bar are where a collision would live.
    // NOTE the name: anything containing 'address-history' is swallowed by the stub above.
    // STOP LOOKUP — the same fixture the phone guard drives, so a screen measured against
    // hostile data on one device is not measured against tidy data on the other.
    // STOP LOOKUP serves TWO modes off one URL and the stub picks the same way the
    // endpoint does — by whether a name or a stop was asked for. Stubbing only one of
    // them would leave the guard measuring a screen the app never renders.
    // THE CLAUDE SHADOW TAB — the same worst-rows fixture the phone and desktop guards use.
    if (u.includes('claude-shadow')) return J(CLAUDE_SHADOW_STATUS);
    // PRINT LABELS (v1.67.0) — the same built fixture the phone guard drives.
    if (u.includes('labels-by-shipper')) return J(labelsAnswer(u));
    if (u.includes('stop-lookup')) return J(
      // THREE modes off one URL, and the stub picks the same way the endpoint does. Stubbing
      // only some of them leaves the guard measuring a screen the app never renders.
      u.includes('detail=') ? ORDER_DETAIL : u.includes('year=') ? CUSTOMER_YEAR : u.includes('name=') ? CUSTOMER_VIEW
        // THE ADDRESS / CITY ANSWER (v1.62.0), keyed on the params only that mode sends.
        : /[?&](addr|city|zip)=/.test(u) ? PLACE_VIEW
        // THE MISS, keyed on the one number the probe asks for (same rule as the phone guard).
        : u.includes('stop=000000000') ? STOP_LOOKUP_NOTFOUND : STOP_LOOKUP_DOSSIER);
    // THE ULINE STRAIGHT-TRUCK REVIEW, at its worst case for layout: a 44-character name over
    // a wrapping street, a long Uline quote and a second one, a tractor-history chip beside a
    // no-tractor building type, three stops across three board days; a row with NO pin (both
    // picture panes swap for a note); and one of each decided kind in the collapsed list.
    if (u.includes('uline-advisory')) return J({
      ok: true, tenant: 'davis', nuvizzCalls: 0, notesLoaded: 412,
      dates: ['2026-09-24', '2026-09-25', '2026-09-28'],
      summary: { undecided: 2, confirmed: 1, box_only: 1, tractor: 1, locations: 5, stops: 7 },
      // The whole backlog, so the desktop summary's widest line is on screen when measured.
      backlog: { flagged: 38, undecided: 31 },
      rows: [
        { key: 'titan|3190|norcross', businessName: 'TITAN ELECTRIC COMPANIES QTS DATA CENTER', decision: 'undecided', baseDecision: 'undecided',
          address: { addr1: '3190 REPS MILLER RD BUILDING 400 SUITE 200', addr2: 'DOCK 7 REAR', city: 'PEACHTREE CORNERS', state: 'GA', zip: '30092' },
          pin: { lat: 33.9701, lng: -84.2208, source: 'feed' }, firstDate: '2026-09-24', buildingType: 'school',
          uline: ['STRAIGHT TRUCK ONLY - NO 53FT TRAILERS - LIMITED ACCESS AT REAR DOCK, CALL AHEAD 30 MIN', 'NO TRACTOR TRAILERS'],
          tractor: { count: 3, last: '2026-08-17' },
          stops: [
            { date: '2026-09-24', stopNbr: '007176403', pro: '007176403', routeName: 'NOR 2', planned: true },
            { date: '2026-09-25', stopNbr: '007176415', pro: '007176415', routeName: null, planned: false },
            { date: '2026-09-28', stopNbr: '007176594', pro: '007176594', routeName: 'NOR 11', planned: true },
          ] },
        { key: 'kickr|440|atlanta', businessName: 'KICKR DESIGN', decision: 'undecided', baseDecision: 'undecided',
          address: { addr1: '440 INTERSTATE NORTH PKWY SE', addr2: 'STE 100', city: 'ATLANTA', state: 'GA', zip: '30339' },
          pin: null, firstDate: '2026-09-25', buildingType: null, uline: [], tractor: null,
          stops: [{ date: '2026-09-25', stopNbr: '007176396', pro: '007176396', routeName: null, planned: false }] },
        { key: 'conley|4080|conley', businessName: 'CONLEY ARCH WOOD PROTECTION', decision: 'confirmed', baseDecision: 'confirmed',
          address: { addr1: '4080 BONSAL RD', addr2: 'CONLEY PLANT', city: 'CONLEY', state: 'GA', zip: '30288' },
          pin: { lat: 33.6604, lng: -84.3262, source: 'feed' }, firstDate: '2026-09-24', buildingType: null, uline: ['STRAIGHT TRUCK'], tractor: null,
          stops: [{ date: '2026-09-24', stopNbr: '007176063', pro: '007176063', routeName: 'SOU 4', planned: true }] },
        { key: 'fec|200|marietta', businessName: 'FEC BC2', decision: 'box_only', baseDecision: 'undecided',
          address: { addr1: '200 COBB PKWY N STE 212', addr2: 'BLDG 200', city: 'MARIETTA', state: 'GA', zip: '30062' },
          pin: { lat: 33.9546, lng: -84.5212, source: 'feed' }, firstDate: '2026-09-24', buildingType: null, uline: ['BOX TRUCK ONLY'], tractor: null,
          stops: [{ date: '2026-09-24', stopNbr: '007176117', pro: '007176117', routeName: 'MAR 3', planned: true }] },
        { key: 'heyden|3312|berkeley', businessName: 'HEYDEN SUPPLIES', decision: 'tractor', baseDecision: 'undecided',
          address: { addr1: '3312 N BERKELEY LAKE RD NW', addr2: 'STE D', city: 'BERKELEY LAKE', state: 'GA', zip: '30096' },
          pin: { lat: 33.984, lng: -84.1672, source: 'feed' }, firstDate: '2026-09-25', buildingType: null, uline: ['STRAIGHT TRUCK ONLY'], tractor: { count: 1, last: '2026-07-02' },
          stops: [{ date: '2026-09-25', stopNbr: '007176107', pro: '007176107', routeName: 'NOR 5', planned: true }] },
      ],
    });
    if (u.includes('address-queue')) return J({
      ok: true, tenant: 'davis', nuvizzCalls: 0, notesLoaded: 412,
      dates: ['2026-09-14', '2026-09-15', '2026-09-16'],
      summary: { mis_split: 2, no_pin: 2, corrected_not_pinned: 1, dismissed: 1 },
      days: [
        { date: '2026-09-14', stopsRead: 781, rows: [
          { signal: 'no_pin', rank: 0, date: '2026-09-14', key: 'no_pin__estes-0538243875', fp: 'v1|a', stopNbr: 'ESTES-0538243875', stopId: 'sid-1', pro: '007174397',
            matchKey: 'titan|3190|norcross', businessName: 'TITAN ELECTRIC COMPANIES QTS DATA CENTER', routeName: 'NOR 2', loadNbr: 'DAVIS000203707', status: 'SCHEDULED',
            shown: { addr1: '3190 REPS MILLER RD BUILDING 400 SUITE 200', addr2: 'DOCK 7 REAR', city: 'PEACHTREE CORNERS', state: 'GA', zip: '30092' },
            vendor: { addr1: '3190 REPS MILLER RD BUILDING 400 SUITE 200', addr2: 'DOCK 7 REAR', city: 'PEACHTREE CORNERS', state: 'GA', zip: '30092' },
            corrected: false, pinSource: null, suggestion: null },
          { signal: 'corrected_not_pinned', rank: 1, date: '2026-09-14', key: 'corrected_not_pinned__007174402', fp: 'v1|b', stopNbr: '007174402', stopId: 'sid-2', pro: '007174402',
            matchKey: 'acme|5965|norcross', businessName: 'ACME SUPPLY COMPANY OF NORTH GEORGIA', routeName: 'DUL 2', loadNbr: 'DAVIS000203723', status: 'SCHEDULED',
            shown: { addr1: '800 N COMMERCE ST', addr2: '', city: 'MONROE', state: 'GA', zip: '30655' },
            vendor: { addr1: '1 WRONG ST', addr2: '', city: 'BUFORD', state: 'GA', zip: '30518' },
            corrected: true, pinSource: 'feed', suggestion: null },
          { signal: 'mis_split', rank: 2, date: '2026-09-14', key: 'mis_split__avrt-0028093763', fp: 'v1|c', stopNbr: 'AVRT-0028093763', stopId: null, pro: 'AVRT-0028093763',
            matchKey: 'prop|2611|atlanta', businessName: 'PROPERTY MANAGER', routeName: '', loadNbr: '', status: 'UNPLANNED',
            shown: { addr1: 'BLDG 200', addr2: '4310 INDUSTRIAL ACCESS RD', city: 'ATLANTA', state: 'GA', zip: '30336' },
            vendor: { addr1: 'BLDG 200', addr2: '4310 INDUSTRIAL ACCESS RD', city: 'ATLANTA', state: 'GA', zip: '30336' },
            corrected: false, pinSource: 'feed', suggestion: { addr1: '4310 INDUSTRIAL ACCESS RD', addr2: 'BLDG 200', reason: 'street was in addr2 (swapped)' } },
          { signal: 'mis_split', rank: 2, date: '2026-09-14', key: 'mis_split__007174500', fp: 'v1|d', stopNbr: '007174500', stopId: 'sid-4', pro: '007174500',
            matchKey: 'led|5965|norcross', businessName: 'LED ENERGY PLUS', routeName: 'NOR 1', loadNbr: '', status: 'DELIVERED',
            shown: { addr1: 'STE B3', addr2: '5965 PEACHTREE CORNERS E', city: 'NORCROSS', state: 'GA', zip: '30071' },
            vendor: { addr1: 'STE B3', addr2: '5965 PEACHTREE CORNERS E', city: 'NORCROSS', state: 'GA', zip: '30071' },
            corrected: false, pinSource: 'feed', suggestion: { addr1: '5965 PEACHTREE CORNERS E', addr2: 'STE B3', reason: 'street was in addr2 (swapped)' } },
          { signal: 'no_pin', rank: 0, date: '2026-09-14', key: 'no_pin__007174600', fp: 'v1|e', stopNbr: '007174600', stopId: 'sid-5', pro: '007174600',
            matchKey: 'waved|1|x', businessName: 'WAVED OFF WAREHOUSE', routeName: 'DUL 1', loadNbr: '', status: 'SCHEDULED',
            shown: { addr1: '1 NOWHERE RD', addr2: '', city: 'BUFORD', state: 'GA', zip: '30518' },
            vendor: { addr1: '1 NOWHERE RD', addr2: '', city: 'BUFORD', state: 'GA', zip: '30518' },
            corrected: false, pinSource: null, suggestion: null,
            dismissed: true, dismissedBy: 'Dispatcher 9F2A', dismissedAt: '2026-09-14T08:02:00.000Z', dismissedWhy: null },
        ] },
        { date: '2026-09-15', stopsRead: 402, rows: [] },
        { date: '2026-09-16', stopsRead: 118, rows: [] },
      ],
    });
    if (u.includes('address-history')) return J({
      ok: true, nuvizzCalls: 0,
      range: { from: '2026-08-28', to: '2026-09-11', days: 15, clamped: null },
      summary: { moved: 1, renamed: 1, suite: 1, region: 0, filled: 0, cleared: 0, formatting: 1, total: 4 },
      matched: 4, truncated: false,
      days: [{ date: '2026-09-11', count: 2 }, { date: '2026-09-10', count: 2 }],
      rows: [
        { at: '2026-09-11T14:02:11.000Z', date: '2026-09-11', stopNbr: 'ESTES-0538243875', businessName: 'TITAN ELECTRIC COMPANIES QTS DATA CENTER', source: 'scan', kind: 'moved',
          before: { addr1: '3190 REPS MILLER RD STE 200', addr2: null, city: 'NORCROSS', state: 'GA', zip: '30071' },
          after: { addr1: '6725 JIMMY CARTER BLVD BLDG 400', addr2: 'DOCK 7', city: 'PEACHTREE CORNERS', state: 'GA', zip: '30092' },
          fields: ['addr1', 'addr2', 'city', 'zip'], route: 'NOR 2', planned: true, matchKey: null, actor: null },
        { at: '2026-09-10T11:13:18.479Z', date: '2026-09-10', stopNbr: '007174397', businessName: 'LED ENERGY PLUS', source: 'scan', kind: 'renamed',
          before: { addr1: '5965 PEACHTREE CORS E STE B3', addr2: null, city: 'NORCROSS', state: 'GA', zip: '30071' },
          after: { addr1: '5965 PEACHTREE STREET', addr2: null, city: 'NORCROSS', state: 'GA', zip: '30071' },
          fields: ['addr1'], route: 'NOR 2', planned: true, matchKey: null, actor: null },
        { at: '2026-09-10T09:41:02.000Z', date: '2026-09-10', stopNbr: '007174402', businessName: 'ACME SUPPLY COMPANY OF NORTH GEORGIA', source: 'override', kind: 'suite',
          before: { addr1: '4310 INDUSTRIAL ACCESS RD STE 200', addr2: null, city: 'DORAVILLE', state: 'GA', zip: '30360' },
          after: { addr1: '4310 INDUSTRIAL ACCESS RD STE 410', addr2: 'RECEIVING AROUND BACK', city: 'DORAVILLE', state: 'GA', zip: '30360' },
          fields: ['addr1', 'addr2'], route: null, planned: false, matchKey: 'acme__4310__doraville__30360', actor: 'Jessica' },
        { at: '2026-09-11T08:15:00.000Z', date: '2026-09-11', stopNbr: 'RA59223377', businessName: 'FEDEX OFFICE', source: 'override-reset', kind: 'formatting',
          before: { addr1: '1770 SATELLITE BLVD STE 4', addr2: null, city: 'BUFORD', state: 'GA', zip: '30518' },
          after: { addr1: '1770 SATELLITE BLVD', addr2: 'STE 4', city: 'BUFORD', state: 'GA', zip: '30518' },
          fields: ['addr1'], route: 'BUF 1', planned: true, matchKey: null, actor: 'Chad' },
      ],
    });
    if (u.includes('customer-comms-log')) return J({
      ok: true, today: '2026-09-05',
      range: { mode: 'days', from: '2026-09-04', to: '2026-09-05', days: 2, requestedDays: 2, clipped: false, maxDays: 92 },
      dates: ['2026-09-05', '2026-09-04'], unreadable: [], months: ['2026-09'],
      totals: { total: 2, sent: 2, failed: 0, inflight: 0 },
      byDay: [{ date: '2026-09-05', total: 2, sent: 2, failed: 0, inflight: 0 },
              { date: '2026-09-04', total: 0, sent: 0, failed: 0, inflight: 0 }],
      byMonth: [{ month: '2026-09', days: 2, total: 2, sent: 2, failed: 0, inflight: 0 }],
      status: {},
      entries: [
        { date: '2026-09-05', key: 'k1', at: '2026-09-05T13:50:00Z', customer: 'ACME SUPPLY COMPANY OF NORTH GEORGIA', to: 'receiving@example.com', subject: 'Delivered — PRO 007171743', pro: '007171743', ok: true, claimed: true },
        { date: '2026-09-05', key: 'k2', at: '2026-09-05T14:02:00Z', customer: 'BUFORD TILE & STONE', to: 'ap@example.com', subject: 'Delivered — PRO 007171744', pro: '007171744', ok: true, claimed: true },
      ],
      entriesShown: 2, entriesTotal: 2, entriesTruncated: false,
    });
    if (u.includes('coverage=1')) return J({ ok: true, pct: 100, withEmail: 599, sampled: 600, delivered: 710, bySource: { order: 599, notes: 0 }, optedOut: 0, withoutEmail: 1 });
    return J({ ok: true, stops: [], entries: [], items: [], days: [], count: 0, drivers: [], roster: [], reviews: [] });
  });
  page.on('dialog', (d) => d.accept());
  // SAY IT OUT LOUD. The useLayoutEffect crash was completely silent from the outside: the
  // app rendered nothing and every screen simply "was not there".
  page.on('pageerror', (e) => { console.log(`  \x1b[31m! page error:\x1b[0m ${String(e).slice(0, 200)}`); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

  for (const screen of SCREENS) {
    // AN UNREACHABLE SCREEN IS A FAILURE, NOT A SKIP.
    //
    // The first version printed "- not reachable" and moved on, which is how this guard
    // reported "✓ every screen works on a tablet (0 states checked)" while the app was
    // throwing on load — a missing useLayoutEffect import that `vite build` compiles
    // happily. A green tick over an empty measurement is worse than no guard: it is a guard
    // that lies in the flattering direction, which is the exact pattern this repo keeps
    // getting bitten by.
    if (!(await gotoScreen(page, screen))) {
      failures += 1;
      console.log(`  \x1b[31m✗\x1b[0m ${screen.label} — NOT REACHABLE (nav missing, or the app failed to render)`);
      continue;
    }
    const states = [{ name: '', open: null }, ...(PROBES[screen.key] || [])];
    for (const st of states) {
      // A PROBE THAT CANNOT OPEN ITS STATE IS A FAILURE, NOT A SKIP — the phone guard has said
      // so since it was written, and this one silently `continue`d. The difference is the
      // whole story of the v1.49.0 pass: four tablets, one state each never measured, and a
      // green tick over the gap. A guard is only as good as its reach.
      if (st.open) {
        let opened = false;
        try { opened = await st.open(page); } catch { opened = false; }
        if (!opened) {
          failures += 1;
          console.log(`  \x1b[31m✗\x1b[0m ${screen.label} → ${st.name} — the probe could not open it; this guard is only as good as its reach`);
          continue;
        }
      }
      const r = await page.evaluate(MEASURE);
      const problems = [];
      for (const [k, label] of [['offscreen', 'off-screen'], ['clipped', 'clipped'], ['overlap', 'overlapping'], ['small', 'under the 44px touch floor'], ['dead', 'unreachable']]) {
        const rows = r[k] || [];
        if (rows.length) problems.push({ label, rows });
      }
      checked += 1;
      const where = `${screen.label}${st.name ? ` → ${st.name}` : ''}`;
      if (!problems.length) { console.log(`  \x1b[32m✓\x1b[0m ${where}`); continue; }
      failures += 1;
      console.log(`  \x1b[31m✗\x1b[0m ${where}`);
      for (const p of problems) {
        console.log(`      \x1b[31m${p.rows.length} ${p.label}\x1b[0m`);
        for (const row of p.rows.slice(0, 6)) console.log(`        ${JSON.stringify(row)}`);
      }
    }
    // Back to a clean slate — a menu left open on one screen is not this screen's problem.
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  }
  await ctx.close();
}
await browser.close();
srv.close();

// AND A RUN THAT MEASURED NOTHING IS A FAILED RUN. Belt and braces on the same lesson: if
// every screen were skipped for some future reason, `failures` could still be 0.
const EXPECTED_MIN = TABLETS.length * SCREENS.length;
if (checked < EXPECTED_MIN) {
  console.log(`\n\x1b[31m✗ only ${checked} states measured; expected at least ${EXPECTED_MIN}.\x1b[0m`);
  console.log('  A guard that checks nothing and passes is not a guard.\n');
  process.exit(1);
}

if (failures) {
  console.log(`\n\x1b[31m✗ ${failures} of ${checked} tablet states have layout defects.\x1b[0m`);
  console.log('  Do not widen the thresholds to get green — an iPad really is that size and really does have fingers.\n');
  process.exit(1);
}
console.log(`\n\x1b[32m✓ every screen works on a tablet (${checked} states checked)\x1b[0m\n`);
