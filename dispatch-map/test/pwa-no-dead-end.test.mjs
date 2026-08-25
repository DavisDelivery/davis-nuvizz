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
