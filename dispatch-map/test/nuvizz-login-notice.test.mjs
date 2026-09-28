// test/nuvizz-login-notice.test.mjs — when a write's answer raises the "your NuVizz login" bar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loginNoticeFrom, noteWriteAnswer, onLoginNotice } from '../src/lib/nuvizz-login-notice.js';

test('refused NOW, under preferred: says so, and that changes go out under the shared login', () => {
  const n = loginNoticeFrom({ ok: false, loginRefused: 'NuVizz said: Invalid username or password', identity: { mode: 'preferred', as: 'personal' } });
  assert.equal(n.kind, 'refused-now');
  assert.match(n.text, /NuVizz refused your saved NuVizz login \(NuVizz said: Invalid/);
  assert.match(n.text, /shared login until it is re-entered/);
});

test('refused NOW, under required: says changes are refused', () => {
  const n = loginNoticeFrom({ loginRefused: 'x', identity: { mode: 'required', as: 'personal' } });
  assert.match(n.text, /refused until it is re-entered/);
});

test('a later write that quietly went out as the shared login because of an earlier refusal: raised', () => {
  for (const why of ['rejected', 'unreadable', 'unavailable']) {
    const n = loginNoticeFrom({ ok: true, identity: { mode: 'preferred', as: 'shared', why, note: `note for ${why}` } });
    assert.equal(n.kind, why);
    assert.match(n.text, new RegExp(`note for ${why}`));
  }
});

test('a refusal under required carries the server\'s own sentence', () => {
  const n = loginNoticeFrom({ ok: false, error: 'No NuVizz login is saved for Jane Doe — one has to be added under Account & logins.', identity: { mode: 'required', as: 'refused', why: 'not-saved' } });
  assert.equal(n.kind, 'refused');
  assert.match(n.text, /No NuVizz login is saved for Jane Doe/);
});

test('NOT raised for the ordinary states: personal and working, nothing saved yet, switched off, no identity', () => {
  assert.equal(loginNoticeFrom({ ok: true, identity: { mode: 'preferred', as: 'personal', nuvizzUser: 'jdoe' } }), null);
  assert.equal(loginNoticeFrom({ ok: true, identity: { mode: 'preferred', as: 'shared', why: 'not-saved', note: 'x' } }), null);
  assert.equal(loginNoticeFrom({ ok: true, identity: { mode: 'preferred', as: 'shared', why: 'not-signed-in', note: 'x' } }), null);
  assert.equal(loginNoticeFrom({ ok: true, identity: { mode: 'off', as: 'shared', why: 'off' } }), null);
  assert.equal(loginNoticeFrom({ ok: true, dryRun: true, plan: [] }), null);
  assert.equal(loginNoticeFrom(null), null);
});

test('the channel carries a raised notice to every listener, and a bad listener does not stop the rest', () => {
  const got = [];
  const off1 = onLoginNotice(() => { throw new Error('bad listener'); });
  const off2 = onLoginNotice((n) => got.push(n.kind));
  assert.equal(noteWriteAnswer({ loginRefused: 'x', identity: { mode: 'preferred' } })?.kind, 'refused-now');
  assert.equal(noteWriteAnswer({ ok: true }), null);
  off1(); off2();
  noteWriteAnswer({ loginRefused: 'y' });
  assert.deepEqual(got, ['refused-now']);
});

test('wired: every write answer passes through the notice at the one client write door, unchanged', () => {
  const src = readFileSync(new URL('../src/lib/nuvizzWrite.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ noteWriteAnswer \} from '\.\/nuvizz-login-notice\.js'/);
  assert.match(src, /try \{ noteWriteAnswer\(j\); \} catch/);
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /useEffect\(\(\) => onLoginNotice\(setLoginNotice\), \[\]\)/, 'the Shell listens');
  assert.match(app, /<NuvizzLoginBar notice=\{loginNotice\}/, 'and renders the bar');
});
