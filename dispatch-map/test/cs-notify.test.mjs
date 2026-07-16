// test/cs-notify.test.mjs — CS-notify recipient resolution.
// The whole "email CS when scheduled" feature depends on a recipient; a missing NOTIFY_CS_TO
// used to make every scheduled scan a silent no-op. csRecipients() now falls back to the CS inbox.
import test from 'node:test';
import assert from 'node:assert/strict';

import { csRecipients, CS_DEFAULT_TO } from '../netlify/functions/lib/cs-notify.mts';

test('csRecipients: NOTIFY_CS_TO wins when set (comma-split, trimmed)', () => {
  const prev = process.env.NOTIFY_CS_TO;
  process.env.NOTIFY_CS_TO = ' a@x.com , b@y.com ';
  assert.deepEqual(csRecipients(), ['a@x.com', 'b@y.com']);
  if (prev === undefined) delete process.env.NOTIFY_CS_TO; else process.env.NOTIFY_CS_TO = prev;
});

test('csRecipients: falls back to the company CS inbox when NOTIFY_CS_TO is unset (no more silent no-op)', () => {
  const prev = process.env.NOTIFY_CS_TO;
  delete process.env.NOTIFY_CS_TO;
  assert.deepEqual(csRecipients(), [CS_DEFAULT_TO]);
  assert.equal(CS_DEFAULT_TO, 'customerservice@davisdelivery.com');
  if (prev !== undefined) process.env.NOTIFY_CS_TO = prev;
});

test('csRecipients: blank/whitespace NOTIFY_CS_TO also falls back (not an empty recipient list)', () => {
  const prev = process.env.NOTIFY_CS_TO;
  process.env.NOTIFY_CS_TO = '  ,  , ';
  assert.deepEqual(csRecipients(), [CS_DEFAULT_TO]);
  if (prev === undefined) delete process.env.NOTIFY_CS_TO; else process.env.NOTIFY_CS_TO = prev;
});
