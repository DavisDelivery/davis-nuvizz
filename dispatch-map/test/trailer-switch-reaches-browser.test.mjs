// test/trailer-switch-reaches-browser.test.mjs — client-routing-board-libs-2.
//
// TRAILER_ALERT_ANY_RESTRICTION=off is documented (trailer-block.js, the v1.54.0 changelog row)
// as putting the no-tractor-trailer alert back "on every side at once — panel, card and text
// all read the one function". The 9pm text runs in a Netlify function and reads process.env,
// so it obeyed. The flag panel and the map's R7 card run in the BROWSER, where Vite only hands
// VITE_-prefixed variables to the bundle and `process` does not exist — so with the documented
// name set, the text went quiet and the panel kept the red card for the same dock. A half-
// reverted switch, which is worse than none.
//
// These tests build the real trailer-block.js with the real vite.config.js's `define`, then run
// the bundle in a context with NO `process` — what a browser has — and ask the switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TRAILER_BLOCK = path.join(ROOT, 'src/lib/trailer-block.js');
const CONFIG = pathToFileURL(path.join(ROOT, 'vite.config.js')).href;

// The config reads process.env when it is evaluated — that is build time on Netlify. A fresh
// query string gives a fresh evaluation under the env each case sets.
let seq = 0;
async function configDefineUnder(env) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; }
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const mod = await import(`${CONFIG}?case=${++seq}`);
    return mod.default.define || {};
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// What the browser sees: the module bundled by Vite with that define, then run with no
// `process` global at all.
async function browserAnswer(define) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailer-switch-'));
  try {
    const entry = path.join(dir, 'entry.js');
    fs.writeFileSync(entry, [
      `import { trailerAlertAnyRestriction, dispatcherTrailerBlock } from ${JSON.stringify(TRAILER_BLOCK)};`,
      'export const on = trailerAlertAnyRestriction();',
      // A customer whose "No tractor trailer" was read off Address 2: the widened rule blocks it,
      // the dispatcher-owned rule the switch goes back to does not.
      "export const addr2Blocked = dispatcherTrailerBlock({ equipment_restrictions: ['no_tractor_trailer'], auto_sources: { no_tractor_trailer: ['addressLine2'] } }).blocked;",
    ].join('\n'));
    const out = await build({
      configFile: false, root: dir, logLevel: 'silent', mode: 'production', define,
      build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'T', fileName: 'x' } },
    });
    const code = (Array.isArray(out) ? out[0] : out).output[0].code;
    const ctx = {};
    vm.runInNewContext(`${code}\nglobalThis.__T = T;`, ctx);
    assert.equal(typeof ctx.process, 'undefined', 'the bundle ran with no process, as in a browser');
    return ctx.__T;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('TRAILER_ALERT_ANY_RESTRICTION=off on the build turns the browser flag panel back too, not only the 9pm text', async () => {
  const define = await configDefineUnder({ TRAILER_ALERT_ANY_RESTRICTION: 'off', VITE_TRAILER_ALERT_ANY_RESTRICTION: undefined });
  const t = await browserAnswer(define);
  assert.equal(t.on, false, 'the documented switch name must reach the browser bundle');
  assert.equal(t.addr2Blocked, false, 'the R7 card stands down for the Address 2 mark, matching the text');
});

test('with the switch unset the browser keeps the widened alert ON (house default)', async () => {
  const define = await configDefineUnder({ TRAILER_ALERT_ANY_RESTRICTION: undefined, VITE_TRAILER_ALERT_ANY_RESTRICTION: undefined });
  const t = await browserAnswer(define);
  assert.equal(t.on, true);
  assert.equal(t.addr2Blocked, true);
});

test('a malformed value on the build leaves the browser alert ON', async () => {
  const define = await configDefineUnder({ TRAILER_ALERT_ANY_RESTRICTION: 'of', VITE_TRAILER_ALERT_ANY_RESTRICTION: undefined });
  const t = await browserAnswer(define);
  assert.equal(t.on, true, 'a typo must never silently re-silence a safety alert');
});

test('the VITE_ spelling still works in the browser when the un-prefixed name is not set', async () => {
  // Vite reads VITE_ vars from the environment itself; supply it the same way a build would.
  const define = {
    ...(await configDefineUnder({ TRAILER_ALERT_ANY_RESTRICTION: undefined, VITE_TRAILER_ALERT_ANY_RESTRICTION: undefined })),
    'import.meta.env.VITE_TRAILER_ALERT_ANY_RESTRICTION': JSON.stringify('off'),
  };
  const t = await browserAnswer(define);
  assert.equal(t.on, false, 'defining the un-prefixed key only when it is set keeps the VITE_ fallback reachable');
});
