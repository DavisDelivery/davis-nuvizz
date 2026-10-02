// test/stop-card-tight.test.mjs
//
// THE STOP CARD, TIGHTER (v1.107.1). Chad, 10/02, of the "More:" fold on the stop card:
//   "Don't understand why this is in a drawer seems like it should just be fixed nice and tight in
//    2 rows small text."
// and of the PROs section:
//   "don't think this is need on the oder screen pro number is at the top pro should never be hidden
//    and we don't need the pro text just the number we know what it is."
//
// Read off the real source, each named for what a dispatcher would see go wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const between = (from, to) => {
  const i = APP.indexOf(from);
  assert.ok(i >= 0, `${from} not found`);
  const j = APP.indexOf(to, i + from.length);
  assert.ok(j > i, `${to} not found after ${from}`);
  return APP.slice(i, j);
};
const DATA = between('function StopDataSections(', '\nfunction ');
const SIDEBAR = between('function StopSidebar(', '\nfunction ');
const DRAWER = between('function MobileStopDetailDrawer(', '\nfunction ');
const LOOKUP = between('function LookupStopModal(', '\nfunction ');

test('the card\'s other actions are on screen, not folded behind "More:"', () => {
  assert.doesNotMatch(DATA, /More: Street View/, 'no "More:" disclosure left on the card');
  assert.doesNotMatch(DATA, /moreOpen/, 'nothing opens or closes them');
  // Three to a row, so the six actions are two rows.
  assert.match(DATA, /<div className=\{`mt-1\.5 grid grid-cols-3 \$\{mobile \? 'gap-x-2' : 'gap-x-1\.5'\}`\} data-stop-actions>/);
  for (const label of ['StreetViewLink', 'WebSearchLink', 'Edit address', 'Correct pin', 'Text driver', 'History']) {
    assert.ok(DATA.indexOf(label, DATA.indexOf('data-stop-actions')) > 0, `${label} is in the rows`);
  }
});

test('each action is one line — a label that wraps makes its row twice as tall', () => {
  assert.match(APP, /const stopActionCls = \(mobile\) => `inline-flex items-center gap-1 min-w-0 whitespace-nowrap /);
  assert.match(APP, /<MapPinned size=\{12\} className="shrink-0" \/> <span className="truncate">Street View<\/span>/);
  assert.match(APP, /<Search size=\{12\} className="shrink-0" \/> <span className="truncate">Find business<\/span>/);
});

test('a short label never loses the action\'s full name: the pin button is still "Correct pin location"', () => {
  assert.match(DATA, /aria-label="Correct pin location"/);
  assert.match(DATA, /aria-label=\{`Text driver \(\$\{live\.driverName\}\)`\}/, 'the driver being texted is named');
  // A custom pin is still said, in the cell and in its tooltip.
  assert.match(DATA, /Correct pin\{note\?\.location_override \? ' ✓' : ''\}/);
  assert.match(DATA, /'Correct pin location — a custom pin is saved'/);
});

test('phone and desktop are two views: under a finger every cell is the touch floor\'s 44px, under a mouse one tight line', () => {
  assert.match(DATA, /mobile = false \}\) \{/, 'StopDataSections defaults to the desktop view');
  // No height is forced in the rows: an inline min-height beats index.css's touch floor
  // (pointer: coarse → 44px), which is how a first cut shipped 36px cells to a phone and would
  // have shipped 22px ones to an iPad showing the desktop sidebar.
  const rows = DATA.slice(DATA.indexOf('data-stop-actions>'), DATA.indexOf('</div>', DATA.indexOf('data-stop-actions>')));
  assert.doesNotMatch(rows, /minHeight|min-h-/);
  assert.doesNotMatch(APP.slice(APP.indexOf('function StreetViewLink('), APP.indexOf('function GoogleMapsLink(')), /minHeight/);
  assert.doesNotMatch(APP.slice(APP.indexOf('function WebSearchLink('), APP.indexOf('function OrderItemsSection(')), /minHeight/);
  const CSS = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.match(CSS, /@media \(pointer: coarse\)[\s\S]*a\[href\][^{]*\{\s*min-height: 44px;/, 'the floor that sizes the links');
  // The phone header's copy button stays small to look at and is a 44px target to a thumb.
  assert.match(APP, /"tap-dense relative shrink-0 px-2 py-1 text-\[11px\][^"]*after:absolute after:content-\[''\] after:-inset-y-2\.5 after:-inset-x-1"/);
  assert.match(DRAWER, /<StopDataSections [^>]*\bmobile \/>/, 'the phone drawer asks for the phone view');
  assert.doesNotMatch(SIDEBAR, /<StopDataSections [^>]*\bmobile\b/, 'the desktop sidebar does not');
  assert.match(LOOKUP, /const phone = useMediaQuery\(`\(max-width: \$\{MOBILE_BREAKPOINT - 1\}px\)`\);/);
  assert.match(LOOKUP, /<StopDataSections stop=\{live\} note=\{note\} onRefreshed=\{onRefreshed\} mobile=\{phone\} \/>/);
});

test('the PRO is just the number, and it is never cut to make room', () => {
  // Desktop sidebar (Map and Routing): the number keeps its width; the route label gives way.
  assert.match(SIDEBAR, /<span className="shrink-0 whitespace-nowrap" data-stop-pro>\{stop\.pro \|\| '—'\}<\/span>/);
  assert.match(SIDEBAR, /\{sidebarRouteLabel && <span className="ml-auto pl-2 min-w-0 truncate /);
  assert.doesNotMatch(SIDEBAR, /PRO \{stop\.pro/, 'no "PRO" word in front of it');
  // Phone drawer: the number alone, with the copy button the PROs list used to give a phone.
  assert.match(DRAWER, /<span className="whitespace-nowrap" data-stop-pro>\{stop\.pro \|\| '—'\}<\/span>\s*\n\s*<CopyProButton pro=\{stop\.pro\} light \/>/);
  assert.doesNotMatch(DRAWER, /PRO \{stop\.pro/);
  // PRO-lookup card: the number alone, never in the truncating part of the line.
  assert.match(LOOKUP, /\{pro && <span className="shrink-0 whitespace-nowrap" data-stop-pro>\{pro\}<\/span>\}/);
  assert.doesNotMatch(LOOKUP, /PRO #\$\{pro\}/);
});

test('the PROs list is gone from the card — a board order\'s one PRO is the header', () => {
  assert.doesNotMatch(APP, /<ProsSection\b/);
  assert.doesNotMatch(APP, /function ProsSection\(/);
});
