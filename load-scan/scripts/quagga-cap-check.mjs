#!/usr/bin/env node
// scripts/quagga-cap-check.mjs — the over-count regression proof, on the engine
// the dock actually runs.
//
// WHY THIS EXISTS SEPARATELY FROM camera-pairing-check.mjs
//
// That check drives BarcodeDetector, which can hand BOTH barcodes of one label
// to the pair buffer in a single frame. Quagga cannot, ever: it is deliberately
// multiple:false (scanner.js), so on an iPhone the two barcodes of one label
// always arrive on separate detections and the decoder can sit on ONE of them
// for seconds. Every guard in record() behaves differently under that stream —
// which is why the camera check was green while the dock photographed a 2-skid
// stop reading 4/2 and a 1-skid stop reading 2/1 on 2026-09-09.
//
// The two mechanisms proven behind those numbers, each an act below:
//
//   ACT 1  THE BLIND TAP. The "NOT COUNTED" warning was a full-screen opaque
//          panel with pointer-events:none, and the "Another piece" cap-bypass
//          sat directly underneath it. The RED flash beside it is a full-screen
//          button captioned TAP ANYWHERE TO CLEAR, so the trained reflex is to
//          tap — and the tap fell through onto the bypass, booking freight over
//          the manifest with no sound and no flash.
//   ACT 2  THE PHANTOM. The acquisition clock counted PRO decodes only. While
//          quagga sits on a label's piece id, that label's PRO goes unread, the
//          gap crosses PRO_REACQUIRE_MS, and a skid that never moved reads as a
//          NEW presentation — booking a piece that does not exist. A 2-skid stop
//          reached 2/2 COMPLETE off ONE skid, with the second still on the dock.
//
// Run from load-scan/:  npm run build && node scripts/quagga-cap-check.mjs
//   CHROMIUM_PATH  override the browser binary (as with npm run smoke)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve('dist');
const PORT = 8802;
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
const DATE = '2026-09-09';

// The stops off the dock photo, with their real counts.
const manifest = {
  date: DATE,
  loads: [{
    loadNbr: 'CAPTEST', routeName: 'CAPTEST', driverName: 'Driver',
    expectedPieces: 3, stopCount: 2,
    stops: [
      { stopNbr:'007173460', businessName:'ATLANTA AUTO & AC', pros:['7173460'], primaryPro:'7173460',
        expectedPieces:1, skids:1, loose:0, loadSeq:1, loadStopSeq:2, city:'ATLANTA', state:'GA', isPickup:false },
      { stopNbr:'007173250', businessName:'DIVINELY GUIDED EPRESS C', pros:['7173250'], primaryPro:'7173250',
        expectedPieces:2, skids:2, loose:0, loadSeq:2, loadStopSeq:1, city:'ATLANTA', state:'GA', isPickup:false },
    ],
  }],
};

// One code per detection, never two — the whole point of this file.
// [code, waitMsBeforeNext]
const SCRIPT = [
  // ACT 1 — ATLANTA AUTO, a ONE-skid stop. The label pairs and books, then the
  // loader keeps the label under the lens: the leftover PRO expires and the cap
  // refuses it, which raises the full-screen warning. A blind tap lands mid-screen
  // while that warning is up (see the tap driver below).
  ['7173460', 120], ['OG6028460001', 120],
  ['7173460', 700], ['7173460', 700], ['7173460', 700],
  [null, 3000],
  ['7173460', 700], ['7173460', 700],
  [null, 3000],

  // ACT 2 — DIVINELY GUIDED, a TWO-skid stop, but only ONE skid is ever
  // presented. Quagga locks onto that skid's piece id for well over
  // PRO_REACQUIRE_MS, which is what used to read as the label leaving and
  // returning. Nothing here may book a second piece.
  ['7173250', 120], ['OG6028250001', 120],
  ['OG6028250001', 300], ['OG6028250001', 300], ['OG6028250001', 300],
  ['OG6028250001', 300], ['OG6028250001', 300], ['OG6028250001', 300],
  ['7173250', 700], ['7173250', 700], ['7173250', 700],
  [null, 4000],
];

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),
  args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],
});
const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
await ctx.addInitScript((s) => localStorage.setItem('loadscan.session.v1', s), JSON.stringify(sessionObj));

// Fake Quagga: multiple:false, ONE code per detection event.
await ctx.addInitScript((script) => {
  try { delete window.BarcodeDetector; } catch { window.BarcodeDetector = undefined; }
  window.__q = { script: script.slice(), fired: [], drained: false };
  let handlers = [];
  let timer = null;
  window.Quagga = {
    init(cfg, cb) { setTimeout(() => cb(null), 0); },
    start() {
      let stopped = false;
      const step = () => {
        if (stopped) return;
        if (!window.__q.script.length) { window.__q.drained = true; return; }
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

let ok = true;
const fail = (m) => { ok = false; console.error('FAIL —', m); };

const camBtn = page.locator('text=Tap to scan');
if (!(await camBtn.count())) fail('no "Tap to scan" — did the load open?');
else await camBtn.first().click();

// THE BLIND TAP. A loader dismissing the warning taps the middle of the screen —
// the reflex the red flash trains. Tapped repeatedly through the whole run so it
// lands during warnings whenever they are raised. It must never book freight.
let taps = 0;
const tapper = setInterval(async () => {
  try { await page.mouse.click(195, 300); taps += 1; } catch {}
}, 900);

await page.waitForTimeout(26000);
clearInterval(tapper);

const queue = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('loadscan', 1);
  r.onsuccess = () => {
    const t = r.result.transaction('scanQueue', 'readonly');
    const g = t.objectStore('scanQueue').getAll();
    g.onsuccess = () => res(g.result.map((x) => ({ og: x.og, pro: x.pro, voided: !!x.voidedAt })));
    g.onerror = () => res([]);
  };
  r.onerror = () => res([]);
}));

const drained = await page.evaluate(() => ({ left: window.__q.script.length, fired: window.__q.fired.length }));
console.log(`   quagga: ${drained.fired} decodes, ${drained.left} unplayed · ${taps} blind taps`);
console.log('   queue rows:', JSON.stringify(queue));

const live = queue.filter((r) => !r.voided);
for (const s of manifest.loads[0].stops) {
  const n = live.filter((r) => String(r.pro) === s.pros[0]).length;
  if (n > s.expectedPieces) {
    fail(`${s.businessName} holds ${n} pieces on a ${s.expectedPieces}-piece stop — a scan went OVER the manifest`);
  }
}

// Act 1: exactly the one piece that was presented, carrying its real id.
const atl = live.filter((r) => String(r.pro) === '7173460');
if (atl.length !== 1) fail(`ATLANTA AUTO booked ${atl.length} pieces from one skid — must be exactly 1`);
if (atl[0] && atl[0].og !== 'OG6028460001') fail(`ATLANTA AUTO id is ${atl[0]?.og} — expected the real piece id`);

// Act 2: one skid presented, one piece booked. A phantom here is freight left on
// the dock while the worklist reports the stop complete.
const div = live.filter((r) => String(r.pro) === '7173250');
if (div.length !== 1) {
  fail(`DIVINELY GUIDED booked ${div.length} pieces from ONE skid — a phantom marks the stop done with freight still on the dock`);
}

const body = await page.locator('body').innerText();
if (/\b(\d+)\s*\/\s*\1\b/.test(body) && div.length !== 1) fail('a stop reads complete off a phantom');
if (errs.length) fail('uncaught errors: ' + errs.join(' | '));

await browser.close();
server.close();
console.log(ok
  ? '\n✓ PASS — on the quagga stream a blind tap books nothing over the manifest, and a label the decoder sits on books exactly once'
  : '\n✗ failed');
process.exit(ok ? 0 : 1);
