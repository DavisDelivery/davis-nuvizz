// scripts/lib/stop-lookup-fixture.mjs — ONE fixture for the Stop lookup screen, shared by
// every layout guard.
//
// Extracted rather than copied, for the same reason layout-measure.mjs was: the phone guard
// and the tablet guard both drive this screen, and two copies of a hundred-line fixture is
// two guards that slowly stop testing the same thing. A screen measured against tidy data on
// one device and hostile data on another is a screen only half guarded.
//
// STOP LOOKUP — one order's whole Firestore footprint. Seeded with the WORST rows rather
// than tidy ones, per the phone guard's own rule: a 44-character business name, an
// address that wraps twice at 360px, four days including an ATTEMPT (which renders a
// second driver line), an address diff, a notes card with three flags, a customer card of
// tappable PROs, the write journal and the source ledger. An empty screen cannot overflow,
// so a thin stub would make this guard pass by rendering nothing.
export const STOP_LOOKUP_DOSSIER = {
    ok: true, nuvizzCalls: 0, mode: 'stop', kind: 'stop', today: '2026-09-18',
    candidates: ['007174397', '7174397'], proIndex: true,
    window: { from: '2026-09-04', to: '2026-09-21', daysBack: 14, daysAhead: 3, pointerDays: ['2026-09-15'] },
    errors: {},
    dossier: {
      query: '007174397', kind: 'stop', found: true,
      identity: {
        query: '007174397', pro: '007174397', stopNbr: '007174397',
        name: 'TITAN ELECTRIC COMPANIES QTS DATA CENTER',
        address: { addr1: '3190 REPS MILLER RD BUILDING 400 SUITE 200', addr2: 'DOCK 7 REAR', city: 'PEACHTREE CORNERS', state: 'GA', zip: '30092' },
        matchKey: 'titan|3190|norcross', asOf: '2026-09-17',
        refs: { pro: '007174397', stopNbr: '007174397', shipmentNbr: 'ATT007174397', po: 'PO-99120-REV-C', custRef: 'CR-7741', bol: 'BOL-3319', orderNbr: 'L-551202' },
      },
      counts: { days: 4, delivered: 1, attempts: 1, exceptions: 1, sealed: 2, onBoard: 2 },
      firstSeen: '2026-09-12', lastSeen: '2026-09-17', latest: null,
      days: [
        { date: '2026-09-17', sources: ['sealed', 'board'], outcome: 'delivered', status: 'DELIVERED',
          route: 'PEACHTREE CORNERS 2', driver: 'ANDERSON FRIMPONG', currentDriver: null, seq: 11, planned: true,
          deliveredAt: '2026-09-17T14:19', arrivedAt: '2026-09-17T14:02',
          address: { addr1: '3190 REPS MILLER RD BUILDING 400 SUITE 200', addr2: 'DOCK 7 REAR', city: 'PEACHTREE CORNERS', state: 'GA', zip: '30092' },
          name: 'TITAN ELECTRIC COMPANIES QTS DATA CENTER', pieces: 4, pallets: 1, weight: 860, pod: 2, lines: 6,
          refs: { pro: '007174397', stopNbr: '007174397', shipmentNbr: null, po: 'PO-99120-REV-C', custRef: 'CR-7741', bol: 'BOL-3319', orderNbr: 'L-551202' },
          matchKey: 'titan|3190|norcross', scannedAt: null, capturedAt: '2026-09-18T04:10:00Z' },
        { date: '2026-09-16', sources: ['board', 'plan', 'attempt'], outcome: 'attempted', status: 'SCHEDULED',
          route: 'PEACHTREE CORNERS 2', driver: 'ROBERT MENSAH-ADDAI', currentDriver: 'SIRDEDRICK SHEATS', seq: 4, planned: true,
          deliveredAt: null, arrivedAt: '2026-09-16T16:41',
          address: { addr1: '3190 REPS MILLER RD BUILDING 400 SUITE 200', addr2: 'DOCK 7 REAR', city: 'PEACHTREE CORNERS', state: 'GA', zip: '30092' },
          name: 'TITAN ELECTRIC COMPANIES QTS DATA CENTER', pieces: 4, pallets: 1, weight: 860, pod: 0, lines: 0,
          refs: { pro: '007174397', stopNbr: '007174397', shipmentNbr: 'ATT007174397', po: null, custRef: null, bol: null, orderNbr: null },
          matchKey: 'titan|3190|norcross', scannedAt: '2026-09-16T20:02:00Z', capturedAt: null },
        { date: '2026-09-15', sources: ['sealed'], outcome: 'exception', status: 'EXCEPTION',
          route: 'NOR 2', driver: 'ENOCK AKYEA', currentDriver: null, seq: 7, planned: true,
          deliveredAt: null, arrivedAt: '2026-09-15T17:55',
          address: { addr1: '5965 PEACHTREE CORS E STE B3', addr2: null, city: 'NORCROSS', state: 'GA', zip: '30071' },
          name: 'TITAN ELECTRIC COMPANIES QTS DATA CENTER', pieces: 4, pallets: null, weight: 860, pod: 0, lines: 6,
          refs: { pro: '007174397', stopNbr: '007174397', shipmentNbr: null, po: null, custRef: null, bol: null, orderNbr: null },
          matchKey: 'titan|3190|norcross', scannedAt: null, capturedAt: '2026-09-16T04:10:00Z' },
        { date: '2026-09-12', sources: ['board'], outcome: 'rolled', status: 'SCHEDULED',
          route: null, driver: null, currentDriver: null, seq: null, planned: false,
          deliveredAt: null, arrivedAt: null, address: null,
          name: 'TITAN ELECTRIC COMPANIES QTS DATA CENTER', pieces: null, pallets: null, weight: null, pod: 0, lines: 0,
          refs: { pro: '007174397', stopNbr: '007174397', shipmentNbr: null, po: null, custRef: null, bol: null, orderNbr: null },
          matchKey: null, scannedAt: '2026-09-12T19:30:00Z', capturedAt: null },
      ],
      addressChanges: [
        { at: '2026-09-16T11:13:18Z', date: '2026-09-16', stopNbr: '007174397', businessName: 'TITAN ELECTRIC COMPANIES QTS DATA CENTER',
          source: 'scan', kind: 'moved', fields: ['addr1', 'city', 'zip'], planned: true, route: 'PEACHTREE CORNERS 2', nuvizz: null,
          before: { addr1: '5965 PEACHTREE CORS E STE B3', addr2: null, city: 'NORCROSS', state: 'GA', zip: '30071' },
          after: { addr1: '3190 REPS MILLER RD BUILDING 400 SUITE 200', addr2: 'DOCK 7 REAR', city: 'PEACHTREE CORNERS', state: 'GA', zip: '30092' } },
      ],
      writes: [
        { at: '2026-09-17T12:04:00Z', op: 'planStops', status: 'ok', summary: 'DAVIS000203707: ok (board patched 30)' },
        { at: '2026-09-16T18:40:00Z', op: 'unplanStops', status: 'failed', summary: 'DAVIS000203707: FAILED — load is already dispatched and cannot be edited' },
      ],
      notes: {
        text: 'Inside delivery to DOCK 7 at the REAR of building 400 — the front lobby will refuse it. Ring the bell and wait; receiving is one person.',
        hours: null, customerNbr: 'TITAN-4471', updatedAt: '2026-09-16T15:20:00Z', updatedBy: 'dispatch', override: null,
        flags: [
          { key: 'no_tractor', label: 'No tractor — box truck only', tone: 'amber' },
          { key: 'notify_cs', label: 'Notify customer service', tone: 'amber' },
          { key: 'override', label: 'Address overridden here', tone: 'blue' },
        ],
        contacts: [{ name: 'RAY WHITTINGTON-BOYD', phone: '7705551212', email: 'receiving@titanelectric.example.com' }],
      },
      customer: {
        name: 'TITAN ELECTRIC COMPANIES QTS DATA CENTER', matchKey: 'titan|3190|norcross',
        pros: [
          { pro: '007100001', date: '2026-08-02', driver: 'FRANK OKINE' },
          { pro: '007100002', date: '2026-07-19', driver: 'ANDERSON FRIMPONG' },
          { pro: '007100003', date: '2026-06-28', driver: null },
        ],
      },
      sources: [
        { key: 'pros', label: 'PRO index', where: 'history_pros', note: 'which days this order was captured on', looked: true, count: 2, found: true },
        { key: 'sealed', label: 'Sealed history', where: 'history_days/…/stops', note: '6 days — 2 the PRO index pointed at, plus the last 4 nights', looked: true, count: 2, found: true },
        { key: 'board', label: "Today's board", where: 'nuvizz_stop_index/…/stops', note: '2026-09-04 → 2026-09-21', looked: true, count: 2, found: true },
        { key: 'attempts', label: 'Attempts', where: 'attempts/…/items', note: 'a redelivery marker on one of these days', looked: true, count: 1, found: true },
        { key: 'plans', label: 'Morning plan', where: 'att_plan/…/stops', note: 'who had it when the board froze at 8:30', looked: true, count: 1, found: true },
        { key: 'customer', label: 'Customer rollup', where: 'history_customers', note: "this customer's other deliveries", looked: true, count: 3, found: true },
        { key: 'notes', label: 'Dispatcher notes', where: 'customer_notes', note: 'notes, receiving hours, contacts, overrides', looked: true, count: 1, found: true },
        { key: 'address', label: 'Address changes', where: 'nuvizz_ops/addr_changes__…', note: '2026-09-04 → 2026-09-21', looked: true, count: 1, found: true },
        { key: 'writes', label: 'What we sent NuVizz', where: 'nuvizz_write_ops', note: 'saves and board syncs naming this order', looked: true, count: 2, found: true },
      ],
    },
    note: 'Firestore only — nothing here spent a NuVizz call.',
};
