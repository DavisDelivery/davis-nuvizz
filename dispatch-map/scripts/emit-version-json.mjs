#!/usr/bin/env node
// scripts/emit-version-json.mjs — write public/version.json from App.jsx.
//
// Chad, on the blue "a newer version is available" bar: "Can we start including a simple set
// of details of what changed in the new version."
//
// The bar cannot know. It compares the fingerprint of the entry bundle this tab is running
// against the one the site serves — content-blind by design, and the changelog lives INSIDE
// the bundle, so a stale tab holds only its own history. This emits the one fact a stale tab
// cannot derive: the deployed version and its one-line headline, in a file small enough to
// fetch on the same three-minute tick the bar already runs.
//
// The headline is DERIVED from the top changelog row rather than hand-written, because a
// second field to maintain is a field that drifts the first time somebody bumps in a hurry.
// Every row in that array opens with a capitalised headline sentence; this takes it.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { headlineFromEntry } from '../src/lib/build-update.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const appPath = path.join(root, 'src', 'App.jsx');
const outPath = path.join(root, 'public', 'version.json');

// Everything below `main()` is side-effect free on import, so the tests can exercise
// changelogEntryFor against the real App.jsx without rewriting public/version.json.


// The changelog row whose version matches APP_VERSION. Located by scanning rather than by
// regex, because the entries are long and contain quotes, apostrophes and brackets of their
// own. Matching on the VERSION rather than taking row [0] blindly means a mis-ordered array
// yields NO headline instead of somebody else's summary — release-guards.test.mjs already
// fails that case, and a build slipping past it should still not caption itself wrongly.
export function changelogEntryFor(source, wanted) {
  const marker = `['${wanted}',`;
  const at = source.indexOf(marker);
  if (at === -1) return null;
  let i = at + marker.length;
  while (i < source.length && /\s/.test(source[i])) i++;
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  i++;
  let out = '';
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') { out += source[i + 1] ?? ''; i += 2; continue; }
    if (c === quote) return out;
    out += c; i++;
  }
  return null;   // unterminated — say nothing rather than guess
}

export function main() {
  const src = fs.readFileSync(appPath, 'utf8');
  const vm = src.match(/const APP_VERSION = '([^']+)'/);
  if (!vm) { console.error('emit-version-json: APP_VERSION not found in App.jsx'); process.exit(1); }
  const version = vm[1];
  const entry = changelogEntryFor(src, version);
  const headline = entry ? headlineFromEntry(entry) : null;
  if (!headline) console.warn(`emit-version-json: no changelog row matched ${version} — the bar will show the version alone`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify({ version, headline, at: new Date().toISOString() }, null, 2)}\n`);
  console.log(`emit-version-json: v${version} → public/version.json${headline ? ` — "${headline.slice(0, 70)}${headline.length > 70 ? '…' : ''}"` : ''}`);
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) main();
