// A MIRROR DEPLOY MAY NOT REACH THE OUTSIDE WORLD.
//
// Chad: "nothing we do in UAT writes to the production version of the site."
//
// The repo already had the right primitive and used it for exactly one thing. isMirrorDeploy()
// keyed on FIRESTORE_DATABASE and made a mirror stop SCANNING — but every outbound door was
// left keyed on nothing but the presence of an API key, and a mirror is built by COPYING
// production's env. So the UAT site could mail a real customer about a real delivery, text a
// real driver from the real Davis number, and dispatch a real load in production NuVizz.
//
// These tests are written against the ENV, because that is the whole mechanism: the bug was
// never a wrong branch, it was a door nobody put a lock on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMirrorDeploy, firestoreDatabaseName, allowedOutbound, outboundAllowed,
  outboundRefusal, outboundGate, OUTBOUND_CHANNELS,
} from '../netlify/functions/lib/mirror-guard.mts';

const PROD = {};
const MIRROR = { FIRESTORE_DATABASE: 'uat-mirror' };

test('production is a deploy with no named database, and nothing about it changes', () => {
  assert.equal(firestoreDatabaseName(PROD), '(default)');
  assert.equal(isMirrorDeploy(PROD), false);
  for (const c of OUTBOUND_CHANNELS) {
    assert.equal(outboundAllowed(c, PROD), true, `${c} must be untouched in production`);
  }
  // An explicitly empty value is still production — Netlify hands back '' for an unset var.
  assert.equal(isMirrorDeploy({ FIRESTORE_DATABASE: '' }), false);
  assert.equal(isMirrorDeploy({ FIRESTORE_DATABASE: '   ' }), false);
  assert.equal(isMirrorDeploy({ FIRESTORE_DATABASE: '(default)' }), false);
});

test('a mirror sends NOTHING by default — email, SMS and NuVizz writes are all shut', () => {
  assert.equal(isMirrorDeploy(MIRROR), true);
  for (const c of OUTBOUND_CHANNELS) {
    assert.equal(outboundAllowed(c, MIRROR), false, `${c} must be shut on a mirror`);
  }
});

test('the three doors are named, and they are the three that leave the building', () => {
  // If a fourth outbound channel is added, it belongs here — this list is the review surface.
  assert.deepEqual([...OUTBOUND_CHANNELS].sort(), ['email', 'nuvizz-write', 'sms']);
});

test('the escape hatch opens ONE channel at a time, by name', () => {
  const env = { ...MIRROR, MIRROR_ALLOW_OUTBOUND: 'email' };
  assert.equal(outboundAllowed('email', env), true);
  assert.equal(outboundAllowed('sms', env), false);
  assert.equal(outboundAllowed('nuvizz-write', env), false);
});

test('several channels, any spacing and casing, and "all"', () => {
  const many = { ...MIRROR, MIRROR_ALLOW_OUTBOUND: ' Email , NUVIZZ-WRITE ' };
  assert.deepEqual([...allowedOutbound(many)].sort(), ['email', 'nuvizz-write']);
  const all = { ...MIRROR, MIRROR_ALLOW_OUTBOUND: 'all' };
  for (const c of OUTBOUND_CHANNELS) assert.equal(outboundAllowed(c, all), true);
});

test('A TYPO FAILS CLOSED — the channel stays shut rather than opening everything', () => {
  // The anti-convention this repo exists to avoid: a missing or malformed value must never be
  // the permissive one. The NuVizz breaker was changed to default ENFORCE for exactly this.
  for (const raw of ['emial', 'e-mail', 'text', 'ALL ', 'true', '1', 'yes', 'nuvizz_write']) {
    const env = { ...MIRROR, MIRROR_ALLOW_OUTBOUND: raw };
    for (const c of OUTBOUND_CHANNELS) {
      if (raw === 'ALL ') continue;  // trimmed+lowercased to 'all' on purpose — checked below
      assert.equal(outboundAllowed(c, env), false, `${raw} must not open ${c}`);
    }
  }
  assert.equal(outboundAllowed('email', { ...MIRROR, MIRROR_ALLOW_OUTBOUND: 'ALL ' }), true);
  // A known channel beside an unknown one opens only the known one.
  const mixed = { ...MIRROR, MIRROR_ALLOW_OUTBOUND: 'sms,carrier-pigeon' };
  assert.equal(outboundAllowed('sms', mixed), true);
  assert.equal(outboundAllowed('email', mixed), false);
});

test('MIRROR_ALLOW_OUTBOUND does nothing in production — it cannot turn anything OFF', () => {
  // It is an opener, not a switch. A stray value on the production site must not mute the
  // customer mailer; that would be this bug with the sign flipped.
  const env = { MIRROR_ALLOW_OUTBOUND: 'email' };
  for (const c of OUTBOUND_CHANNELS) assert.equal(outboundAllowed(c, env), true);
});

test('a refusal says WHERE it came from, WHAT it blocked, and the way through', () => {
  // A silent no-op is indistinguishable from a broken feature — which is the exact failure
  // this file is modelled on: a UAT scan nobody had switched off, 109 calls a day, with the
  // kill switch reading {env: false, config: false}.
  const msg = outboundRefusal('sms', MIRROR);
  assert.match(msg, /uat-mirror/, 'name the deploy');
  assert.match(msg, /SMS/, 'name the channel in words a human uses');
  assert.match(msg, /MIRROR_ALLOW_OUTBOUND=sms/, 'name the way through');
  assert.match(outboundRefusal('nuvizz-write', MIRROR), /NuVizz writes/);
  assert.match(outboundRefusal('email', MIRROR), /email/);
});

test('outboundGate hands back both answers, and no reason when allowed', () => {
  assert.deepEqual(outboundGate('email', PROD), { allowed: true, reason: null });
  const g = outboundGate('email', MIRROR);
  assert.equal(g.allowed, false);
  assert.match(g.reason, /MIRROR_ALLOW_OUTBOUND=email/);
});

test('ANY named database is a mirror — not just the one we happen to call uat-mirror', () => {
  // A second mirror ("staging", "demo") must be born silent too, without a code change.
  for (const name of ['uat-mirror', 'staging', 'demo', 'scratch-db']) {
    assert.equal(isMirrorDeploy({ FIRESTORE_DATABASE: name }), true, name);
    assert.equal(outboundAllowed('nuvizz-write', { FIRESTORE_DATABASE: name }), false, name);
  }
});

test('WIRING: all three doors actually consult the guard, at the gate AND at the send', async () => {
  // The rule is only worth as much as its call sites. Two of the three had a second entry
  // point that never asked the "enabled" question — a guard that can be walked past by
  // forgetting to call it is not a guard.
  const { readFile } = await import('node:fs/promises');
  const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
  // The guard line must appear INSIDE the named function, not merely somewhere in the file.
  const bodyOf = (src, header) => {
    const at = src.indexOf(header);
    assert.notEqual(at, -1, `could not find ${header}`);
    const end = src.indexOf('\n}', at);
    return src.slice(at, end === -1 ? at + 2000 : end);
  };

  const email = await read('../netlify/functions/lib/email.mts');
  assert.match(bodyOf(email, 'export function emailEnabled'), /if \(!outboundAllowed\('email'\)\) return false;/,
    'emailEnabled must be shut on a mirror');
  assert.match(bodyOf(email, 'export async function sendEmail'), /if \(!outboundAllowed\('email'\)\) return \{ ok: false, error: outboundRefusal\('email'\) \};/,
    'sendEmail itself must refuse, for callers that never asked');

  const sms = await read('../netlify/functions/lib/sms.mts');
  assert.match(bodyOf(sms, 'export function smsEnabled'), /if \(!outboundAllowed\('sms'\)\) return false;/,
    'smsEnabled must be shut on a mirror');
  assert.match(bodyOf(sms, 'export async function sendSms'), /if \(!outboundAllowed\('sms'\)\) return \{ ok: false, error: outboundRefusal\('sms'\) \};/,
    'sendSms itself must refuse');

  const write = await read('../netlify/functions/nuvizz-write.mts');
  assert.match(bodyOf(write, 'function writeEnabled'), /if \(!outboundAllowed\('nuvizz-write'\)\) return false;/,
    'the NuVizz write door must be shut on a mirror — this is the one with a truck on the end of it');

  // And ONE definition of "mirror", so the read gate and the send gates cannot drift apart.
  const scan = await read('../netlify/functions/lib/nuvizz-scan.mts');
  // The RULE is "one definition of mirror", not "one import specifier": nuvizz-scan now also
  // pulls mirrorScansAllowed from the same module (the UAT read switch), which is the same
  // rule being obeyed, not broken. So match the NAME in the import/export lists rather than
  // the exact line — and assert the thing that was actually being defended, which the old
  // literal never checked: that this file does not DEFINE its own copy.
  assert.match(scan, /import \{[^}]*\bisMirrorDeploy\b[^}]*\} from '\.\/mirror-guard\.mts';/,
    'nuvizz-scan must import the shared predicate, not keep a second copy');
  assert.match(scan, /export \{[^}]*\bisMirrorDeploy\b[^}]*\};/, 'and re-export it so every existing caller is unchanged');
  assert.doesNotMatch(scan, /(export\s+)?function isMirrorDeploy\b/,
    'and must never grow its own definition — two answers to "is this a mirror" is the drift this guards');
});
