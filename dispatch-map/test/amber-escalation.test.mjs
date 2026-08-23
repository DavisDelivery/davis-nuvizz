// THE EARLY WARNING MUST NOT BURN THE URGENT ONE.
//
// The alert claim is one document per stop per day. That was right while only red and
// critical could email: the tier ratchet means a stop that reaches red never comes back
// down, so the single message it earns IS the urgent one. The amber lead gate breaks that
// assumption — with the gate on, the FIRST message a stop earns is the early,
// inside-the-error-band one, and the escalation to critical then finds the claim taken and
// sends nothing. Customer service would hear "we may run close, 10 minutes late" and never
// hear that the truck is now 105 minutes late: the mild message arrives, the actionable one
// does not, and that is worse than the silence it replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendAlerts, alertClaimPath, alertBandOf, buildAlert } from '../netlify/functions/lib/flag-alert.mts';

const cand = (over = {}) => ({
  stopNbr: 'S1', customer: 'ACME', route: 'BEN 2', closeMin: 14 * 60,
  etaMin: 14 * 60 + 10, lateBy: 10, tier: 'amber', anchored: false, detail: '', rule: 'hours_risk', ...over,
});
const runner = () => {
  const claims = new Set(); const sent = [];
  return {
    claims, sent,
    io: {
      createDocIfAbsent: async (p) => (claims.has(p) ? false : (claims.add(p), true)),
      send: async (m) => { sent.push(m); return { ok: true }; },
    },
  };
};

test('an amber heads-up does NOT consume the urgent message the stop later earns', async () => {
  const r = runner();
  const a = await sendAlerts([cand()], '2026-08-17', 'davis', r.io);
  assert.equal(a.sent, 1, 'the early warning goes out');
  const b = await sendAlerts([cand({ tier: 'critical', lateBy: 105, etaMin: 15 * 60 + 45 })], '2026-08-17', 'davis', r.io);
  assert.equal(b.sent, 1, 'and the escalation is still allowed to go out');
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[1].subject, /Receiving window at risk/, 'the second one is the urgent wording');
});

test('but a stop cannot email every sweep — each band sends at most once a day', async () => {
  const r = runner();
  await sendAlerts([cand()], '2026-08-17', 'davis', r.io);
  const again = await sendAlerts([cand({ lateBy: 15 })], '2026-08-17', 'davis', r.io);
  assert.equal(again.sent, 0, 'a second amber is refused');
  assert.equal(again.skippedAlreadySent, 1);

  await sendAlerts([cand({ tier: 'red', lateBy: 100 })], '2026-08-17', 'davis', r.io);
  const escAgain = await sendAlerts([cand({ tier: 'critical', lateBy: 200 })], '2026-08-17', 'davis', r.io);
  assert.equal(escAgain.sent, 0, 'red and critical share the urgent band — one message, not two');
});

test('the urgent claim keeps its ORIGINAL key, so flipping the gate cannot re-send today', () => {
  assert.equal(alertClaimPath('davis', '2026-08-17', 'S1'), alertClaimPath('davis', '2026-08-17', 'S1', 'urgent'));
  assert.notEqual(alertClaimPath('davis', '2026-08-17', 'S1', 'early'), alertClaimPath('davis', '2026-08-17', 'S1', 'urgent'));
  assert.equal(alertBandOf('amber'), 'early');
  for (const t of ['red', 'critical']) assert.equal(alertBandOf(t), 'urgent');
});

// AN EARLY WARNING MUST NOT WEAR A CONFIRMED MISS'S CLOTHES. Amber means the overrun is
// INSIDE the model's error band — board-flags says "the model simply cannot tell late from
// on-time" at that distance. A rep who chases two 3-minute ambers, finds the truck on time,
// and is told nothing distinguished them learns to discount the whole channel.
test('an amber email says early warning; a critical one says predicted to miss', () => {
  const early = buildAlert(cand({ lateBy: 3, etaMin: 14 * 60 + 3 }), '2026-08-17');
  assert.match(early.subject, /Heads-up/);
  assert.match(early.text, /early warning, not a confirmed miss/);
  assert.doesNotMatch(early.text, /confidently late/, 'amber must never claim confidence it does not have');
  assert.match(early.html, /early warning/i);

  const urgent = buildAlert(cand({ tier: 'critical', lateBy: 115 }), '2026-08-17');
  assert.match(urgent.subject, /Receiving window at risk/);
  assert.match(urgent.text, /is predicted to miss its receiving window/);
  assert.match(urgent.text, /confidently late/);
});

// THE BANDS MUST ARRIVE IN ORDER — red-then-amber must not invert them. The ratchet
// normally prevents a demotion, but an R6 card leaves no history row for the tier floor,
// so a stop CAN present amber after its urgent email already went. Sending the soft
// message second would read as reassurance and promise a follow-up that cannot come.
test('an early heads-up is refused once the urgent message has already gone', async () => {
  const r = runner();
  const io = { ...r.io, exists: async (p) => r.claims.has(p) };
  await sendAlerts([cand({ tier: 'critical', lateBy: 120 })], '2026-08-17', 'davis', io);
  const after = await sendAlerts([cand({ lateBy: 15 })], '2026-08-17', 'davis', io);
  assert.equal(after.sent, 0, 'the reassuring message must not follow the loud one');
  assert.equal(r.sent.length, 1);
});

// "EMAILED CS" MEANS AN URGENT MESSAGE ACTUALLY WENT. A failed send used to become
// emailed:true one sweep later (the claim blocked the retry and !won re-added the stop),
// so the audit column said "we told them" about a stop nobody was ever told about.
test('a failed urgent send is not recorded as emailed — this sweep or the next', async () => {
  const claims = new Set();
  const io = {
    createDocIfAbsent: async (p) => (claims.has(p) ? false : (claims.add(p), true)),
    send: async () => ({ ok: false }),                      // Resend is down
  };
  const a = await sendAlerts([cand({ tier: 'red', lateBy: 60 })], '2026-08-17', 'davis', io);
  assert.equal(a.emailedStops.size, 0, 'nothing was sent, so nothing reads as emailed');
  const b = await sendAlerts([cand({ tier: 'red', lateBy: 70 })], '2026-08-17', 'davis', io);
  assert.equal(b.emailedStops.size, 0, 'and the lost claim race must not resurrect the lie');
});

test('an early send never satisfies the "Emailed CS" column — that field means the urgent alert', async () => {
  const r = runner();
  const a = await sendAlerts([cand()], '2026-08-17', 'davis', r.io);   // amber heads-up, succeeds
  assert.equal(a.sent, 1);
  assert.equal(a.emailedStops.size, 0, 'the soft message must not stand in for the loud one');
});
