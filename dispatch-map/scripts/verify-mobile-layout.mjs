// scripts/verify-mobile-layout.mjs
//
// THE PHONE GUARD. Chad, v0.54.79: "This is not formatted correctly to mobile... I'm
// tired of sending your formatting issues."
//
// He is right that the reporting loop was backwards: every phone defect so far has been
// found by him, on his phone, after it shipped. Per-screen verifiers (verify-comms-tab,
// the layout sweep) each checked their own screen for their own regression, so a defect
// in a screen nobody was currently editing had nothing looking at it.
//
// This walks EVERY screen at phone widths and fails on the measurable defects — the ones
// that do not need an opinion:
//
//   1. HORIZONTAL OVERFLOW. documentElement.scrollWidth > innerWidth. This is the defect
//      in the 4:13am screenshot: the page slid sideways under a fixed header, so the
//      title read "randed delivery-complete email". A phone page must never scroll
//      sideways — and the guard names the widest offending element, so the fix is not a
//      hunt.
//   2. OFF-VIEWPORT ELEMENTS. Anything whose right edge is past the viewport, or whose
//      left edge is negative — content the operator cannot see or tap.
//   3. TOUCH TARGETS. Interactive elements under the app's own 40px floor (v0.54.70).
//   4. DEAD SPACE. A visible region taller than 60% of the viewport with nothing in it,
//      which is what a broken preview/iframe looks like from the outside.
//
// Scoped to the elements a person can actually see: hidden subtrees, zero-boxes and
// deliberately-scrollable containers (overflow-x: auto — a wide table INSIDE its own
// scroller is a design, not a defect) are excluded.
//
// Run: node scripts/verify-mobile-layout.mjs [dist]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = 8891;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

// Two real phones: the common modern size, and the smallest width still in the field.
// A layout that survives 360 survives the fleet.
const DEVICES = [
  { name: 'iPhone 14', width: 390, height: 844 },
  { name: 'small Android', width: 360, height: 740 },
];

// Every screen reachable from the phone navigation. Adding a screen means adding it here.
const SCREENS = [
  { key: 'map', label: 'Map', nav: null },
  { key: 'routing', label: 'Routing (beta)', nav: /routing/i },
  { key: 'neworder', label: 'New Order', nav: /new order/i },
  { key: 'quote', label: 'Quote', nav: /quote/i },
  { key: 'manifest', label: 'Manifest check', nav: /manifest check/i, inMore: true },
  { key: 'comms', label: 'Customer emails', nav: /customer emails/i, inMore: true },
  { key: 'diagnostics', label: 'Diagnostics', nav: /diagnostics/i },
];

// PROBES — the guard's biggest blind spot was that it only ever measured a screen at REST.
// Six sub-40px controls were sitting in the note composer, the customer-# editor and the
// notes editor, all of which only exist AFTER you open a sheet or a drawer — so the build
// stayed green while the operator mis-tapped a 30px "Send to NuVizz" at a dock. Each probe
// opens one of those surfaces and the screen is measured again inside it.
const PROBES = {
  map: [
    {
      name: 'Stops sheet',
      open: async (page) => {
        await page.getByRole('button', { name: /^stops$/i }).first().click();
        await page.waitForTimeout(600);
        return page.getByText(/CUSTOMER 0/i).first().isVisible().catch(() => false);
      },
    },
    {
      name: 'Filters sheet',
      open: async (page) => {
        await page.getByRole('button', { name: /^filters$/i }).first().click();
        await page.waitForTimeout(600);
        return page.getByText(/priority flag/i).first().isVisible().catch(() => false);
      },
    },
    {
      name: 'stop detail drawer',
      open: async (page) => {
        await page.getByRole('button', { name: /^stops$/i }).first().click();
        await page.waitForTimeout(500);
        // The first stop row in the list — the drawer is the only way to the notes editor.
        const row = page.locator('[data-stop-row], li, button').filter({ hasText: /CUSTOMER 0/i }).first();
        if (!(await row.isVisible().catch(() => false))) return false;
        await row.click();
        await page.waitForTimeout(800);
        // The drawer is proven open by a control only it renders.
        return page.getByRole('button', { name: /edit|customer #|notes/i }).first().isVisible().catch(() => false);
      },
    },
  ],
  comms: [
    {
      name: 'all sections open',
      open: async (page) => {
        // Each accordion row in turn; the last one left open is measured, but every control
        // inside each is rendered at least once for the clipped/overflow checks.
        for (const t of [/^program/i, /^sender/i, /^coverage/i, /send a test/i, /^template/i, /send log/i]) {
          const row = page.getByRole('button', { name: t }).first();
          if (await row.isVisible().catch(() => false)) { await row.click(); await page.waitForTimeout(300); }
        }
        // The accordion shows one section at a time, so assert on the LAST one opened.
        return page.getByText(/ACME SUPPLY/i).first().isVisible().catch(() => false);
      },
    },
  ],
};

// Every <details> on the page, opened — a disclosure is a control whose contents are
// invisible to a resting-state sweep by definition.
async function openAllDetails(page) {
  await page.evaluate(() => { document.querySelectorAll('details').forEach((d) => { d.open = true; }); });
  await page.waitForTimeout(250);
}

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); };

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

// Enough stub data that every screen renders its real layout — an empty screen cannot
// overflow, so stubbing thin would make this guard pass by rendering nothing.
const STOP = (i) => ({
  stopNbr: 1000 + i, pro: `0071617${40 + i}`, businessName: `CUSTOMER ${i} WITH A LONG BUSINESS NAME LLC`,
  addr1: `${900 + i} GAINESVILLE HIGHWAY SUITE ${i}`, city: 'BUFORD', state: 'GA', zip: '30518',
  driverName: 'FRANK OKINE', routeName: `ATL-${100 + i}`, normalizedStatus: i % 3 === 0 ? 'DELIVERED' : 'PLANNED',
  deliveredDTTM: i % 3 === 0 ? '2026-08-17T13:46' : null, cartons: 4, volume: 2, weight: 860,
  lat: 34.1 + i / 100, lng: -84.0 - i / 100, schedDate: '2026-08-17',
});
const STOPS = Array.from({ length: 24 }, (_, i) => STOP(i));

function stubRoutes(page, emailHtml) {
  return page.route('**/.netlify/functions/**', (route) => {
    const u = route.request().url();
    const R = (b, s) => route.fulfill(json(b, s));
    if (u.includes('customer-comms-config')) {
      return R({
        ok: true,
        config: { enabled: false, fromAddress: '', replyTo: 'customerservice@davisdelivery.com', subjectTemplate: 'Delivered — PRO {{pro}}', htmlTemplate: emailHtml, dailyCap: 25 },
        fields: ['pro', 'customer', 'driver', 'deliveredWhen', 'address', 'address2', 'cityStateZip', 'pieces', 'weight', 'trackingUrl', 'reviewUrl'],
        defaultHtml: emailHtml, resendConfigured: true, effectiveFrom: 'Davis Delivery <notifications@davisdelivery.com>',
      });
    }
    if (u.includes('customer-comms-log')) return R({ ok: true, totals: { total: 2, sent: 1, failed: 1, inflight: 0 }, entries: [{ date: '2026-08-17', key: 'k1', at: '2026-08-17T13:50:00Z', customer: 'ACME SUPPLY COMPANY OF NORTH GEORGIA', to: 'receiving@acmesupply.example.com', subject: 'Delivered — PRO 007161743', ok: true, claimed: true }] });
    if (u.includes('coverage=1')) return R({ ok: true, pct: 100, withEmail: 599, sampled: 600, delivered: 710, bySource: { order: 599, notes: 0 }, optedOut: 0, withoutEmail: 1 });
    if (u.includes('customer-comms-test')) return R({ ok: true, preview: true, pro: '007161743', customer: 'BUFORD TILE & STONE', subject: 'Delivered — PRO 007161743', html: emailHtml.replace(/\{\{[^}]+\}\}/g, 'X'), recipientOnFile: 'receiving@buford.example.com', recipientSource: 'order', optedOut: false });
    if (u.includes('nuvizz-pull-today-stops') || u.includes('nuvizz-board')) return R({ ok: true, stops: STOPS, count: STOPS.length, date: '2026-08-17' });
    if (u.includes('manifest-check')) return R({ ok: true, days: [], missing: [], summary: { missing: 0 } });
    if (u.includes('roster') || u.includes('drivers')) return R({ ok: true, drivers: [{ name: 'FRANK OKINE', id: '1' }], roster: [] });
    return R({ ok: true, stops: [], entries: [], items: [], count: 0 });
  });
}

// Measure inside the page: find what actually sticks out, not merely that something does.
const MEASURE = `(() => {
  const vw = window.innerWidth;
  const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const out = { vw, docW, wide: [], offscreen: [], small: [], dead: [], clipped: [] };

  const visible = (el, r) => {
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return true;
  };
  // A deliberate horizontal SCROLLER (auto/scroll) contains its content — the operator
  // can still reach it, so a wide table inside one is a design, not a defect.
  // overflow-x: hidden is NOT that: it CLIPS, and clipped content is unreachable. Counting
  // hidden as "contained" is what let the Map's top cluster ship with its Filters button
  // sliced in half — the guard passed the screen while the label read "Fil".
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  // Content sliced by an ancestor's clip. Reported separately from page overflow: nothing
  // scrolls sideways, the operator simply cannot see part of a control.
  const clippedBy = (el, r) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'hidden' && cs.overflowY !== 'hidden') continue;
      const pr = p.getBoundingClientRect();
      if (pr.width <= 0) continue;
      if (r.right > pr.right + 1 || r.left < pr.left - 1) return Math.round(Math.max(r.right - pr.right, pr.left - r.left));
    }
    return 0;
  };
  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 4).join('.') : '';
    const txt = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' “' + txt + '”' : '');
  };

  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    if (r.width > vw + 1 && !inScroller(el)) out.wide.push({ el: describe(el), w: Math.round(r.width) });
    if (!inScroller(el)) {
      const cut = clippedBy(el, r);
      // Only leaf-ish content: a clipped wrapper is usually just its clipped child again.
      if (cut > 4 && el.children.length === 0 && (el.textContent || '').trim().length > 0) {
        out.clipped.push({ el: describe(el), cut });
      }
    }
    if ((r.right > vw + 1 || r.left < -1) && !inScroller(el) && r.width < vw) {
      out.offscreen.push({ el: describe(el), left: Math.round(r.left), right: Math.round(r.right) });
    }
    const tag = el.tagName.toLowerCase();
    const tappable = tag === 'button' || tag === 'a' || tag === 'select' || tag === 'summary' || (tag === 'input' && !['hidden','checkbox','radio'].includes(el.type)) || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'menuitem';
    if (tappable && !el.disabled) {
      // Credit a deliberately-expanded hit area: the app's own idiom is an absolutely
      // positioned ::after with negative insets (after:-inset-y-3), which really does
      // make a 20px switch a 44px target. Measure what the finger hits, not the paint.
      let hh = r.height, hw = r.width;
      try {
        const a = getComputedStyle(el, '::after');
        if (a && a.content && a.content !== 'none' && a.position === 'absolute') {
          const t = parseFloat(a.top), b = parseFloat(a.bottom), l = parseFloat(a.left), rt = parseFloat(a.right);
          if (t < 0) hh += -t;
          if (b < 0) hh += -b;
          if (l < 0) hw += -l;
          if (rt < 0) hw += -rt;
        }
      } catch (_e) { /* no ::after */ }
      if (hh < 40 || hw < 24) out.small.push({ el: describe(el), h: Math.round(hh), w: Math.round(hw) });
    }
  }
  // Dead space: a big empty box with no rendered descendant content.
  for (const el of document.querySelectorAll('main div, section div, iframe')) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r) || r.height < window.innerHeight * 0.6) continue;
    if (el.tagName.toLowerCase() === 'iframe') continue;
    const hasInk = [...el.querySelectorAll('*')].some((c) => {
      const cr = c.getBoundingClientRect();
      return cr.width > 0 && cr.height > 0 && (c.textContent || '').trim().length > 0;
    });
    if (!hasInk && (el.textContent || '').trim().length === 0) out.dead.push({ el: describe(el), h: Math.round(r.height) });
  }
  // Dedup by description, keep the worst.
  const top = (arr, k) => Object.values(arr.reduce((m, x) => { const p = m[x.el]; if (!p || (x[k] || 0) > (p[k] || 0)) m[x.el] = x; return m; }, {})).slice(0, 6);
  out.wide = top(out.wide, 'w'); out.offscreen = top(out.offscreen, 'right');
  out.clipped = top(out.clipped, 'cut');
  out.small = Object.values(out.small.reduce((m,x)=>{m[x.el]=x;return m;},{})); out.dead = top(out.dead, 'h');
  return out;
})()`;

async function gotoScreen(page, screen) {
  // The phone nav is ONE menu behind the version chip (button[title="Version menu"]).
  if (screen.nav) {
    await page.locator('button[title="Version menu"]').first().click().catch(() => {});
    await page.waitForTimeout(250);
    const item = page.getByRole('menuitem', { name: screen.nav }).first();
    // The More group REMEMBERS whether it was left open, so a blind click on it toggles
    // the group shut half the time. Only open it when the target is not already showing.
    if (screen.inMore && !(await item.isVisible().catch(() => false))) {
      const more = page.getByRole('menuitem', { name: /^\s*more\s*$/i }).first();
      if (await more.isVisible().catch(() => false)) { await more.click(); await page.waitForTimeout(250); }
    }
    if (!(await item.isVisible().catch(() => false))) return false;
    await item.click();
    await page.waitForTimeout(900);
  }
  return true;
}

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' }); return res.end(b); } catch {}
  }
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(PORT, r));

const emailHtml = await readFile(join(DIST, '../netlify/functions/lib/customer-comms.mts'), 'utf8')
  .then((s) => (s.match(/export const DEFAULT_HTML = `([\s\S]*?)`;/) || [null, '<p>email</p>'])[1])
  .catch(() => '<p>email</p>');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });

console.log('\nMobile layout guard — every screen, every phone\n');
for (const device of DEVICES) {
  console.log(`\x1b[1m${device.name} (${device.width}×${device.height})\x1b[0m`);
  const ctx = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();
  await stubRoutes(page, emailHtml);
  page.on('dialog', (d) => d.accept());

  for (const screen of SCREENS) {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1100);
    const reached = await gotoScreen(page, screen);
    if (!reached) { bad(`${screen.label}: could not be reached from the phone nav`); continue; }
    // Let async loads settle, then measure the screen as it sits.
    await page.waitForTimeout(700);
    const m = await page.evaluate(MEASURE);

    const probs = [];
    if (m.docW > m.vw + 1) {
      probs.push(`page scrolls sideways (${m.docW}px wide in a ${m.vw}px viewport)`);
      for (const w of m.wide) probs.push(`   widest: ${w.w}px — ${w.el}`);
      for (const o of m.offscreen.slice(0, 3)) probs.push(`   off-screen: right edge ${o.right}px — ${o.el}`);
    }
    for (const cl of m.clipped) probs.push(`clipped ${cl.cut}px by an overflow-hidden ancestor — ${cl.el}`);
    for (const d of m.dead) probs.push(`dead region ${d.h}px tall with nothing in it — ${d.el}`);
    for (const s of m.small) probs.push(`touch target ${s.w}×${s.h}px — ${s.el}`);

    if (probs.length === 0) ok(`${screen.label}`);
    else { bad(`${screen.label}`); for (const p of probs) console.log(`      ${p}`); }

    // Then the same screen with its sheets, drawers and disclosures open.
    for (const probe of (PROBES[screen.key] || [])) {
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);
      if (!(await gotoScreen(page, screen))) continue;
      await page.waitForTimeout(500);
      let reached = false;
      try { reached = await probe.open(page); } catch { reached = false; }
      if (!reached) { bad(`${screen.label} → ${probe.name}: the probe could not open it — this guard is only as good as its reach`); continue; }
      await openAllDetails(page);
      const pm = await page.evaluate(MEASURE);
      const pp = [];
      if (pm.docW > pm.vw + 1) {
        pp.push(`page scrolls sideways (${pm.docW}px in ${pm.vw}px)`);
        for (const w of pm.wide) pp.push(`   widest: ${w.w}px — ${w.el}`);
      }
      for (const cl of pm.clipped) pp.push(`clipped ${cl.cut}px — ${cl.el}`);
      for (const sm of pm.small) pp.push(`touch target ${sm.w}×${sm.h}px — ${sm.el}`);
      if (pp.length === 0) ok(`${screen.label} → ${probe.name}`);
      else { bad(`${screen.label} → ${probe.name}`); for (const x of pp) console.log(`      ${x}`); }
    }
  }
  await ctx.close();
  console.log('');
}

await browser.close();
srv.close();

if (failures) { console.log(`\x1b[31m✗ ${failures} screen/phone combination(s) with layout defects\x1b[0m\n`); process.exit(1); }
console.log('\x1b[32m✓ every screen fits every phone\x1b[0m\n');
