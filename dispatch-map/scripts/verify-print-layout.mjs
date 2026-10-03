#!/usr/bin/env node
// scripts/verify-print-layout.mjs — DOES THE PICKER IN DIAGNOSTICS CHANGE WHAT COMES OUT OF THE PRINTER?
//
// Chad, 2026-10-03: "i want to move to production but i want a way to roll back to old one if
// needed in diagnostics screen somewhere i want to be able to pick which version i'm running."
//
// The unit tests prove the rules: which value means which layout, what the endpoint stores and
// reads back, that both layouts print the same facts. They cannot prove the WIRING — that the
// section can be reached on a phone, that the button reaches the endpoint, that the endpoint's
// answer reaches the builders a Compare card prints through, or that a device nobody touched
// follows. A switch whose position does not reach the paper is not a switch, so this drives the
// real bundle and reads the tickets out of the print bridge — the markup window.print() prints.
//
//   A. THE PICKER (desktop, or the phone with MOBILE=1). Open Diagnostics → Manifest layout, read
//      the banner, print a Compare card's manifest; go back to the old layout and print again;
//      come forward and print again. Then a save that fails, a read that fails, and a Preview
//      of the layout that is NOT in use — none of which may change what prints.
//   B. A DEVICE NOBODY TOUCHED (desktop run only). Another device switches the company back; this
//      one has the app open and does nothing. After the refresh interval it prints the old layout.
//   C. THE PAPER (desktop run only), at the real page width in print media. The Preview's sample
//      route is 4 stops on 4 sheets in both layouts and every new ticket is shorter than its old
//      one. Then THE AWKWARD LOAD — a sixty-character consignee, two long address lines, a long
//      city, a carrier's number for a PRO, a BOL longer than its row, a phone field holding an
//      extension and a name on a stop with no street address, an origin three lines long, a
//      route and a driver whose names have nowhere to break — printed from a Compare card: one
//      delivery a sheet, nothing printed over anything else, nothing off the page, no caption cut
//      in two, no column squeezed to a letter a line, and nothing inside the staple corner. Short
//      tidy text cannot test any of that; this load is the one that would run into it. And the
//      same driver under a one-line route name, where the cover's own row sits highest.
//
// The endpoint is stood in by a document held in this script (the real one is unit-tested in
// test/print-layout-endpoint.test.mjs). No request leaves the page and nothing calls NuVizz.
//
//   node scripts/verify-print-layout.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8831)   MOBILE=1  the phone layout
//     SHOT=dir       also write screenshots of the panel into dir
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8831;
const MOBILE = process.env.MOBILE === '1';
const SHOT = process.env.SHOT || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
// A HARD CEILING ON THE WHOLE RUN (the verify-loads-tab lesson): a guard that hangs blocks the
// merge and says nothing, which is worse than one that fails. Locally the desktop run is ~90s.
const GUARD_MS = Number(process.env.PRINT_LAYOUT_TIMEOUT_MS) || 4 * 60 * 1000;
const watchdog = setTimeout(() => {
  console.error(`\n✗ verify-print-layout exceeded ${Math.round(GUARD_MS / 1000)}s — failing rather than hanging the build`);
  process.exit(1);
}, GUARD_MS);
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };
const check = (cond, yes, no) => (cond ? ok(yes) : bad(no));

// ONE LOAD, FIVE STOPS — the same board verify-card-manifest.mjs prints from.
const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DEG = 1 / 69.055;
const NAMES = ['MANIFEST CO A', 'MANIFEST CO B', 'MANIFEST CO C', 'MANIFEST CO D', 'MANIFEST CO E'];
const STOPS = NAMES.map((businessName, i) => ({
  stopNbr: `0071900${i}0`, pro: `71900${i}0`, businessName, bol: `14822${i}731`,
  addr1: `${200 + i} Print Rd`, city: 'BUFORD', state: 'GA', zip: '30518', contact: { phone: `77055501${40 + i}` },
  lat: DEPOT.lat + (8 + i * 6) * DEG, lng: DEPOT.lng + (i % 2 ? 0.02 : -0.02),
  cartons: 1, volume: 0, weight: 300, pallets: 1,
  status: '10', normalizedStatus: 'PLANNED', stopType: 'DL',
  loadNbr: 'DAVIS000199001', routeName: 'MANIFEST 1', loadId: 'ld-manifest-1', routeSeq: i + 1,
  driverName: 'TEST DRIVER', driverUserName: 'tdriver', matchKey: `manifest_${i}`,
  plannedEtaDTTM: `2026-09-30T${String(8 + i).padStart(2, '0')}:10:00`,
  allComments: [{ text: 'SPL-INSTR-TEXT: NO APPT REQUIRED', addedBy: 'INTG ULINE', addedOn: '2026-09-28T16:50:22' }],
}));

// THE AWKWARD LOAD — a bad day's data. The same five stops, each carrying something long.
const LONG = {
  businessName: 'WWWWW MMMMM INDUSTRIAL WAREHOUSING & DISTRIBUTION CENTER OF GEORGIA',
  addr1: '12500 PEACHTREE INDUSTRIAL BOULEVARD NORTHWEST BUILDING 400 SUITE 1200',
  addr2: 'ATTN RECEIVING DEPARTMENT - REAR DOCK DOORS 14 THROUGH 22 ONLY',
  city: 'LAWRENCEVILLE-SUWANEE UNINCORPORATED GWINNETT COUNTY',
  bol: 'BOL-3319-448120-AA-77120045',
  // seventy characters: wider than the whole city · BOL · phone row
  bolRow: 'BOL-3319-448120-AA-77120045-XY-99887766-ZZ-11223344-QQ-55667788-RR-990',
  phone: '770-555-0142 x 2231 ask for receiving',
  // where the freight was picked up — the cover's Origin line, here three lines of it, the
  // shipper's name one unbroken run wider than the line
  from: { name: 'NORTHGEORGIAMECHANICALCONTRACTORSANDSUPPLYDISTRIBUTIONCENTEROFGAINESVILLEANDDAWSONVILLEINCORPORATEDWAREHOUSENUMBERFOUR', addr1: '12500 PEACHTREE INDUSTRIAL BOULEVARD NORTHWEST BUILDING 400 SUITE 1200',
    addr2: 'ATTN SHIPPING DEPARTMENT - REAR DOCK DOORS 14 THROUGH 22 ONLY', city: 'LAWRENCEVILLE-SUWANEE UNINCORPORATED GWINNETT COUNTY', state: 'GA', zip: '30043' },
};
// The cover's own LINE-FILLERS (see the two on stop 5): a route name and a driver name with no
// place to break, each wider than its row. They are cut at the last character that fits, which
// is the furthest toward the staple corner anything on the cover can print. (No digit in the
// route's: a long unbroken token WITH one is an id to this app and never shown as a route's name
// — isHashLikeId, lib/route-identity.js.)
const AWKWARD_ROUTE = 'GAINESVILLE_DAWSONVILLE_DAHLONEGA_TWO';
const AWKWARD = STOPS.map((s, i) => ({
  ...s, routeName: AWKWARD_ROUTE, loadNbr: 'DAVIS000199002', loadId: 'ld-awkward-1', driverName: 'CHRISTOPHER_MONTGOMERY_WASHINGTON_FITZGERALD_ABERNATHY_VANDERBILT_III',
  raw: { stop: { from: { address: LONG.from } } },
  ...[
    {},                                                                                   // an ordinary stop, for comparison
    // words in the phone field — on a stop with NO street address, where the city · BOL · phone
    // row has no address line above it to hold it down
    { addr1: '', contact: { phone: LONG.phone } },
    { bol: LONG.bolRow, contact: { phone: '7705550142 / 6785550199' } },                   // a BOL longer than its row, beside two numbers
    // everything at once — and a PRO of 20 characters, the longest NuVizz's stop number can be (STOP_NBR_MAX)
    { ...LONG, stopNbr: 'ESTES-0538243875-123', pro: 'ESTES-0538243875-123', contact: { phone: LONG.phone } },
    // THE LINE-FILLERS: a name and an address with no space to break at. Such a line is cut at
    // the last character that fits, so it reaches the very limit of its row — which is how far
    // any wrapped line can reach. If a row's limit moved toward the corner, this is what shows it.
    { businessName: 'NORTHGEORGIAMECHANICALCONTRACTORSANDSUPPLYOFGAINESVILLEANDDAWSONVILLEINCORPORATED',
      addr1: '12500PEACHTREEINDUSTRIALBOULEVARDNORTHWESTBUILDING400SUITE1200REARDOCKDOORS14THROUGH22ONLY', addr2: LONG.addr2 },
  ][i],
}));

// THE SAME DRIVER UNDER A ONE-LINE ROUTE NAME. The cover's own row — driver · stops · requested —
// sits highest when the route's name takes one line, which is every ordinary route and not the
// load above (its name takes three). This is the cover that row could reach the corner on.
const AWKWARD_SHORT_ROUTE = 'DAWSONVILLE 2';
const AWKWARD_SHORT = AWKWARD.slice(0, 2).map((s) => ({ ...s, routeName: AWKWARD_SHORT_ROUTE, loadNbr: 'DAVIS000199003', loadId: 'ld-awkward-2' }));

try { if (!(await stat(DIST)).isDirectory()) throw new Error('nd'); }
catch { console.error(`no build at ${DIST} — run \`npm run build\` first`); process.exit(1); }
if (SHOT) await mkdir(SHOT, { recursive: true });

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' }); return res.end(b); } catch { /* next */ }
  }
  res.writeHead(404).end('nf');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// THE COMPANY'S SETTING, standing in for nuvizz_ops/print_layout behind the endpoint. One object
// for the whole run, shared by every "device" below — which is the point of the feature.
const company = { doc: null, failGet: false, failPost: false, gets: 0, posts: [] };
const layoutOf = (doc) => (['classic', 'old'].includes(String(doc?.layout ?? '').trim().toLowerCase()) ? 'classic' : 'new');
const answer = () => ({ ok: true, layout: layoutOf(company.doc), stored: company.doc?.layout ?? null, persistent: true, set_at: company.doc?.set_at ?? null, set_by: company.doc?.set_by ?? null });

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const errors = [];

/** A device: its own browser context (its own storage), with every function answered from here. */
async function device(contextOptions, board = STOPS) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/.netlify/functions/**', (route) => {
    const req = route.request(); const u = req.url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.includes('/print-layout')) {
      if (req.method() === 'GET') {
        company.gets += 1;
        return company.failGet ? json({ ok: false, error: 'getDoc nuvizz_ops/print_layout failed: 503' }, 500) : json(answer());
      }
      company.posts.push(req.postData());
      if (company.failPost) return json({ ok: false, error: 'updateDocFields nuvizz_ops/print_layout failed: 503' }, 500);
      let want = null;
      try { want = JSON.parse(req.postData() || '{}').layout; } catch { /* refused below */ }
      if (want !== 'new' && want !== 'classic') return json({ ok: false, error: 'send { "layout": "new" } or { "layout": "classic" }' }, 400);
      company.doc = { layout: want, set_at: '2026-10-03T18:14:00.000Z', set_by: 'Chad' };
      return json(answer());
    }
    if (u.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: board, count: board.length, source: 'fixture' });
    if (u.includes('route-departures')) return json({ ok: true, published: false, usedByBoard: false, table: null });
    if (u.includes('travel-model')) return json({ ok: true, legs: {}, legCount: 0, googleEnabled: false });
    return json({ ok: true, stops: [], rows: [], results: [], items: [], entries: [], count: 0 });
  });
  for (const host of ['googleapis.com', 'gstatic.com', 'google.com']) await page.route(`**://*.${host}/**`, (r) => r.abort());
  return { context, page };
}
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1600, height: 1000 } };

// ── getting around, the way each layout's own navigation does ────────────────
async function openManifestLayout(page, phone) {
  if (phone) {
    // The phone nav is ONE menu behind the version chip; Diagnostics sits under More.
    await page.locator('button[title="Version menu"]').first().click().catch(() => {});
    await page.waitForTimeout(300);
    const item = page.getByRole('menuitem', { name: /diagnostics/i }).first();
    if (!(await item.isVisible().catch(() => false))) {
      await page.getByRole('menuitem', { name: /^\s*more\s*$/i }).first().click().catch(() => {});
      await page.waitForTimeout(300);
    }
    await item.click().catch(() => {});
  } else {
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^more$/i.test((x.innerText || '').trim())); if (b) b.click(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^diagnostics/i.test((x.innerText || '').trim())); if (b) b.click(); });
  }
  await page.waitForTimeout(900);
  // The phone's chip row and the desktop's rail are both role=tab, drawn from one list.
  await page.getByRole('tab', { name: /manifest layout/i }).first().click().catch(() => {});
  await page.waitForTimeout(700);
  return page.getByText('Printed manifest and delivery ticket').first().isVisible().catch(() => false);
}
const banner = (page) => page.locator('[role="status"]').first().innerText().catch(() => '');
const kept = (page) => page.evaluate(() => { try { return localStorage.getItem('print.layout'); } catch { return 'unreadable'; } });

async function openCard(page, phone, load = /MANIFEST 1/) {
  if (phone) {
    await page.locator('[data-phone-menu-trigger], header button').first().click().catch(() => {});
    await page.waitForTimeout(900);
  }
  await page.getByText('Routing (beta)', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1600);
  const printBtn = page.getByRole('button', { name: /Print manifest/i }).first();
  if (await printBtn.isVisible().catch(() => false)) return true;      // the card is still open from the last print
  if (phone) {
    // The board status card sits over the Loads tab at 390px; collapse it the way a router would.
    await page.getByRole('button', { name: /stops$/i }).first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
  const loadsTab = page.getByRole('button', { name: /^Loads/ }).first();
  if (await loadsTab.isVisible().catch(() => false)) { await loadsTab.click().catch(() => {}); await page.waitForTimeout(1000); }
  await page.getByText(load).first().click().catch(() => {});
  await page.waitForTimeout(1600);
  return printBtn.isVisible().catch(() => false);
}
/** Press Print manifest on the open card and read the tickets the print bridge holds. */
async function printCard(page, phone, { load, read = readPaper } = {}) {
  if (!(await openCard(page, phone, load))) return null;
  await page.getByRole('button', { name: /Print manifest/i }).first().click().catch(() => {});
  await page.waitForTimeout(1200);
  const paper = await read(page);            // read while the viewer — and so the print bridge — is up
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  return paper;
}
// A ticket's layout, read off the markup only that layout has. The stop-number box is the new
// one's; the underlined signature boxes are the old one's.
const readPaper = (page) => page.evaluate(() => {
  const bridge = document.querySelector('.printdoc-bridge');
  if (!bridge) return null;
  return {
    route: (bridge.querySelector('.mf-route')?.textContent || '').trim(),
    tickets: [...bridge.querySelectorAll('section.tkt')].map((t) => (t.querySelector('.badge') ? 'new' : t.querySelector('.sigbox') ? 'old' : '?')),
    label: /SPL-INSTR-TEXT/.test(bridge.textContent || ''),
  };
});
const prints = (paper, want, n) => !!paper && paper.tickets.length === n && paper.tickets.every((x) => x === want);
const say = (paper) => (paper ? `${paper.tickets.length} ticket(s): ${paper.tickets.join(' ') || 'none'}` : 'no print bridge — the viewer did not open');

// ══ A. THE PICKER ════════════════════════════════════════════════════════════
console.log(`\nA. The picker (${MOBILE ? 'phone' : 'desktop'})`);
const A = await device(MOBILE ? PHONE : DESKTOP);
await A.page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await A.page.waitForTimeout(1600);

check(await openManifestLayout(A.page, MOBILE), 'Diagnostics → Manifest layout opens from the navigation', 'Diagnostics → Manifest layout could not be opened');
let text = await banner(A.page);
check(/In use: the NEW layout/.test(text) && /default/.test(text), `nobody has chosen: "${text}"`, `the banner should say the new layout is the default — it says "${text}"`);
if (SHOT) await A.page.screenshot({ path: join(SHOT, `${MOBILE ? 'phone' : 'desktop'}-1-new.png`) });

let paper = await printCard(A.page, MOBILE);
check(prints(paper, 'new', 5), 'a Compare card prints the NEW layout, 5 tickets', `the card should print 5 new-layout tickets — ${say(paper)}`);
check(paper && !paper.label, 'and the repeated "SPL-INSTR-TEXT:" label is off the paper', 'the new layout still prints the "SPL-INSTR-TEXT:" label');

// GO BACK TO THE OLD LAYOUT, from the screen.
await openManifestLayout(A.page, MOBILE);
await A.page.getByRole('button', { name: /go back to the old layout/i }).first().click().catch(() => {});
await A.page.waitForTimeout(900);
text = await banner(A.page);
check(company.posts.length === 1 && company.posts[0] === '{"layout":"classic"}', 'the button asked the endpoint for the old layout', `the endpoint was sent ${JSON.stringify(company.posts)}`);
check(/In use: the OLD layout/.test(text) && /Chad/.test(text) && /Oct 3, 2026/.test(text), `the banner reads back: "${text}"`, `after switching back the banner says "${text}"`);
check((await kept(A.page)) === 'classic', 'this device changed at once', `this device kept "${await kept(A.page)}"`);
if (SHOT) await A.page.screenshot({ path: join(SHOT, `${MOBILE ? 'phone' : 'desktop'}-2-old.png`) });

paper = await printCard(A.page, MOBILE);
check(prints(paper, 'old', 5), 'the same card now prints the OLD layout, 5 tickets — the switch reaches the paper', `the card should print 5 old-layout tickets — ${say(paper)}`);
check(paper && paper.label && paper.route === 'MANIFEST 1', 'and it is the old paper: the label is back, the route is the same', `old paper read ${JSON.stringify(paper)}`);

// AND FORWARD AGAIN.
await openManifestLayout(A.page, MOBILE);
await A.page.getByRole('button', { name: /use the new layout/i }).first().click().catch(() => {});
await A.page.waitForTimeout(900);
text = await banner(A.page);
check(/In use: the NEW layout/.test(text) && company.posts[1] === '{"layout":"new"}', `forward again: "${text}"`, `after switching forward the banner says "${text}" (sent ${company.posts[1]})`);
paper = await printCard(A.page, MOBILE);
check(prints(paper, 'new', 5), 'and the card prints the NEW layout again', `the card should print 5 new-layout tickets — ${say(paper)}`);

// A SAVE THAT FAILS must not be shown as a switch, and must not change this device.
await openManifestLayout(A.page, MOBILE);
company.failPost = true;
await A.page.getByRole('button', { name: /go back to the old layout/i }).first().click().catch(() => {});
await A.page.waitForTimeout(1200);
company.failPost = false;
text = await banner(A.page);
const alert = await A.page.locator('[role="alert"]').first().innerText().catch(() => '');
check(/did not save/.test(alert) && /503/.test(alert), `a refused save says so: "${alert}"`, `a refused save should say it did not save — the screen says "${alert}"`);
check(/In use: the NEW layout/.test(text) && (await kept(A.page)) === 'new', 'and the banner and this device still say NEW — what is stored, not what was pressed', `after a refused save the banner says "${text}" and the device kept "${await kept(A.page)}"`);

// PREVIEW shows the layout that is NOT in use, and changes nothing.
const postsBefore = company.posts.length;
await A.page.locator('[data-print-layout="classic"]').getByRole('button', { name: /preview/i }).click().catch(() => {});
await A.page.waitForTimeout(1200);
paper = await readPaper(A.page);
check(prints(paper, 'old', 4) && paper.route === 'SAMPLE ROUTE', 'Preview shows the OLD layout on a made-up route', `the old layout's Preview read ${JSON.stringify(paper)}`);
if (SHOT) await A.page.screenshot({ path: join(SHOT, `${MOBILE ? 'phone' : 'desktop'}-3-preview-old.png`) });
await A.page.keyboard.press('Escape');
await A.page.waitForTimeout(500);
await A.page.locator('[data-print-layout="new"]').getByRole('button', { name: /preview/i }).click().catch(() => {});
await A.page.waitForTimeout(1200);
paper = await readPaper(A.page);
check(prints(paper, 'new', 4) && paper.route === 'SAMPLE ROUTE', 'and the NEW layout on the same route', `the new layout's Preview read ${JSON.stringify(paper)}`);
await A.page.keyboard.press('Escape');
await A.page.waitForTimeout(500);
check(company.posts.length === postsBefore && (await kept(A.page)) === 'new' && /In use: the NEW layout/.test(await banner(A.page)),
  'neither Preview changed the setting', 'a Preview changed the setting');

// A READ THAT FAILS says so, marks neither layout in use, and leaves the device on what it knew.
company.failGet = true;
await A.page.getByRole('tab', { name: /this device/i }).first().click().catch(() => {});
await A.page.waitForTimeout(500);
await A.page.getByRole('tab', { name: /manifest layout/i }).first().click().catch(() => {});
await A.page.waitForTimeout(900);
text = await banner(A.page);
const inUse = await A.page.getByText('In use', { exact: false }).count();
const switches = await A.page.getByRole('button', { name: /use the new layout|go back to the old layout/i }).evaluateAll((bs) => bs.map((b) => b.disabled));
check(/Could not read the setting/.test(text) && /503/.test(text) && /prints the new layout/.test(text), `a failed read says so: "${text}"`, `a failed read should say so — the banner says "${text}"`);
check(inUse === 0 && switches.length === 2 && switches.every(Boolean), 'no layout is marked in use and both switch buttons are off', `with the read failed: ${inUse} "In use" mark(s), buttons disabled ${JSON.stringify(switches)}`);
if (SHOT) await A.page.screenshot({ path: join(SHOT, `${MOBILE ? 'phone' : 'desktop'}-4-read-failed.png`) });
company.failGet = false;
await A.page.getByRole('button', { name: /try again/i }).first().click().catch(() => {});
await A.page.waitForTimeout(900);
check(/In use: the NEW layout/.test(await banner(A.page)), 'Try again reads it', `after Try again the banner says "${await banner(A.page)}"`);
await A.context.close();

if (!MOBILE) {
  // ══ B. A DEVICE NOBODY TOUCHED ══════════════════════════════════════════════
  console.log('\nB. A device nobody touched follows the switch');
  company.doc = null;
  const B = await device(DESKTOP);
  await B.page.clock.install();
  await B.page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await B.page.waitForTimeout(1600);
  paper = await printCard(B.page, false);
  check(prints(paper, 'new', 5) && (await kept(B.page)) === 'new', 'the office PC has the app open and prints the NEW layout', `before the switch the office PC printed ${say(paper)}`);
  // Somebody else — a phone — sends the company back to the old layout.
  company.doc = { layout: 'classic', set_at: '2026-10-03T18:14:00.000Z', set_by: 'Chad' };
  const getsBefore = company.gets;
  await B.page.clock.fastForward('05:01');     // the refresh interval, and nothing else: no reload, no click
  await B.page.waitForTimeout(900);
  check(company.gets > getsBefore && (await kept(B.page)) === 'classic', 'five minutes on, without a reload or a click, it has asked and been told OLD', `after the interval: ${company.gets - getsBefore} read(s), the device kept "${await kept(B.page)}"`);
  paper = await printCard(B.page, false);
  check(prints(paper, 'old', 5), 'and its next manifest prints the OLD layout', `after the interval the office PC printed ${say(paper)}`);
  await B.context.close();

  // ══ C. THE PAPER ══════════════════════════════════════════════════════════
  console.log('\nC. The paper, at the real page width');
  // 7.7in — a letter sheet less the document's own 0.4in margins — so the bridge lays out exactly
  // as the printer's page does. (Under the phone breakpoint, hence the phone navigation.)
  const LIVE_W = Math.round(7.7 * 96);
  // 2in is the corner a staple and a flipped-back page take. The tolerance is for the glyph boxes,
  // which move a fraction of a pixel between font builds; the layout that keeps them out is fixed.
  const KEEP_OUT = 2 - 0.03;

  /** Measure the open print bridge in print media, and count the sheets Chromium would print. */
  const measurePaper = async (page) => {
    await page.emulateMedia({ media: 'print' });
    const m = await page.evaluate(() => {
      const bridge = document.querySelector('.printdoc-bridge');
      if (!bridge) return null;
      const B = bridge.getBoundingClientRect();
      const tickets = [...bridge.querySelectorAll('section.tkt')];
      const MARGIN = 0.4;
      const textRects = (root) => {
        const out = [];
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          if (!n.nodeValue.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(n);
          for (const r of range.getClientRects()) if (r.width && r.height) out.push({ r, what: n.nodeValue.trim().slice(0, 30) });
        }
        return out;
      };
      // THE STAPLE CORNER. Inches from the paper's right edge + inches from its top edge, for
      // everything that puts ink down: every run of text, every image, every bordered box.
      // Page 1 starts at the top of the bridge; every later ticket starts its own page.
      const corner = (pageTop, root) => {
        let best = { leg: 1e9, what: '' };
        const see = (r, what) => {
          const leg = MARGIN + (B.right - r.right) / 96 + MARGIN + (r.top - pageTop) / 96;
          if (leg < best.leg) best = { leg, what };
        };
        for (const { r, what } of textRects(root)) see(r, what);
        for (const el of [root, ...root.querySelectorAll('*')]) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none') continue;
          const r = el.getBoundingClientRect();
          const inked = el.tagName === 'IMG' || ['Top', 'Right', 'Bottom', 'Left'].some((x) => parseFloat(cs[`border${x}Width`]) > 0 && cs[`border${x}Style`] !== 'none');
          if (inked && r.width && r.height) see(r, `<${el.tagName.toLowerCase()} class="${el.className}">`);
        }
        return best;
      };
      // Page 1 is the cover and the first ticket: every top-level node up to the second ticket.
      const page1 = [];
      for (const n of bridge.querySelectorAll(':scope > div > *')) { if (n === tickets[1]) break; page1.push(n); }
      const first = page1.map((n) => corner(B.top, n)).sort((x, y) => x.leg - y.leg)[0];
      // ONE THING PRINTED OVER ANOTHER. Two rows hold texts side by side: the header (the title,
      // then the PRO) and the city · BOL · phone row. Each text's own boxes, against its neighbours'.
      const hit = (p, q) => Math.min(p.right, q.right) - Math.max(p.left, q.left) > 0.5 && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 0.5;
      const overlaps = [];
      tickets.forEach((t, i) => {
        const rows = [
          [...(t.querySelector('.city')?.children || [])],
          [t.querySelector('.brand .t'), t.querySelector('.brand .pro-w')].filter(Boolean),
        ];
        for (const row of rows) {
          const cells = row.map((c) => textRects(c));
          for (let x = 0; x < cells.length; x++) for (let y = x + 1; y < cells.length; y++) {
            for (const p of cells[x]) for (const q of cells[y]) if (hit(p.r, q.r)) overlaps.push(`page ${i + 1}: “${p.what}” over “${q.what}”`);
          }
        }
      });
      // OFF THE PAGE: any text past the bridge's own right edge.
      const off = textRects(bridge).filter(({ r }) => r.right > B.right + 0.5).map(({ what }) => what);
      // A CAPTION CUT IN TWO. Every caption is one or two short words and prints on one line. One
      // on more than one line was squeezed by the value beside it ("OR / IG / I / N").
      const linesOf = (el) => new Set(textRects(el).map(({ r }) => Math.round(r.top))).size;
      const cut = [...bridge.querySelectorAll('.cap, .k, .lbl, .type, .mf-title, .summary span, .items th')]
        .filter((el) => linesOf(el) > 1).map((el) => `“${el.textContent.trim()}” on ${linesOf(el)} lines`);
      // A COLUMN SQUEEZED TO NOTHING. The city and the phone each keep a real share of their row,
      // whatever the BOL between them holds. The tracks are read as the browser resolved them.
      const starved = [];
      tickets.forEach((t, i) => {
        const row = t.querySelector('.city');
        if (!row) return;
        const tracks = getComputedStyle(row).gridTemplateColumns.split(' ').map(parseFloat);
        const W = row.getBoundingClientRect().width;
        if (tracks.length !== 3 || !(tracks[0] >= 0.2 * W) || !(tracks[2] >= 0.2 * W)) starved.push(`page ${i + 1}: city ${Math.round(tracks[0])}px · BOL ${Math.round(tracks[1])}px · phone ${Math.round(tracks[2])}px of ${Math.round(W)}px`);
      });
      const originEl = bridge.querySelector('.mf-origin .k + div');
      // THE LOGO'S SPACE. On every page after the first the ticket's own logo sits right above the
      // stop-number box; the clear paper between them, in px (page 1's logo is in the cover).
      const logoGap = tickets.slice(1).map((t) => {
        const img = t.querySelector('.brand img'); const box = t.querySelector('.badge');
        return img && box ? +(box.getBoundingClientRect().top - img.getBoundingClientRect().bottom).toFixed(1) : null;
      });
      return {
        width: B.width,
        route: (bridge.querySelector('.mf-route')?.textContent || '').trim(),
        tickets: tickets.length,
        heights: tickets.map((t) => +t.getBoundingClientRect().height.toFixed(1)),
        corners: [first, ...tickets.slice(1).map((t) => corner(t.getBoundingClientRect().top, t))].map((c) => ({ leg: +c.leg.toFixed(3), what: c.what })),
        overlaps: [...new Set(overlaps)],
        off: [...new Set(off)],
        cut: [...new Set(cut)],
        starved,
        logoGap,
        originLines: originEl ? linesOf(originEl) : 0,
        // the BOL number's own lines — its text, not the small "BOL" caption in front of it
        bolLines: tickets.map((t) => {
          const nbr = [...(t.querySelector('.city .bol')?.childNodes || [])].find((n) => n.nodeType === 3 && n.nodeValue.trim());
          if (!nbr) return 0;
          const range = document.createRange(); range.selectNodeContents(nbr);
          return new Set([...range.getClientRects()].filter((r) => r.width && r.height).map((r) => Math.round(r.top))).size;
        }),
      };
    });
    if (m) {
      const pdf = (await page.pdf({ preferCSSPageSize: true, printBackground: false })).toString('latin1');
      m.sheets = (pdf.match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
    }
    await page.emulateMedia({ media: 'screen' });
    return m;
  };
  const legs = (m) => m.corners.map((c) => `${c.leg.toFixed(2)}in`).join(', ');

  // C1 — THE PREVIEW'S SAMPLE ROUTE, both layouts.
  company.doc = null;
  const C = await device({ viewport: { width: LIVE_W, height: 979 } });
  await C.page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await C.page.waitForTimeout(1600);
  await openManifestLayout(C.page, true);
  const sample = {};
  for (const layout of ['new', 'classic']) {
    await C.page.locator(`[data-print-layout="${layout}"]`).getByRole('button', { name: /preview/i }).click().catch(() => {});
    await C.page.waitForTimeout(1200);
    sample[layout] = await measurePaper(C.page);
    await C.page.keyboard.press('Escape');
    await C.page.waitForTimeout(500);
  }
  await C.context.close();
  if (!sample.new || !sample.classic) bad('the sample preview had no print bridge to measure');
  else {
    const N = sample.new; const O = sample.classic;
    check(N.width === LIVE_W && O.width === LIVE_W, `measured at the page's own width (${LIVE_W}px)`, `measured at ${N.width}px / ${O.width}px, not ${LIVE_W}px`);
    check(N.sheets === 4 && O.sheets === 4, 'the 4-stop sample prints on 4 sheets in both layouts: one delivery a sheet, page 1 the summary and the first ticket',
      `sheets: new ${N.sheets}, old ${O.sheets} — expected 4 and 4`);
    const taller = N.heights.map((h, i) => [i + 1, h, O.heights[i]]).filter(([, h, o]) => !(h < o));
    check(N.heights.length === 4 && !taller.length, `every new ticket is shorter than its old one (${N.heights.map((h, i) => `${h} < ${O.heights[i]}`).join(', ')}px)`,
      `new tickets not shorter than old: ${JSON.stringify(taller)}`);
    // "drop that box … a tiny bit to give the logo a little space": clear paper between the two.
    check(N.logoGap.length === 3 && N.logoGap.every((g) => g >= 8), `the stop-number box sits clear of the logo above it (${N.logoGap.join(', ')}px of paper between them)`,
      `the stop-number box is up against the logo: ${JSON.stringify(N.logoGap)}px between them, want 8 or more`);
    // An ordinary route too: a mid-length name is set in smaller type, and its row must not shrink with it.
    const insideSample = N.corners.map((c, i) => ({ page: i + 1, ...c })).filter((c) => c.leg < KEEP_OUT);
    check(!insideSample.length, `and nothing on its new pages is inside the 2in staple corner (${legs(N)})`, `the sample route prints inside the staple corner: ${JSON.stringify(insideSample)}`);
  }

  // C2 — THE AWKWARD LOAD, printed from a Compare card, new layout then old.
  const awkward = {};
  for (const layout of ['new', 'classic']) {
    company.doc = layout === 'classic' ? { layout: 'classic', set_at: '2026-10-03T18:14:00.000Z', set_by: 'Chad' } : null;
    const D = await device({ viewport: { width: LIVE_W, height: 979 } }, AWKWARD);
    await D.page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await D.page.waitForTimeout(1600);
    awkward[layout] = await printCard(D.page, true, { load: new RegExp(AWKWARD_ROUTE), read: measurePaper });
    await D.context.close();
  }
  const AN = awkward.new; const AO = awkward.classic;
  if (!AN || !AO) bad(`the awkward load did not print (new ${!!AN}, old ${!!AO})`);
  else {
    check(AN.tickets === 5 && AN.sheets === 5, 'the awkward load: 5 deliveries on 5 sheets, long text and all', `the awkward load printed ${AN.tickets} ticket(s) on ${AN.sheets} sheet(s)`);
    check(!AN.overlaps.length, 'nothing is printed over anything else: a long phone or BOL wraps in its own column, and a 20-character PRO clears the title',
      `text printed over text: ${AN.overlaps.slice(0, 4).join(' | ')}`);
    check(!AN.off.length, 'nothing runs off the right edge of the page', `text past the right edge: ${AN.off.slice(0, 4).join(' | ')}`);
    // The fixture has to have reached the paper, or the two checks under it prove nothing.
    check(AN.originLines >= 2 && Math.max(...AN.bolLines) >= 2, `the long origin printed on ${AN.originLines} lines and the long BOL on ${Math.max(...AN.bolLines)}`,
      `the awkward load did not reach the paper as built: origin on ${AN.originLines} line(s), BOL lines per page ${JSON.stringify(AN.bolLines)}`);
    check(!AN.cut.length, 'no caption is cut in two: “Origin” stays whole beside a long origin, and so does every other', `caption(s) cut: ${AN.cut.slice(0, 4).join(' | ')}`);
    check(!AN.starved.length, 'a BOL longer than its row wraps in the middle: the city and the phone keep their columns', `column(s) squeezed: ${AN.starved.slice(0, 3).join(' | ')}`);
    const inside = AN.corners.map((c, i) => ({ page: i + 1, ...c })).filter((c) => c.leg < KEEP_OUT);
    check(!inside.length, `nothing on a new page is inside the 2in staple corner (nearest ink, per page: ${legs(AN)})`, `ink inside the staple corner: ${JSON.stringify(inside)}`);
    // The old layout really does print there — so this measurement can tell the two apart.
    check(AO.tickets === 5 && AO.corners.some((c) => c.leg < KEEP_OUT), `(the old layout prints inside it, as measured: ${legs(AO)})`,
      'the old layout measured clear of the corner too — the measurement is not seeing what it should');
  }

  // C3 — THE COVER'S OWN ROW, under a one-line route name (new layout).
  company.doc = null;
  const E = await device({ viewport: { width: LIVE_W, height: 979 } }, AWKWARD_SHORT);
  await E.page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await E.page.waitForTimeout(1600);
  const SN = await printCard(E.page, true, { load: new RegExp(AWKWARD_SHORT_ROUTE), read: measurePaper });
  await E.context.close();
  if (!SN) bad('the one-line-route load did not print');
  else {
    const cover = SN.corners[0];
    check(SN.tickets === 2 && SN.route === AWKWARD_SHORT_ROUTE && cover.leg >= KEEP_OUT && !SN.off.length && !SN.cut.length,
      `under a one-line route name a driver's name with nowhere to break is cut inside the cover's row, clear of the corner (${cover.leg.toFixed(2)}in)`,
      `the cover under a one-line route name: ${SN.tickets} ticket(s), route “${SN.route}”, nearest ink ${cover.leg}in (“${cover.what}”), off the page: ${JSON.stringify(SN.off.slice(0, 3))}, cut: ${JSON.stringify(SN.cut.slice(0, 3))}`);
  }
}

if (errors.length) bad(`page errors: ${[...new Set(errors)].slice(0, 3).join(' | ')}`);
else ok('no page errors');

clearTimeout(watchdog);
await browser.close();
server.close();
// A keep-alive socket Chromium left open would make server.close() wait for ever; the explicit
// exit below ends the process either way, and this lets the port go at once.
server.closeAllConnections?.();
console.log(fails.length ? `\n✗ ${fails.length} check(s) failed` : `\n✓ The manifest layout picker verified in a real browser (${MOBILE ? 'phone' : 'desktop'})`);
process.exit(fails.length ? 1 : 0);
