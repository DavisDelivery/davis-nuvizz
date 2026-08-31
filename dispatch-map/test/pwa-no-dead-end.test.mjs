// test/pwa-no-dead-end.test.mjs
//
// A DOCUMENT THIS APP SERVES MUST OPEN OVER THE APP, NEVER INSTEAD OF IT.
//
// Chad, at 11:14pm, under a 13-page Uline manifest filling his whole phone:
// "when you load a manifest there is no way get back to the app."
//
// The mechanic, and the reason it is not obvious from a desk: target="_blank" is fine in a
// browser tab and is a DEAD END in the installed app. iOS runs a home-screen web app with no
// address bar, no toolbar and no back gesture, so _blank navigates the same window and the
// document simply replaces the board. There is no gesture that undoes it — the only way out
// is to kill the app and reopen it, which on a dispatch board at 11pm means losing whatever
// was on screen.
//
// This was found once on POD photos and fixed there with an in-app viewer. The manifest PDF
// link was the same anchor one screen over, and nothing stopped it being written again. So
// the rule is a test now: any anchor pointing at one of OUR OWN function endpoints may not
// carry target="_blank". External hosts are a different thing entirely — a Google Maps link
// is a deliberate hand-off to the Maps app and iOS returns you with the app switcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

/** Every <a …> in the file, whole tag, however many lines it spans. */
function anchors(src) {
  return src.match(/<a\s[^>]*?>/gs) || [];
}

test('no anchor opens one of our own endpoints with target="_blank"', () => {
  const offenders = anchors(APP).filter((a) => {
    if (!/target=["']_blank["']/.test(a)) return false;
    // Ours: a Netlify function, or a same-origin path built by a *Href helper.
    const ours = /netlify\/functions|\bpdfHref\(|\bpodDocUrl\(/.test(a);
    if (!ours) return false;
    // The viewer's own "open in browser" control is the ONE deliberate way out, and it is
    // marked so a regression cannot hide behind it.
    return !/data-escape-hatch/.test(a);
  });
  assert.deepEqual(offenders, [],
    `these strand the dispatcher in the installed app — route them through DocumentViewerModal:\n${offenders.join('\n\n')}`);
});

test('the manifest PDF goes through the shared viewer', () => {
  const card = APP.slice(APP.indexOf('function ManifestHistoryCard('));
  const body = card.slice(0, card.indexOf('\nfunction '));
  assert.match(body, /<DocumentViewerModal/, 'the card mounts the viewer');
  assert.match(body, /onClose=\{\(\) => setViewPdf\(null\)\}/, 'and it can be closed');
  assert.ok(!/<a[^>]*pdfHref/s.test(body), 'the PDF is no longer an anchor that navigates away');
});

test('the viewer offers a way out that is not the browser', () => {
  // Three of them, in fact: Esc, the X, and a full-width Close under the thumb. A modal whose
  // only dismiss is a 44px X in a corner is the same trap with extra steps on a phone.
  const v = APP.slice(APP.indexOf('function DocumentViewerModal('));
  const body = v.slice(0, v.indexOf('\nfunction '));
  assert.match(body, /e\.key === 'Escape'/, 'Esc dismisses');
  assert.match(body, /aria-label="Close"/, 'the X dismisses');
  assert.match(body, />Close</, 'and there is a labelled Close under the thumb');
  assert.match(body, /role="dialog"/, 'it is a dialog');

  // AND ITS ONE WAY OUT TO THE BROWSER IS MARKED. The viewer's escape hatch is the single
  // anchor in this app allowed to hand a document to the native viewer, and it points at a
  // `src` PROP rather than a recognisable helper — so the file-wide check above cannot see
  // it, and a regression written the same way would ride in behind it. Every _blank anchor
  // inside the viewer must therefore carry the marker, which is what makes the marker mean
  // something instead of being decoration.
  const blanks = (body.match(/<a\s[^>]*?target=["']_blank["'][^>]*?>/gs) || []);
  assert.equal(blanks.length, 1, 'exactly one way out to the browser');
  assert.match(blanks[0], /data-escape-hatch/, 'and it is the marked one');
});

test('POD photos and the manifest share ONE viewer, so neither can drift', () => {
  // They were separate before and the second one inherited the bug. One implementation is
  // the only version of this that stays fixed.
  assert.equal((APP.match(/function DocumentViewerModal\(/g) || []).length, 1);
  const pod = APP.slice(APP.indexOf('function PodViewerModal('));
  assert.match(pod.slice(0, 600), /<DocumentViewerModal/,
    'PodViewerModal must delegate rather than keep its own copy');
});

// ── THE WHOLE DOCUMENT, NOT PAGE ONE ─────────────────────────────────────────
//
// Chad: "Still only able to see one page of the manifest." Then: "I want to see the whole pdf
// in the viewer and I want it sized to an iPhone."
//
// iOS WebKit collapses an embedded PDF to a single static page — this repo already paid for
// that lesson on Print Manifest (changelog v0.29.74: "which iOS Safari was collapsing to a
// single page"). Desktop Chrome embeds a real paginated reader, which is exactly why it never
// showed up at a desk. And the usual escape is closed: opening the PDF in a tab strands the
// dispatcher in the installed app, which is what the tests above exist to prevent.
//
// So the pages are drawn here with pdf.js. These pin the three properties that make that
// affordable on a phone — none of which can be verified from this environment by running a
// browser, because there is no WebKit here (the same wall v0.54.80 hit). They are held by
// construction instead.

const PDF_PAGES = APP.slice(APP.indexOf('const PDF_MAX_EFFECTIVE'), APP.indexOf('function DocumentViewerModal('));

test('A PDF IS DRAWN, NEVER PUT IN AN IFRAME', () => {
  const v = APP.slice(APP.indexOf('function DocumentViewerModal('));
  const body = v.slice(0, v.indexOf('\nfunction '));
  assert.ok(!/<iframe/.test(body), 'an iframe shows page one only on iOS — render the pages');
  assert.match(body, /<PdfPages src=\{src\}/, 'the non-image branch renders the pages itself');
  // Images never had the problem and keep the simple path.
  assert.match(body, /isImg \?/, 'images still render as an <img>');
});

test('the engine is LAZY — a dispatch board must not carry a PDF renderer on every cold start', () => {
  // Measured: static imports would put ~107KB gzip into the main bundle. Dynamic keeps the
  // cold start at +1.2KB gzip and fetches the engine the first time somebody opens a document.
  assert.ok(!/^import .*pdfjs-dist/m.test(APP), 'pdfjs must never be imported statically');
  assert.match(PDF_PAGES, /await import\('pdfjs-dist'\)/, 'the engine is dynamically imported');
  assert.match(PDF_PAGES, /await import\('pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url'\)/,
    'and so is its worker, so both land in the lazy chunk');
  assert.match(PDF_PAGES, /GlobalWorkerOptions\.workerSrc = workerUrl/, 'the worker is actually wired up');
});

test('EFFECTIVE RESOLUTION IS CAPPED — zoom and DPR must not multiply', () => {
  // The measurement that forced this: 4x zoom into a 2x backing store cost 105.6MB of canvas
  // across four pages. Capping the PRODUCT took the same view to 6.6MB. Pixels per inch of
  // paper stay constant, so nothing on screen looks softer.
  assert.match(PDF_PAGES, /PDF_MAX_EFFECTIVE\s*=\s*2/);
  assert.match(PDF_PAGES, /PDF_MAX_EFFECTIVE \/ Math\.max\(1, zoom\)/, 'the cap divides by zoom');
  assert.match(PDF_PAGES, /const dpr = pdfDpr\(zoom\)/, 'and the renderer uses it');
  assert.ok(!/Math\.min\(window\.devicePixelRatio \|\| 1, PDF_MAX_DPR\)/.test(PDF_PAGES),
    'the old unconditional 2x backing store is gone');
});

test('MEMORY IS BOUNDED BY THE WINDOW, NOT BY THE DOCUMENT', () => {
  // Every page painting at once is the failure this replaced: 13 of 13 canvases were live
  // before anything was scrolled to. A page that leaves the window releases its pixels, so a
  // 40-page manifest costs what a 3-page one costs.
  assert.match(PDF_PAGES, /if \(!active\) \{/, 'an inactive page releases');
  assert.match(PDF_PAGES, /canvas\.width = 0; canvas\.height = 0;/, 'and it actually frees the backing store');
  assert.match(PDF_PAGES, /const neighbours = zoom >= 3 \? 0 : 1/, 'the window tightens as pages get bigger');
});

test('the observer is rooted on the SCROLLER, which is what made the window work at all', () => {
  // Rooted on the viewport (the default) it reported every page inside the scrolling div as
  // visible and the window never closed — 13/13 painted. This is the whole fix.
  assert.match(PDF_PAGES, /new IntersectionObserver\([\s\S]*?\{ root, rootMargin/,
    'the observer must be rooted on the scroll container');
  assert.match(PDF_PAGES, /const root = scrollRef\.current/);
});

test('zoom is a CONTROL, because a gesture cannot be verified from here', () => {
  // index.css pins html/body/#root to overflow:hidden, so page-level pinch is not something
  // to lean on, and there is no WebKit in this environment to test a gesture against.
  assert.match(PDF_PAGES, /aria-label="Zoom in"/);
  assert.match(PDF_PAGES, /aria-label="Zoom out"/);
  assert.match(PDF_PAGES, /aria-label="Fit the page to the screen"/);
  // Thumb-sized, like every other control on this phone.
  const buttons = PDF_PAGES.match(/minWidth: 44, minHeight: 40/g) || [];
  assert.ok(buttons.length >= 3, `all three zoom controls are thumb-sized (found ${buttons.length})`);
});

test('a page that will not draw does not take the document down', () => {
  assert.match(PDF_PAGES, /catch \(e\) \{/);
  assert.match(PDF_PAGES, /page \{pageNumber\}/, 'a failed page still shows its number');
});
