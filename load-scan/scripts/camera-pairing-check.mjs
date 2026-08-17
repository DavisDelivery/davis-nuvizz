#!/usr/bin/env node
// scripts/camera-pairing-check.mjs — the phantom-piece regression proof.
//
// Drives the REAL built bundle with a scripted fake BarcodeDetector through the
// exact frame sequence that minted phantom pieces on the dock (Aug 12: DASAN
// USA read 3/3 off two scans; GEM SHOPPING credited 10 of 11): PRO frames
// first, the piece id landing on a later frame. The old resolver booked TWO
// pieces from that sequence (NOOG phantom + the real OG). This asserts exactly
// ONE books, with its real id — and that a label whose OG never decodes at all
// still books its NOOG fallback when the pair window closes, which is the WMS
// rule this app scans by. Act 3 is the late arrival: the OG that finally
// decodes seconds AFTER the fallback booked must UPGRADE that NOOG row (void
// it, book the real id), not double the piece.
//
// Run from load-scan/:  npm run build && node scripts/camera-pairing-check.mjs
//   CHROMIUM_PATH  override the browser binary (as with npm run smoke)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve('dist');
const PORT = 8799;
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
const token = `${b64({alg:'HS256',typ:'JWT'})}.${b64({sub:'7012',role:'driver',name:'Steven',exp})}.sig`;
const session = { token, driverNumber:'7012', displayName:'Steven Adjetey', role:'driver', mustChangePin:false };
const DATE = '2026-08-12';

const manifest = {
  date: DATE,
  loads: [{
    loadNbr: 'STEVEN', routeName: 'STEVEN', driverName: 'Steven Adjetey',
    expectedPieces: 5, stopCount: 3,
    stops: [
      { stopNbr:'007162525', businessName:'DASAN USA', pros:['7162525'], primaryPro:'7162525',
        expectedPieces:3, skids:3, loose:0, loadSeq:1, loadStopSeq:7, city:'DULUTH', state:'GA', isPickup:false },
      { stopNbr:'007159999', businessName:'TORN LABEL CO', pros:['7159999'], primaryPro:'7159999',
        expectedPieces:1, skids:1, loose:0, loadSeq:2, loadStopSeq:6, city:'NORCROSS', state:'GA', isPickup:false },
      { stopNbr:'007161111', businessName:'LATE LABEL LLC', pros:['7161111'], primaryPro:'7161111',
        expectedPieces:1, skids:1, loose:0, loadSeq:3, loadStopSeq:5, city:'ATLANTA', state:'GA', isPickup:false },
    ],
  }],
};

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),
  args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],
});
const ctx = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
await ctx.addInitScript((s) => localStorage.setItem('loadscan.session.v1', s), JSON.stringify(session));

// The scripted camera. Each detect() call pops the next frame; empty frames
// dominate, like a real viewfinder. Act 1 is DASAN: the PRO decodes on several
// consecutive frames (re-reads) BEFORE the piece id ever appears. Act 2 is a
// label whose OG never decodes at all.
await ctx.addInitScript(() => {
  const frames = [];
  const idle = (n) => { for (let i = 0; i < n; i++) frames.push([]); };
  idle(10);
  // Act 1 — DASAN: PRO first (re-read across frames), OG ~1s later.
  frames.push(['7162525'], ['7162525'], ['7162525']);
  idle(14);                             // ~1s of hunting before the OG lands
  frames.push(['OG6028653156']);
  idle(30);                             // aim ends
  // Act 2 — the torn label: PRO only, forever.
  frames.push(['7159999'], ['7159999'], ['7159999']);
  idle(60);                             // OG never decodes; the window must close on the clock
  // Act 3 — the LATE piece id. The window closes on a lone PRO (the NOOG
  // fallback books), and THEN the whole label finally decodes. The complete
  // pair is the same physical piece: it must upgrade the NOOG, not double it.
  frames.push(['7161111'], ['7161111'], ['7161111']);
  idle(60);                             // past the window — the fallback books here
  frames.push(['7161111', 'OG6028777777'], ['7161111', 'OG6028777777'], ['7161111', 'OG6028777777']);
  idle(40);                             // aim ends
  window.__scanScript = frames;
  window.BarcodeDetector = class {
    static async getSupportedFormats() { return ['code_128', 'code_39']; }
    async detect() {
      const f = window.__scanScript.length ? window.__scanScript.shift() : [];
      return f.map((rawValue) => ({ rawValue }));
    }
  };
});

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

// Open the camera; the scripted frames start draining (~16/s).
const camBtn = page.locator('text=Tap to scan');
if (!(await camBtn.count())) fail('no "Tap to scan" — did the load open?');
else await camBtn.first().click();

// Acts 1 and 2 plus the 2.5s expiry window, with slack.
await page.waitForTimeout(22000);

const queue = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('loadscan', 1);
  r.onsuccess = () => {
    const t = r.result.transaction('scanQueue', 'readonly');
    const g = t.objectStore('scanQueue').getAll();
    g.onsuccess = () => res(g.result.map((x) => ({ og: x.og, pro: x.pro, kind: x.kind || 'scan', voided: !!x.voidedAt })));
    g.onerror = () => res([]);
  };
  r.onerror = () => res([]);
}));
console.log('   queue rows:', JSON.stringify(queue));

const dasan = queue.filter((r) => r.pro === '7162525');
if (dasan.length !== 1) fail(`DASAN booked ${dasan.length} pieces from one aim — must be exactly 1`);
if (dasan[0] && dasan[0].og !== 'OG6028653156') fail(`DASAN piece has og=${dasan[0]?.og} — the REAL piece id, not a NOOG phantom`);
if (queue.some((r) => String(r.og).startsWith('NOOG-7162525'))) fail('the NOOG phantom is back');

const torn = queue.filter((r) => r.pro === '7159999');
if (torn.length !== 1) fail(`the torn label booked ${torn.length} pieces — the WMS rule books exactly 1`);
if (torn[0] && torn[0].og !== 'NOOG-7159999-1') fail(`torn label og=${torn[0]?.og} — expected the NOOG fallback`);

// Act 3: the piece id that arrived AFTER the fallback booked. The NOOG row must
// be a void tombstone (never deleted — the sync needs to carry the void up) and
// the real id must be the ONE live piece. Two live rows here is the dock's
// double-count, arriving late instead of early.
const late = queue.filter((r) => r.pro === '7161111');
const liveLate = late.filter((r) => !r.voided);
if (liveLate.length !== 1) fail(`LATE LABEL holds ${liveLate.length} live pieces from one aim — must be exactly 1`);
if (liveLate[0] && liveLate[0].og !== 'OG6028777777') fail(`LATE LABEL live og=${liveLate[0]?.og} — the real id must win`);
const lateNoog = late.find((r) => String(r.og).startsWith('NOOG-7161111'));
if (!lateNoog) fail('the NOOG fallback row is missing entirely — it must remain as a void tombstone');
else if (!lateNoog.voided) fail('the NOOG fallback is still LIVE next to the real id — the upgrade did not fire');

const body = await page.locator('body').innerText();
if (!/3\s*\/\s*5/.test(body)) fail(`header count should read 3/5, body has: ${body.match(/\d+\s*\/\s*\d+/g)}`);
if (errs.length) fail('uncaught errors: ' + errs.join(' | '));

await browser.close();
server.close();
console.log(ok
  ? '\n✓ PASS — one aim books ONE piece with its real id; a dead OG books via NOOG at the window; a LATE OG upgrades its NOOG instead of doubling it'
  : '\n✗ failed');
process.exit(ok ? 0 : 1);
