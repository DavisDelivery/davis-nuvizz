// DESKTOP LAYOUT GUARD — the counterpart to verify-mobile-layout.mjs.
//
// Chad, on the Diagnostics screen photographed at ~2000px wide: "i don't like these narrow
// pages it acts like we dont' have 2 versions of this app one for desktop and one for
// mobile these page looks like it was designed for mobile."
//
// He was right, and the reason nobody caught it is that every guard this app has looks at
// PHONES. A screen can be perfect at 390px and still waste half a 1920px display, and no
// check in the build could tell.
//
// WHAT THIS MEASURES. For each screen at desktop sizes, the width actually OCCUPIED by
// content as a fraction of the viewport. A dispatcher's monitor is the working surface; a
// screen using 45% of it is throwing away the other 55%.
//
// WHY IT MEASURES OCCUPANCY AND NOT `max-w-*`. Reading class names would pass the moment
// someone wrote a wider class, whether or not the pixels moved — and the phone guard shipped
// once with checks that were structurally unable to fire, which is a worse outcome than no
// guard because it reads as proof. This walks the real DOM of the real build and measures
// real boxes, so a regression has to actually change what a dispatcher sees to pass.
//
// A screen may opt out with data-desktop-narrow="<reason>" on its container. That is the
// deliberate exception (a confirm dialog, a single-field form) and it must say WHY.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const DIST = process.argv[2] || 'dist';
const PORT = 4183;
const SHOT_DIR = process.env.SHOT_DIR || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

// The floor. Below this a screen is starving the display rather than using it.
const MIN_OCCUPANCY = 0.62;

const DESKTOPS = [
  { name: 'laptop', width: 1440, height: 900 },
  { name: 'desktop', width: 1920, height: 1080 },
];

const SCREENS = [
  { key: 'routing', label: 'Routing (beta)', nav: /routing/i },
  { key: 'neworder', label: 'New Order', nav: /new order/i },
  { key: 'quote', label: 'Quote', nav: /quote/i },
  { key: 'manifest', label: 'Manifest check', nav: /manifest check/i, inMore: true },
  { key: 'comms', label: 'Customer emails', nav: /customer emails/i, inMore: true },
  { key: 'diagnostics', label: 'Diagnostics', nav: /diagnostics/i, inMore: true },
];

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

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});

let failures = 0;
console.log('\nDesktop layout guard — is the display being used?\n');

for (const device of DESKTOPS) {
  console.log(`\x1b[1m${device.name} (${device.width}x${device.height})\x1b[0m`);
  const ctx = await browser.newContext({ viewport: { width: device.width, height: device.height } });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  for (const screen of SCREENS) {
    // NAVIGATION. Playwright's click is refused here for the More-menu items (the menu
    // overlays them), so after opening the group we fall back to a DOM click on the button
    // whose own text matches. Whichever path is used, the screen must then PROVE it opened
    // or the run is aborted for that screen rather than silently measuring the previous one
    // twice — a probe that quietly no-ops is how a guard passes while seeing nothing.
    const opened = await (async () => {
      if (screen.inMore) {
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) => /^more$/i.test((x.innerText || '').trim()));
          if (b) b.click();
        });
        await page.waitForTimeout(400);
      }
      const clicked = await page.evaluate((src) => {
        const re = new RegExp(src, 'i');
        const b = [...document.querySelectorAll('button')].find((x) => re.test((x.innerText || '').trim()));
        if (!b) return false;
        b.click();
        return true;
      }, screen.nav.source);
      if (!clicked) return false;
      await page.waitForTimeout(1100);
      // Proof of arrival: the screen's own heading is on the page.
      return page.evaluate((label) => document.body.innerText.includes(label), screen.label);
    })();

    if (!opened) {
      failures += 1;
      console.log(`  \x1b[31mFAIL\x1b[0m ${screen.label.padEnd(16)} could not be opened — NOT measured`);
      continue;
    }

    const m = await page.evaluate((minOcc) => {
      const vw = window.innerWidth;
      // MEASURE THE CONTENT COLUMN, NOT THE PAGE.
      //
      // This check has now been wrong twice, and both wrong versions PASSED everything,
      // which is the failure mode that matters: a green line reads as proof.
      //   v1 took the widest visible element holding text — always the full-width app
      //       shell, so every screen read 100%.
      //   v2 took the horizontal span of all text on the page — but the footer bar
      //       ("Dispatch Map v0.55.1 ..." hard left, the copyright hard right) spans the
      //       viewport by design, so every screen read 98%.
      // Both were structurally unable to fire. The lesson is the same one the phone guard
      // learned: measure the thing the complaint is about, then go and LOOK at a screenshot
      // to confirm the number describes what you can see.
      //
      // A screen's content lives in its scroll region — the element the screen scrolls
      // inside, which is exactly where the max-w-* cap sits. Measure that region's width.
      // Chrome (header, footer) sits outside it and cannot flatter the result.
      let best = null;
      for (const el of document.querySelectorAll('#root *')) {
        const cs = getComputedStyle(el);
        const scrolls = /(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflow);
        if (!scrolls) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 200 || r.width < 100) continue;
        if (!(el.textContent || '').trim()) continue;
        const area = r.width * r.height;
        if (!best || area > best.area) best = { el, area, w: r.width };
      }

      let optOut = null;
      for (const el of document.querySelectorAll('#root [data-desktop-narrow]')) {
        optOut = el.dataset.desktopNarrow;
      }

      if (best) {
        // The scroll region itself may be full-width with a capped child; take the widest
        // TEXT extent inside it, which is the column a dispatcher actually reads.
        let min = Infinity, max = 0, n = 0;
        for (const el of best.el.querySelectorAll('*')) {
          if (el.children.length > 0) continue;
          if (!(el.textContent || '').trim()) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
          min = Math.min(min, r.left); max = Math.max(max, r.right); n += 1;
        }
        const span = n ? Math.round(max - min) : Math.round(best.w);
        return { vw, widest: span, occupancy: span / vw, optOut, samples: n, mode: 'scroll-region' };
      }

      // No scroll region (a full-bleed map or board): fall back to the text band between
      // the header and the footer, both of which span the viewport deliberately.
      let min = Infinity, max = 0, n = 0;
      for (const el of document.querySelectorAll('#root *')) {
        if (el.children.length > 0) continue;
        if (!(el.textContent || '').trim()) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (r.top < 70 || r.bottom > window.innerHeight - 30) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
        min = Math.min(min, r.left); max = Math.max(max, r.right); n += 1;
      }
      const span = n ? Math.round(max - min) : 0;
      return { vw, widest: span, occupancy: n ? span / vw : 1, optOut, samples: n, mode: 'text-band' };
    }, MIN_OCCUPANCY);

    const pct = Math.round(m.occupancy * 100);
    if (m.optOut) {
      console.log(`  \x1b[36m-\x1b[0m ${screen.label.padEnd(18)} ${pct}% — deliberately narrow: ${m.optOut}`);
    } else if (m.occupancy < MIN_OCCUPANCY) {
      failures += 1;
      console.log(`  \x1b[31mFAIL\x1b[0m ${screen.label.padEnd(16)} uses ${pct}% of ${m.vw}px (${m.widest}px, ${m.mode}) — floor is ${Math.round(MIN_OCCUPANCY * 100)}%`);
    } else if (m.samples < 5) {
      // Too little rendered text to judge honestly — say so rather than pass by default.
      failures += 1;
      console.log(`  \x1b[31mFAIL\x1b[0m ${screen.label.padEnd(16)} only ${m.samples} text nodes measured — cannot judge`);
    } else {
      console.log(`  \x1b[32mok\x1b[0m   ${screen.label.padEnd(16)} uses ${pct}% of ${m.vw}px (${m.widest}px, ${m.samples} nodes, ${m.mode})`);
    }
    if (SHOT_DIR) {
      await page.screenshot({ path: join(SHOT_DIR, `${device.name}-${screen.key}.png`) }).catch(() => {});
    }
  }
  await ctx.close();
  console.log('');
}

await browser.close();
srv.close();

if (failures) {
  console.error(`\x1b[31m${failures} screen${failures === 1 ? '' : 's'} starving the desktop viewport.\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mEvery screen uses the display.\x1b[0m');
