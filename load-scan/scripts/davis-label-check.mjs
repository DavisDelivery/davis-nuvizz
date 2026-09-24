#!/usr/bin/env node
// davis-label-check.mjs — the DAVIS LABEL on the real bundle, on the quagga stream.
//
// The dispatch map prints one full page per piece with ONE Code 128 barcode,
// DD/<stop #>/<piece>. This drives the BUILT app through a fake Quagga (one code
// per detection, exactly like the iPhone engine) and reads the IndexedDB queue:
//
//   • a page held under the lens for many frames books ONE piece
//   • each page is its own piece; a second look at page 2 books nothing
//   • a 4th page on a 3-piece stop is refused (the cap holds for Davis labels too)
//   • a Uline stop whose PRO equals the Davis number's last 7 digits gets nothing
//   • a Davis label for an order not on this load books nothing
//   • with rules.davisLabels=false (LOADSCAN_DAVIS_LABELS=off) nothing books at all
//
// Run: npm run build && npm run e2e:davis   (CHROMIUM_PATH to use a local browser)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve('dist');
const PORT = 8803;
const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.ico':'image/x-icon' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url||'/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200,{'content-type':TYPES[extname(c)]||'application/octet-stream'}); return res.end(b); } catch {}
  }
  res.writeHead(404).end('x');
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));


const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now()/1000) + 100000;
const token = `${b64({alg:'HS256',typ:'JWT'})}.${b64({sub:'7012',role:'driver',name:'Driver',exp})}.sig`;
const sessionObj = { token, driverNumber:'7012', displayName:'Driver', role:'driver', mustChangePin:false };

const manifestFor = (davisLabels) => ({
  date: '2026-09-25',
  rules: { carrierHandConfirm: true, davisLabels },
  loads: [{
    loadNbr: 'DAVISLBL', routeName: 'DAVISLBL', driverName: 'Driver', expectedPieces: 4, stopCount: 2,
    stops: [
      // The order the SERVER sends: groupIntoLoads sorts by delivery sequence, so the Uline
      // twin (loadStopSeq 1) comes FIRST. Listing the Davis stop first would let a PRO-keyed
      // lookup land on it by luck and hide the very mix-up this check exists to catch.
      { stopNbr:'008000001', businessName:'ULINE TWIN', pros:['8000001'], primaryPro:'8000001',
        expectedPieces:1, skids:1, loose:0, loadSeq:2, loadStopSeq:1, city:'BUFORD', state:'GA', isPickup:false },
      { stopNbr:'ESTES-0288000001', businessName:'PEACHTREE FLOORING SUPPLY', pros:['8000001'], primaryPro:'8000001',
        expectedPieces:3, skids:2, loose:1, loadSeq:1, loadStopSeq:2, city:'LAWRENCEVILLE', state:'GA', isPickup:false, scannable:false },
    ],
  }],
});

const MAIN = [
  // page 1, the lens sits on it for ~2s
  ['DD/ESTES-0288000001/1', 120], ['DD/ESTES-0288000001/1', 120], ['DD/ESTES-0288000001/1', 300],
  ['DD/ESTES-0288000001/1', 300], ['DD/ESTES-0288000001/1', 300], ['DD/ESTES-0288000001/1', 900],
  [null, 1200],
  // page 2, then page 2 again after the window — the same piece, books nothing
  ['DD/ESTES-0288000001/2', 900], [null, 3200], ['DD/ESTES-0288000001/2', 900], [null, 1500],
  // page 3 — the stop is now complete
  ['DD/ESTES-0288000001/3', 900], [null, 1500],
  // a 4th page on a 3-piece stop — refused by the cap
  ['DD/ESTES-0288000001/4', 900], [null, 3000],
  // a Davis label for an order that is not on this load — red, books nothing
  ['DD/ESTES-0299999999/1', 900], [null, 1500],
];

// TWO PAGES OF ONE ORDER SIDE BY SIDE on the iPhone engine: Quagga decodes one symbol per
// frame, so the two pages ALTERNATE for as long as both are in view. Each must book once —
// never re-book every cycle, never starve the other.
const SIDE_BY_SIDE = [];
for (let k = 0; k < 14; k++) SIDE_BY_SIDE.push([k % 2 ? 'DD/ESTES-0288000001/2' : 'DD/ESTES-0288000001/1', 150]);
SIDE_BY_SIDE.push([null, 3000]);

// A LONE ULINE PIECE ID RIGHT AFTER A DAVIS PAGE: a Davis label never opens an order, so a
// stray Uline OG must not book onto the Davis stop.
const LONE_OG = [
  ['DD/ESTES-0288000001/1', 120], ['DD/ESTES-0288000001/1', 900], [null, 1200],
  ['OG6028000001', 900], [null, 4000],
];

async function run(davisLabels, SCRIPT = MAIN) {
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),
    args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],
  });
  const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  await ctx.addInitScript((s) => localStorage.setItem('loadscan.session.v1', s), JSON.stringify(sessionObj));
  await ctx.addInitScript((script) => {
    try { delete window.BarcodeDetector; } catch { window.BarcodeDetector = undefined; }
    window.__q = { script: script.slice(), fired: [] };
    let handlers = [];
    let timer = null;
    window.Quagga = {
      init(cfg, cb) { setTimeout(() => cb(null), 0); },
      start() {
        let stopped = false;
        const step = () => {
          if (stopped || !window.__q.script.length) return;
          const [code, wait] = window.__q.script.shift();
          if (code) {
            window.__q.fired.push(code);
            const result = { codeResult: { code, decodedCodes: [{ error: 0.04 }, { error: 0.05 }] } };
            for (const h of handlers) { try { h(result); } catch {} }
          }
          timer = setTimeout(step, wait);
        };
        timer = setTimeout(step, 55);
        window.__q.__stop = () => { stopped = true; };
      },
      onDetected(h) { handlers.push(h); },
      offDetected(h) { handlers = handlers.filter((x) => x !== h); },
      stop() { if (window.__q.__stop) window.__q.__stop(); if (timer) clearTimeout(timer); timer = null; },
    };
  }, SCRIPT);
  const manifest = manifestFor(davisLabels);
  await ctx.route('**/.netlify/functions/**', (route) => {
    const u = route.request().url();
    if (u.includes('load-manifest')) return route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(manifest) });
    if (u.includes('scan-session')) return route.fulfill({ status:200, contentType:'application/json', body:'{"ok":true,"added":0,"duplicates":0}' });
    return route.fulfill({ status:200, contentType:'application/json', body:'{"assignments":[],"loads":[],"rows":[]}' });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil:'load' });
  await page.waitForTimeout(2000);
  const camBtn = page.locator('text=Tap to scan');
  const opened = !!(await camBtn.count());
  if (opened) await camBtn.first().click();
  await page.waitForTimeout(17000);
  const queue = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('loadscan', 1);
    r.onsuccess = () => {
      const g = r.result.transaction('scanQueue', 'readonly').objectStore('scanQueue').getAll();
      g.onsuccess = () => res(g.result.map((x) => ({ og: x.og, pro: x.pro, stopNbr: x.stopNbr, voided: !!x.voidedAt })));
      g.onerror = () => res([]);
    };
    r.onerror = () => res([]);
  }));
  const body = await page.locator('body').innerText();
  const fired = await page.evaluate(() => window.__q.fired.length);
  await browser.close();
  return { opened, queue: queue.filter((r) => !r.voided), errs, body, fired };
}

let ok = true;
const fail = (m) => { ok = false; console.error('FAIL —', m); };

const on = await run(true);
console.log(`   ON : ${on.fired} decodes · queue ${JSON.stringify(on.queue)}`);
if (!on.opened) fail('no "Tap to scan" — did the load open?');
const ids = on.queue.map((r) => r.og).sort();
const want = ['DD-ESTES-0288000001-1', 'DD-ESTES-0288000001-2', 'DD-ESTES-0288000001-3'];
if (JSON.stringify(ids) !== JSON.stringify(want)) fail(`booked ${JSON.stringify(ids)} — expected exactly ${JSON.stringify(want)}`);
if (on.queue.some((r) => r.stopNbr !== 'ESTES-0288000001')) fail('a Davis piece was recorded against a stop other than its own');
if (on.queue.some((r) => /0299999999/.test(r.og))) fail('a label for an order NOT on this load booked a piece');
if (!/3\s*\/\s*3/.test(on.body)) fail(`PEACHTREE should read 3/3, body has: ${on.body.match(/\d+\s*\/\s*\d+/g)}`);
// The twin must read exactly 0/1: not 1/1 (complete off Estes freight) and not 3/1.
const fr = (on.body.match(/\d+\s*\/\s*\d+/g) || []).map((x) => x.replace(/\s/g, ''));
if (!fr.includes('0/1') || fr.includes('1/1') || fr.includes('3/1')) fail(`the Uline twin must read 0/1 — fractions on screen: ${JSON.stringify(fr)}`);
if (on.errs.length) fail('uncaught errors: ' + on.errs.join(' | '));

const side = await run(true, SIDE_BY_SIDE);
console.log(`   SIDE-BY-SIDE: ${side.fired} decodes · queue ${JSON.stringify(side.queue)}`);
const sideIds = side.queue.map((r) => r.og).sort();
if (JSON.stringify(sideIds) !== JSON.stringify(['DD-ESTES-0288000001-1', 'DD-ESTES-0288000001-2'])) fail(`two pages side by side booked ${JSON.stringify(sideIds)} — expected each page exactly once`);
if (side.errs.length) fail('uncaught errors (side by side): ' + side.errs.join(' | '));

const lone = await run(true, LONE_OG);
console.log(`   LONE OG: ${lone.fired} decodes · queue ${JSON.stringify(lone.queue)}`);
// No order is open after a Davis page, so a lone piece id books NOWHERE. (With the order left
// open it books on whichever stop shares the key — the Uline twin here, the Davis stop when
// that one is listed first — and both are wrong.)
if (lone.queue.some((r) => /^OG/.test(r.og))) fail(`a stray Uline piece id booked (${JSON.stringify(lone.queue.filter((r) => /^OG/.test(r.og)))}) — a Davis label must never open an order`);
if (!lone.queue.some((r) => r.og === 'DD-ESTES-0288000001-1')) fail('the Davis page itself did not book in the lone-OG run');
if (lone.errs.length) fail('uncaught errors (lone OG): ' + lone.errs.join(' | '));

const off = await run(false);
console.log(`   OFF: ${off.fired} decodes · queue ${JSON.stringify(off.queue)}`);
if (off.queue.length) fail(`with LOADSCAN_DAVIS_LABELS=off a Davis label still booked ${off.queue.length} piece(s)`);
if (off.errs.length) fail('uncaught errors (switch off): ' + off.errs.join(' | '));

server.close();
console.log(ok
  ? '\n✓ PASS — one Davis page is one piece on its own stop, the cap holds, two pages side by side each book once, a foreign label and a stray Uline OG book nothing, and the switch turns it all off'
  : '\n✗ failed');
process.exit(ok ? 0 : 1);
