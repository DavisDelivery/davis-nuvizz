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
    expectedPieces: 10, stopCount: 4,
    stops: [
      { stopNbr:'007162525', businessName:'DASAN USA', pros:['7162525'], primaryPro:'7162525',
        expectedPieces:3, skids:3, loose:0, loadSeq:1, loadStopSeq:7, city:'DULUTH', state:'GA', isPickup:false },
      { stopNbr:'007159999', businessName:'TORN LABEL CO', pros:['7159999'], primaryPro:'7159999',
        expectedPieces:1, skids:1, loose:0, loadSeq:2, loadStopSeq:6, city:'NORCROSS', state:'GA', isPickup:false },
      { stopNbr:'007161111', businessName:'LATE LABEL LLC', pros:['7161111'], primaryPro:'7161111',
        expectedPieces:1, skids:1, loose:0, loadSeq:3, loadStopSeq:5, city:'ATLANTA', state:'GA', isPickup:false },
      // Expects FIVE deliberately, while the act presents only three skids. If
      // the count matched the act, the stop-full refusal would cap over-booking
      // at three and this act could not tell a correct run from a broken guard —
      // which is exactly what it failed to do when it was written that way.
      { stopNbr:'007163333', businessName:'THREE SKID CO', pros:['7163333'], primaryPro:'7163333',
        expectedPieces:5, skids:5, loose:0, loadSeq:4, loadStopSeq:4, city:'MARIETTA', state:'GA', isPickup:false },
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
  idle(15);                             // aim ends (~1.5s at the measured pace)
  // Act 2 — the torn label: PRO only, forever.
  frames.push(['7159999'], ['7159999'], ['7159999']);
  idle(30);                             // ~2.9s: OG never decodes, the window closes on the clock
  // Act 3 — the LATE piece id. The window closes on a lone PRO (the NOOG
  // fallback books), and THEN the whole label finally decodes. The complete
  // pair is the same physical piece: it must upgrade the NOOG, not double it.
  frames.push(['7161111'], ['7161111'], ['7161111']);
  idle(35);                             // ~3.4s: past the 2.5s window, so the fallback books here
  frames.push(['7161111', 'OG6028777777'], ['7161111', 'OG6028777777'], ['7161111', 'OG6028777777']);
  idle(15);                             // aim ends, ~1.2s after the fallback booked — inside the grace
  // Act 4 — THREE SKIDS, ONE PRO, no piece id on any of them. The manifest says
  // three, so skids 2 and 3 are ordinary work and must book with no tap. What
  // separates them from a second LOOK is that the label leaves the frame: phase
  // A holds one label under the lens for five seconds and must book exactly ONE
  // piece however many windows close in that time.
  for (let i = 0; i < 55; i++) frames.push(['7163333']);   // ~5.4s of unbroken aim: TWO windows close
  idle(15);                             // the loader turns to skid 2 (~1.5s absent)
  for (let i = 0; i < 15; i++) frames.push(['7163333']);   // skid 2 acquired
  idle(15);                             // and to skid 3
  for (let i = 0; i < 15; i++) frames.push(['7163333']);   // skid 3 acquired
  idle(30);                             // ~2.9s, so the last window closes in the run
  window.__scanScript = frames;
  window.__scanTotal = frames.length;
  // Frame cadence is a property of the browser's detect loop, not of this
  // script, and every act's timing is measured in frames — so it is recorded
  // rather than assumed. `drainedAt` is when the last scripted frame was taken.
  window.__scanFirstAt = 0;
  window.__scanDrainedAt = 0;
  window.BarcodeDetector = class {
    static async getSupportedFormats() { return ['code_128', 'code_39']; }
    async detect() {
      if (!window.__scanFirstAt) window.__scanFirstAt = Date.now();
      if (window.__scanScript.length) {
        const f = window.__scanScript.shift();
        if (!window.__scanScript.length) window.__scanDrainedAt = Date.now();
        return f.map((rawValue) => ({ rawValue }));
      }
      return [];
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

// Acts 1-4 plus every window close, with slack.
await page.waitForTimeout(38000);

// How fast the scripted frames actually drained. Every act above is written in
// frames, so this is the conversion factor — and a run where the script never
// drained has not finished its acts, which would otherwise look like a genuine
// scanning failure.
const pace = await page.evaluate(() => ({
  left: window.__scanScript.length,
  total: window.__scanTotal,
  ms: (window.__scanDrainedAt || Date.now()) - (window.__scanFirstAt || Date.now()),
}));
const perFrame = pace.total > pace.left ? pace.ms / (pace.total - pace.left) : 0;
console.log(`   frames: ${pace.total - pace.left}/${pace.total} drained in ${pace.ms}ms (~${perFrame.toFixed(0)}ms/frame)`);
if (pace.left) fail(`${pace.left} scripted frames never played — the run ended before its acts did`);

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

// Act 4: three skids of one PRO, none with a readable piece id.
// The two halves this proves, and they pull in opposite directions:
//   SPEED  skids 2 and 3 book with NO confirmation tap — the manifest already
//          says three are coming, so a repeat PRO below that count is work,
//          not a suspicion. (Chad: "the scanner is taking too long now that we
//          are confirming each new item to same pro".)
//   SAFETY five seconds of unbroken aim at ONE label is still ONE piece. The
//          label has to leave the frame to earn the next booking, so a phone
//          left pointing at a skid cannot quietly fill the stop.
const three = queue.filter((r) => r.pro === '7163333' && !r.voided);
if (three.length !== 3) fail(`THREE SKID CO booked ${three.length} pieces from three aims — must be exactly 3 (the stop has room for 5, so over-booking is visible here rather than capped)`);
const distinct = new Set(three.map((r) => r.og));
if (distinct.size !== three.length) fail(`THREE SKID CO has duplicate ids: ${[...distinct].join(', ')}`);
if (three.some((r) => !/^NOOG-7163333-\d+$/.test(String(r.og)))) {
  fail(`THREE SKID CO ids should all be NOOG fallbacks: ${three.map((r) => r.og).join(', ')}`);
}

const body = await page.locator('body').innerText();
// The confirmation card must never have been needed — its own words are the
// assertion, because a tap demanded on ordinary work is the whole complaint.
if (/already logged|tap to add it/i.test(body)) fail('a confirmation card was raised for an expected piece');
if (!/6\s*\/\s*10/.test(body)) fail(`header count should read 6/10, body has: ${body.match(/\d+\s*\/\s*\d+/g)}`);
if (errs.length) fail('uncaught errors: ' + errs.join(' | '));

await browser.close();
server.close();
console.log(ok
  ? '\n✓ PASS — one aim books ONE piece with its real id; a dead OG books via NOOG at the window; a LATE OG upgrades its NOOG instead of doubling it; and three skids of one PRO book with no tap while five seconds of unbroken aim books once'
  : '\n✗ failed');
process.exit(ok ? 0 : 1);
