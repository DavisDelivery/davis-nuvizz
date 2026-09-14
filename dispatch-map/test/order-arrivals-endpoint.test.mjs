// test/order-arrivals-endpoint.test.mjs
//
// THE ARRIVAL-CURVE FEATURE CANNOT REACH NUVIZZ, AND ITS WRITES ARE GATED.
//
// The feature exists to answer an evening question for FREE — the whole argument for it is
// that `enriched_at` is already on every stop, so no vendor call is needed. A module here that
// quietly imported a NuVizz helper would turn a Firestore read into scan spend against a
// 2,000/day ceiling, and nothing on the screen would say so. Held by the import graph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FILES = [
  'netlify/functions/order-arrivals.mts',
  'netlify/functions/order-arrivals-seal-background.mts',
  'netlify/functions/lib/order-arrivals-store.mts',
  'src/lib/order-arrivals.js',
];
const BANNED = /from\s+['"][^'"]*(nuvizz-[a-z-]+|manifest-run|nuvizz-request|nuvizz-scan)\.m?[jt]s['"]/;
const RAW_FETCH_TO_VENDOR = /portal\.nuvizz\.com|\$\{NUVIZZ_BASE\}/;

test('no arrivals file imports a NuVizz module directly, or names the vendor host', () => {
  for (const f of FILES) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!BANNED.test(src), `${f} imports a NuVizz module`);
    assert.ok(!RAW_FETCH_TO_VENDOR.test(src), `${f} names the vendor host`);
  }
});

test('and every arrivals file that exists is on the list above — a new one is not exempt by omission', () => {
  const found = [];
  for (const dir of ['netlify/functions', 'netlify/functions/lib', 'src/lib']) {
    for (const name of readdirSync(join(ROOT, dir))) if (/order-arrivals/.test(name)) found.push(`${dir}/${name}`);
  }
  for (const f of found) assert.ok(FILES.includes(f), `${f} is an arrivals file not covered by this guard — add it`);
});

test('GET reads; only POST writes, and each write action is gated at the right role', () => {
  const src = readFileSync(join(ROOT, 'netlify/functions/order-arrivals.mts'), 'utf8');
  const getBlock = src.slice(src.indexOf("if (req.method === 'GET')"), src.indexOf("if (req.method !== 'POST')"));
  assert.ok(!/sealDate|setDoc/.test(getBlock), 'GET must not seal or write anything');
  assert.match(getBlock, /requireUser\(req, \{ role: 'viewer' \}\)/, 'the read is gated at viewer');
  const postBlock = src.slice(src.indexOf("if (req.method !== 'POST')"));
  assert.match(postBlock, /action === 'seal'[\s\S]*?requireUser\(req, \{ role: 'dispatcher' \}\)/, 'seal is gated at dispatcher');
  assert.match(postBlock, /action === 'backfill'[\s\S]*?requireUser\(req, \{ role: 'admin' \}\)/, 'backfill is gated at admin');
  assert.match(postBlock, /readJsonBody\(req\)/, 'the body is read through the bounded reader');
});

test('a backfill can be dry-run, because overwriting sixty sealed nights is not a thing to discover by doing', () => {
  const src = readFileSync(join(ROOT, 'netlify/functions/order-arrivals.mts'), 'utf8');
  assert.match(src, /body\.body\?\.dry/, 'backfill supports a dry run');
  assert.match(src, /dry: true/, 'the dry run says so in its answer');
});

test('the endpoint has a timeout entry — a 700-stop list on the 10s default is an HTML 502', () => {
  const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  assert.match(toml, /\[functions\."order-arrivals"\]\s*\n\s*timeout = 26/);
});

test('the sealer runs after the ET day has closed in BOTH seasons, and heals holes rather than sealing one day', () => {
  const src = readFileSync(join(ROOT, 'netlify/functions/order-arrivals-seal-background.mts'), 'utf8');
  const m = /schedule:\s*'(\d+)\s+(\d+)\s+\*\s+\*\s+\*'/.exec(src);
  assert.ok(m, 'the sealer carries a daily cron');
  const utcHour = Number(m[2]);
  // EDT is UTC-4, EST is UTC-5. The sealed day must already be closed (past ET midnight) and
  // past Uline's ~12:30a last report, in either season.
  for (const offset of [4, 5]) {
    const etHour = (utcHour - offset + 24) % 24;
    assert.ok(etHour >= 1 && etHour < 5, `${utcHour}:00 UTC is ${etHour}:00 ET at UTC-${offset} — must be after midnight and before the 5am roll`);
  }
  assert.match(src, /readSealed\(TENANT, d\)/, 'a settled night is not re-sealed by the schedule');
  assert.match(src, /CATCHUP_DAYS/, 'the run heals holes rather than sealing exactly one day');
});

test('the kill switch is the house shape: default on, an off-word turns it off, a typo leaves it ON', async () => {
  const { arrivalsEnabled } = await import('../netlify/functions/lib/order-arrivals-store.mts');
  assert.equal(arrivalsEnabled({}), true, 'default on');
  for (const v of ['off', '0', 'false', 'no', 'OFF', ' Off ']) {
    assert.equal(arrivalsEnabled({ ORDER_ARRIVALS_ENABLED: v }), false, `${v} turns it off`);
  }
  // The failure this prevents: a typo silently disabling the sealing, which looks exactly like
  // a working feature until somebody needs the history that was never written.
  for (const v of ['offf', 'yes', 'on', 'true', '1', 'banana']) {
    assert.equal(arrivalsEnabled({ ORDER_ARRIVALS_ENABLED: v }), true, `${v} must leave it ON`);
  }
});

test('Uline is identified by the 9-digit PRO, never by the `source` field', async () => {
  // source on the list path is the literal 'nuvizz-list' provenance tag and it is a LIVE field,
  // so a filter on source === 'ULINE' would read zero for ever. This pins the discriminator to
  // the same rule uline-manifest.mts uses.
  const { ULINE_PRO_RE } = await import('../netlify/functions/lib/order-arrivals-store.mts');
  assert.ok(ULINE_PRO_RE.test('007151447'));
  assert.ok(!ULINE_PRO_RE.test('AVRT-0028093763'));
  assert.ok(!ULINE_PRO_RE.test('007151447-2'));
  // Checked against CODE, not prose: the store's own header explains the trap by naming it,
  // and a guard that cannot tell a warning from the mistake it warns about is a guard nobody
  // can write the explanation next to.
  const store = readFileSync(join(ROOT, 'netlify/functions/lib/order-arrivals-store.mts'), 'utf8');
  const code = store.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/source\s*===\s*['"]ULINE['"]/i.test(code), 'never filter Uline on the source field');
});

test('the stop mask carries a field every stop has — or unstamped orders vanish and coverage lies', async () => {
  // THE SILENT FAILURE THIS PINS: a Firestore masked read returns a document with no `fields`
  // key when it carries none of the masked paths, docToObject returns null for that, and
  // listDocs skips it. Masking on enriched_at alone would drop every UNSTAMPED stop from the
  // list — total would count only the stamped ones and coverage would read 100% on a board
  // where a third of the freight has no stamp. The coverage guard would be disarmed and the
  // screen would project off a third of the night looking exactly like a good reading.
  const { ARRIVAL_MASK } = await import('../netlify/functions/lib/order-arrivals-store.mts');
  assert.ok(ARRIVAL_MASK.includes('stopNbr'), 'the mask must include a field present on EVERY stop doc');
  assert.ok(ARRIVAL_MASK.includes('enriched_at'), 'the mask must include the arrival stamp itself');
});
