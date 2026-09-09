// scripts/territory-sheet.mjs — render the printed driver-area sheet from a JSON file.
//
//   node scripts/territory-sheet.mjs <data.json> > sheet.html
//
// A thin CLI. The sheet itself lives in src/lib/territory-sheet-html.js so the live endpoint
// (netlify/functions/driver-territory.mts) serves the identical bytes — see the note there.
import fs from 'node:fs';
import { territorySheetHtml } from '../src/lib/territory-sheet-html.js';

const src = process.argv[2];
if (!src) { console.error('usage: territory-sheet.mjs <data.json>'); process.exit(2); }
process.stdout.write(territorySheetHtml(JSON.parse(fs.readFileSync(src, 'utf8'))));
