// The Print labels screen is WIRED — both navigations, the router, the guards — and prints the
// same label the stop card prints. A screen in one navigation and not the other does not exist
// on a phone (CLAUDE.md, "Two views, always"); it has shipped that way twice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const CODE = APP.slice(APP.indexOf('\n];\n', APP.indexOf('const VERSION_LOG = [')));
// The whole section: its constants, its small parts and the screen itself.
const SCREEN = CODE.slice(CODE.indexOf('// ── PRINT LABELS BY SHIPPER AND DAY'), CODE.indexOf('// New Order opens on a Single / Bulk toggle'));

test('BOTH navigations list it, the phone menu can reach it, and the router renders it', () => {
  assert.match(CODE, /\{ id: 'labels', label: 'Print labels', hint: '[^']+', icon: <Tag size=\{14\} \/> \}/, 'desktop More menu');
  assert.match(CODE, /onClick=\{\(\) => onSelectMenu\('labels'\)\}[\s\S]{0,80}<Tag size=\{12\} \/> Print labels/, 'phone menu');
  assert.match(CODE, /const KNOWN = \[[^\]]*'labels'[^\]]*\]/, 'a name the phone menu does not know lands on the Map');
  assert.match(CODE, /tab === 'labels' \? <LabelsScreen \/>/);
});

test('the heading is the literal every layout guard proves arrival by', () => {
  assert.match(SCREEN, /<h1 className="[^"]*">Print labels<\/h1>/);
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs', 'verify-desktop-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /\{ key: 'labels', label: 'Print labels', nav: \/\^print labels\/i, inMore: true \}/, `${f} must measure the screen`);
    assert.match(src, /import \{ labelsAnswer \} from '\.\/lib\/labels-fixture\.mjs';/, `${f} must stub it with the built fixture`);
  }
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    for (const probe of ['a shipper picked', 'orders ticked', 'a big batch asks first']) {
      assert.match(src, new RegExp(`name: '${probe}'`), `${f} must probe "${probe}"`);
    }
  }
  const fx = readFileSync(new URL('../scripts/lib/labels-fixture.mjs', import.meta.url), 'utf8');
  assert.match(fx, /shipperLabelRows\(/, 'built by the real row builder, not typed');
});

test('it prints with the stop card\'s own renderer and viewer — one label, two doors', () => {
  assert.match(SCREEN, /buildLabelsHtml\(list\.map\(\(x\) => x\.label\), \{ logoUrl: labelLogoUrl\(\), maxPages: MAX_LABEL_PAGES \}\)/);
  assert.match(SCREEN, /<PrintDocModal title=\{doc\.title\} html=\{doc\.html\} pageW=\{816\} onClose=\{\(\) => setDoc\(null\)\} onPrint=\{\(\) => markPrinted\(doc\.nbrs\)\} \/>/);
  assert.match(SCREEN, /apiFetch\(`\/\.netlify\/functions\/labels-by-shipper\?\$\{qs\.toString\(\)\}`\)/);
});

test('it never claims paper came out — only that Print was pressed', () => {
  assert.match(SCREEN, /Print pressed \{labelsClock\(at\)\}/);
  assert.doesNotMatch(SCREEN, />\s*Printed\b/, 'the viewer cannot see the printer, so the screen may not say "Printed"');
  // The viewer is told the button was pressed; it is never told a print succeeded.
  assert.match(CODE, /const doPrint = \(\) => \{ try \{ onPrint\?\.\(\); \}/);
});

test('the day is not remembered and the shipper is; a big batch asks first', () => {
  assert.match(SCREEN, /const \[date, setDate\] = useState\(today\);/);
  // EXACTLY two things are kept on the device: the shipper, and which orders had Print pressed on
  // a day. A remembered DAY would list yesterday's orders under this morning's freight.
  const writes = [...SCREEN.matchAll(/localStorage\.setItem\(([^,]+),/g)].map((m) => m[1].trim()).sort();
  assert.deepEqual(writes, ['LABELS_SHIPPER', 'labelsPrintedKey(date)']);
  assert.match(SCREEN, /localStorage\.setItem\(LABELS_SHIPPER, key\)/);
  assert.match(SCREEN, /const LABELS_CONFIRM_PAGES = 200;/);
  assert.match(SCREEN, /if \(pages > LABELS_CONFIRM_PAGES\) \{ setConfirm\(\{ list, what, pages \}\); return; \}/);
});
