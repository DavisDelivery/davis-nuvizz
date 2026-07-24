// test/presence.test.mjs — pure multi-dispatcher presence helpers (v0.51.0):
// device identity, peer staleness, cross-device staged-stop claims, chip label,
// and the peer-save refresh trigger.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  newDeviceId, defaultDeviceName, loadDeviceIdentity, saveDeviceName,
  activePeers, buildPeerClaims, peerChipLabel, latestPeerSaveAt,
  PRESENCE_STALE_MS,
} from '../src/lib/presence.js';

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _map: m,
  };
}

test('loadDeviceIdentity: creates a stable id once and derives a default name', () => {
  const s = memStorage();
  const a = loadDeviceIdentity(s);
  assert.ok(a.id.length > 6);
  assert.equal(a.name, defaultDeviceName(a.id));
  // Second load on the same device returns the SAME id (stability is the point).
  const b = loadDeviceIdentity(s);
  assert.equal(b.id, a.id);
});

test('loadDeviceIdentity: a saved name wins over the default; broken storage still yields an identity', () => {
  const s = memStorage();
  const a = loadDeviceIdentity(s);
  saveDeviceName(s, '  Chad  ');
  assert.equal(loadDeviceIdentity(s).name, 'Chad');
  assert.equal(loadDeviceIdentity(s).id, a.id);
  // No storage at all (private mode / SSR) — still usable, never throws.
  const bare = loadDeviceIdentity(null);
  assert.ok(bare.id && bare.name);
});

test('newDeviceId: distinct across calls', () => {
  assert.notEqual(newDeviceId(), newDeviceId());
});

test('activePeers: drops self, stale heartbeats, and malformed docs', () => {
  const now = 1_000_000_000;
  const docs = [
    { deviceId: 'me', name: 'Me', updatedAt: now },                              // self — dropped
    { deviceId: 'p1', name: 'Alex', updatedAt: now - 5000 },                     // fresh — kept
    { deviceId: 'p2', name: 'Stale', updatedAt: now - PRESENCE_STALE_MS - 1 },   // stale — dropped
    { deviceId: 'p3', name: 'NoStamp' },                                         // malformed — dropped
    null,                                                                        // malformed — dropped
  ];
  const peers = activePeers(docs, 'me', now);
  assert.deepEqual(peers.map((p) => p.deviceId), ['p1']);
});

test('buildPeerClaims: claims only same-date staged stops; first peer wins a tie', () => {
  const peers = [
    { deviceId: 'p1', name: 'Alex', stagedDate: '2026-07-24', staged: ['101', 102] },
    { deviceId: 'p2', name: 'Sam', stagedDate: '2026-07-24', staged: ['102', '103'] },
    { deviceId: 'p3', name: 'Old', stagedDate: '2026-07-23', staged: ['999'] },   // other day — no claim
  ];
  const claims = buildPeerClaims(peers, '2026-07-24');
  assert.equal(claims.get('101'), 'Alex');
  assert.equal(claims.get('102'), 'Alex');   // tie → first peer
  assert.equal(claims.get('103'), 'Sam');
  assert.equal(claims.has('999'), false);
  // Numeric stopNbrs land as string keys (board ids are compared as strings).
  assert.equal(claims.get('102'), 'Alex');
});

test('buildPeerClaims: nameless peer still claims under a readable fallback', () => {
  const claims = buildPeerClaims([{ deviceId: 'p', stagedDate: 'd', staged: ['7'] }], 'd');
  assert.equal(claims.get('7'), 'another dispatcher');
});

test('peerChipLabel: null when alone; name + screen + staged count for one peer; count for several', () => {
  assert.equal(peerChipLabel([]), null);
  assert.equal(
    peerChipLabel([{ name: 'Alex', screen: 'routing', staged: ['1', '2'] }]),
    'Alex is on · Routing · staging 2 stops',
  );
  assert.equal(peerChipLabel([{ name: 'Alex', screen: 'map', staged: [] }]), 'Alex is on · Map');
  assert.equal(peerChipLabel([{ name: 'A' }, { name: 'B' }]), '2 other dispatchers on');
});

test('latestPeerSaveAt: newest stamp across peers, 0 when none', () => {
  assert.equal(latestPeerSaveAt([]), 0);
  assert.equal(latestPeerSaveAt([{ saveAt: 5 }, { saveAt: 9 }, { saveAt: 'x' }, {}]), 9);
});
