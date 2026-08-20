// test/emit-version-json.test.mjs — public/version.json is what the DEPLOY WATCHDOG and the
// in-app update bar read. Mangled text there is the one place nobody is looking when they
// most need it to be right.
import test from 'node:test';
import assert from 'node:assert/strict';
import { changelogEntryFor } from '../scripts/emit-version-json.mjs';

const app = (rows) => `const APP_VERSION = '9.9.9';\nconst VERSION_LOG = [\n${rows}\n];\n`;

test('a unicode escape in a changelog row is DECODED, not spelled out', () => {
  // v0.68.3 shipped a version.json reading "the reportu2019s recipient". The reader took the
  // character after a backslash and moved on — right for \\' and \\\\, wrong for \\uXXXX. Many
  // rows in the log carry \\u2014 and \\u201c, so this was never about one row.
  const src = app(`  ['9.9.9', 'The report\\u2019s recipient \\u2014 moved.'],`);
  assert.equal(changelogEntryFor(src, '9.9.9'), 'The report’s recipient — moved.');
});

test('the ordinary escapes still behave', () => {
  const src = app(`  ['9.9.9', 'It\\'s fine, a backslash \\\\ and a quote \\" survive.'],`);
  assert.equal(changelogEntryFor(src, '9.9.9'), 'It\'s fine, a backslash \\ and a quote " survive.');
});

test('a malformed \\u is left alone rather than eating four characters', () => {
  // "\\uZZZZ" is not an escape. Consuming it as one would silently delete real text.
  const src = app(`  ['9.9.9', 'not an escape: \\uZZZZ end'],`);
  assert.equal(changelogEntryFor(src, '9.9.9'), 'not an escape: uZZZZ end');
});

test('the row for the asked version is the one returned, not merely the first', () => {
  const src = app(`  ['9.9.9', 'newest'],\n  ['9.9.8', 'older'],`);
  assert.equal(changelogEntryFor(src, '9.9.8'), 'older');
  assert.equal(changelogEntryFor(src, '0.0.1'), null);
});
