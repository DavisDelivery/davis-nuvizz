// A REFUSED 6:30 REPORT EMAIL IS WRITTEN DOWN, NOT THROWN AWAY.
//
// A3-S15-11 (review 2026-09-03), re-checked at 0f2d50a: the RETRY half is fixed (#811 — the
// spare firing covers a day with no `sent` stamp). What was still missing is the failure
// itself. `if (!res.ok) out.emailError = res.error` put the mailer's answer only into a
// *-background function's response body, which Netlify discards; the file logged nothing and
// sendEmail logs nothing. So on the night the report does not arrive, "why" had no answer
// anywhere — the heartbeat proves the firing came, the missing `sent` proves nobody was told,
// and nothing said what the mailer returned.
//
// Now the refusal is recorded on the day's own record (field-masked — that document also
// carries the immutable 6:30 snapshot and the next day's reconciliation) and logged.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { dayCompletionPath, needsSending } from '../netlify/functions/lib/day-completion-store.mts';

// 22:31 UTC on 2026-09-10 is 6:31pm EDT — the primary firing.
const NOW = '2026-09-10T22:31:00Z';
const DATE = '2026-09-10';
const DAY = dayCompletionPath('davis', DATE);

function envForSend() {
  const keep = { RESEND_API_KEY: process.env.RESEND_API_KEY, RESEND_FROM: process.env.RESEND_FROM, DAY_REPORT_TO: process.env.DAY_REPORT_TO, DAY_REPORT_ENABLED: process.env.DAY_REPORT_ENABLED };
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_FROM = 'Reports <no-reply@example.com>';
  process.env.DAY_REPORT_TO = 'ops@example.com';
  delete process.env.DAY_REPORT_ENABLED;
  return () => { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

async function runEvening(resendAnswer) {
  const restoreEnv = envForSend();
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  const fake = installFirestoreFake({}, async (url) => {
    if (url.startsWith('https://api.resend.com/')) return resendAnswer();
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  try {
    const handler = (await import('../netlify/functions/day-completion-report-background.mts')).default;
    const r = await handler();
    return { fake, body: await r.json(), errs };
  } finally {
    mock.timers.reset();
    console.error = origErr;
    fake.restore();
    restoreEnv();
  }
}

test('a Resend refusal of the 6:30 report is recorded on that day\'s record and logged', async () => {
  const { fake, body, errs } = await runEvening(() => new Response('{"message":"Too many requests"}', { status: 429 }));
  assert.equal(body.firing, 'primary');
  assert.equal(body.emailed, false);

  const doc = fake.store.get(DAY);
  assert.ok(doc?.snapshot, 'the 6:30 snapshot was written');
  assert.equal(needsSending(doc), true, 'still owed — the spare firing will retry it');
  assert.ok(doc.lastSendFailure, 'the refusal is on the day\'s record, not only in a discarded response');
  assert.match(String(doc.lastSendFailure.error), /429/);
  assert.equal(doc.lastSendFailure.firing, 'primary');
  assert.ok(doc.lastSendFailure.at, 'with when it happened');

  const patch = (fake.log.patches || []).find((p) => p.path === DAY && p.mask.includes('lastSendFailure'));
  assert.ok(patch, 'written field-masked');
  assert.deepEqual(patch.mask, ['lastSendFailure'], 'touching nothing but the failure field');

  assert.ok(errs.some((l) => l.includes('[day-completion]') && l.includes(DATE) && /not sent/i.test(l)), 'and a log line says so');
  assert.ok(!errs.some((l) => l.includes('ops@example.com')), 'the log never carries the recipient address');
});

test('a confirmed send stamps `sent` and records no failure', async () => {
  const { fake, body } = await runEvening(() => new Response('{"id":"em_1"}', { status: 200 }));
  assert.equal(body.emailed, true);
  const doc = fake.store.get(DAY);
  assert.ok(doc?.sent?.at);
  assert.equal(doc.lastSendFailure, undefined);
});
