// An order staged onto an open Compare card must not read as available in the bottom grid.
//
// Chad: "Paragon should still be highlighted a different colour on bottom panel now that
// it's applied to this route or say the driver's name, looks like it's still available."
//
// The failure this pins is a silent one — the grid renders a perfectly normal row, and the
// only symptom is a router planning the same freight twice — so there is nothing on screen
// to notice when a stale-base merge drops one of these lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('the grid has a data source: every open card\'s order, keyed by stop', () => {
  assert.ok(/const wbStagedByStop = useMemo\(\(\) => \{/.test(src),
    'RoutingScreen must index the open Compare cards by stop number.');
  assert.ok(
    /color: rv\.color, seq: idx \+ 1, key: rv\.key, name: rv\.name \|\| rv\.loadNbr \|\| rv\.key,/.test(src),
    'the index must carry the card COLOUR (the identity the map and header already use), the '
    + 'SEQUENCE, and a printable NAME — a phone has no hover to reveal the last of those.',
  );
});

test('both Routing grids receive it — a phone is not a smaller desktop', () => {
  const n = (src.match(/stagedByStop=\{wbStagedByStop\}/g) || []).length;
  assert.equal(n, 2, `expected the phone AND desktop bottom grids to be handed it, found ${n}`);
});

test('the Map screen\'s grid is deliberately NOT handed it', () => {
  // Compare cards are a Routing concept; the Map screen has none open, so its grid must not
  // claim rows are staged. The default is null and that is the whole mechanism.
  assert.ok(/function BottomStopsTable\(\{[^)]*stagedByStop = null,/.test(src),
    'stagedByStop must default to null so the Map screen renders no staged marks.');
});

test('the row is tinted, the name is chipped, and the Load column names the card', () => {
  assert.ok(/background: `\$\{stagedByStop\.get\(String\(s\.stopNbr\)\)\.color\}14`/.test(src),
    'a staged row must be tinted in its own card\'s colour.');
  assert.ok(/<StagedChip staged=\{stagedByStop\?\.get\?\.\(String\(s\.stopNbr\)\) \|\| null\} \/>/.test(src),
    'the chip must ride the NAME cell — the one column a phone always shows.');
  assert.ok(/<span className="text-slate-400"> · staged<\/span>/.test(src),
    'the Load column must say STAGED, not planned: these orders are not in NuVizz yet.');
});

test('selection still wins over the staged tint', () => {
  assert.ok(
    /style=\{\(!highlightIds\?\.has\(String\(s\.stopNbr\)\) && stagedByStop\?\.get\?\.\(String\(s\.stopNbr\)\)\)/.test(src),
    'the staged tint must yield to the live selection — selection is the thing the router is '
    + 'doing right now, and two tints on one row read as neither.',
  );
});

test('a stop planned on one load and staged on another shows BOTH', () => {
  assert.ok(/\{saved && !sameLoad && <span className="text-slate-500"> · on \{saved\}<\/span>\}/.test(src),
    'the staged card must never hide the saved load — that disagreement is exactly what a '
    + 'router needs to see before pressing Save.');
});
