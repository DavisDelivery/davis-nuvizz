// test/sms-store-id.test.mjs — the SimpleTexting messageId is the sms_messages/{id} doc id
// and it arrives on a public webhook. A plain id is kept (retries de-dupe); anything else
// becomes its sha256 hex — stable, and never a path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { smsDocId, SMS_ID_RE } from '../netlify/functions/lib/sms-store.mts';

test('a plain vendor id is used as-is', () => {
  for (const id of ['4f2a1b9c-7e11-4c0f-9a8b-1234567890ab', 'abc_123', 'X']) assert.equal(smsDocId(id), id);
});

test('an id with a path/query character, a dot segment, or over 200 chars is hashed (64 hex, stable)', () => {
  for (const id of ['a/b', '../nuvizz_ops/circuit', 'x?y=1', 'a#b', '..', 'a.b', 'a b', 'x'.repeat(201)]) {
    const h = smsDocId(id);
    assert.match(h, /^[0-9a-f]{64}$/, id);
    assert.equal(smsDocId(id), h, 'stable across retries');
    assert.ok(SMS_ID_RE.test(h));
  }
});
