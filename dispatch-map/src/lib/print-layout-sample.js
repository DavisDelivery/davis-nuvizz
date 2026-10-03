// lib/print-layout-sample.js — THE MADE-UP ROUTE BEHIND "PREVIEW" ON DIAGNOSTICS → MANIFEST LAYOUT.
//
// Chad, 2026-10-03: "i want to be able to pick which version i'm running." Picking between two
// layouts by name is guessing; Preview shows either one, built by the real builders, without
// changing what anybody prints. It needs a route to draw, and it must not be one off today's
// board: a preview that happened to be a real customer's ticket would get printed and carried.
//
// NOTHING HERE IS A REAL ORDER. The names say SAMPLE, the phone numbers are 555-01xx, and the
// PRO numbers are zeros. The shape is a board row's (the fields ticketData reads), with the
// things the two layouts place differently on purpose: a long consignee name, a second address
// line, Uline's "SPL-INSTR-TEXT:" label on the notes, a pick-up, and two orders at one dock.
const ORIGIN = { name: 'SAMPLE SHIPPER', addr1: '100 SAMPLE PKWY', city: 'BUFORD', state: 'GA', zip: '30518' };
const note = (text, addedBy = 'SAMPLE') => ({ text, addedBy, addedOn: '2026-10-01T20:50:22Z' });

export const PRINT_LAYOUT_SAMPLE_STOPS = [
  {
    stopNbr: '000000001', bol: '100000001', stopType: 'DL', routeSeq: 1,
    routeName: 'SAMPLE ROUTE', driverName: 'SAMPLE DRIVER',
    businessName: 'SAMPLE OUTDOOR POWER', addr1: '2180 SAMPLE HWY', city: 'BUFORD', state: 'GA', zip: '30518',
    contact: { phone: '7705550142' },
    scheduledFrom: '2026-10-05T08:00:00', scheduledTo: '2026-10-05T17:00:00', plannedEtaDTTM: '2026-10-05T08:10:00',
    weight: 1240, volume: 0, cartons: 2, pallets: 2,
    stopDetails: [
      { product: 'S-4122', productIdentifier: '100000001-1', quantity: 1, weight: 640 },
      { product: 'H-1043', productIdentifier: '100000001-2', quantity: 1, weight: 600 },
    ],
    allComments: [note('SPL-INSTR-TEXT: NO APPT REQUIRED'), note('SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID'), note('TOTAL-AMOUNT : 59.29')],
    raw: { stop: { from: { address: ORIGIN } } },
  },
  {
    stopNbr: '000000002', bol: '100000002', stopType: 'DL', routeSeq: 2,
    routeName: 'SAMPLE ROUTE', driverName: 'SAMPLE DRIVER',
    businessName: 'SAMPLE MECHANICAL CONTRACTORS & SUPPLY', addr1: '1450 SAMPLE HWY NW', addr2: 'WAREHOUSE B - DOCK 4 AT REAR',
    city: 'GAINESVILLE', state: 'GA', zip: '30501',
    contact: { phone: '7705550119' },
    scheduledFrom: '2026-10-05T10:00:00', scheduledTo: '2026-10-05T14:00:00', plannedEtaDTTM: '2026-10-05T09:48:00',
    weight: 386, volume: 3, cartons: 1, pallets: 4,
    stopDetails: [
      { product: 'H-2731', productIdentifier: '100000002-1', quantity: 1, weight: 310 },
      { product: 'S-19307', productIdentifier: '100000002-2', quantity: 3, weight: 76 },
    ],
    allComments: [
      note('SPL-INSTR-TEXT: RESIDENTIAL DELIVERY'), note('SPL-INSTR-TEXT: STRAIGHT TRUCK ONLY'),
      note('SPL-INSTR-TEXT: LIFT GATE NEEDED'), note('SPL-INSTR-TEXT: CALL 30 MIN AHEAD'),
      note('CUSTOMER NOT HOME BEFORE 10 - CALL CELL', 'DISPATCH'),
    ],
    raw: { stop: { from: { address: ORIGIN } } },
  },
  {
    stopNbr: '000000003', bol: '100000003', stopType: 'DL', routeSeq: 2,
    routeName: 'SAMPLE ROUTE', driverName: 'SAMPLE DRIVER',
    businessName: 'SAMPLE MECHANICAL CONTRACTORS & SUPPLY', addr1: '1450 SAMPLE HWY NW', addr2: 'WAREHOUSE B - DOCK 4 AT REAR',
    city: 'GAINESVILLE', state: 'GA', zip: '30501',
    contact: { phone: '7705550119' },
    scheduledFrom: '2026-10-05T10:00:00', scheduledTo: '2026-10-05T14:00:00', plannedEtaDTTM: '2026-10-05T09:48:00',
    weight: 2110, volume: 0, cartons: 3, pallets: 3,
    stopDetails: [{ product: 'S-7712', productIdentifier: '100000003-1', quantity: 3, weight: 2110 }],
    allComments: [note('SPL-INSTR-TEXT: DOCK HIGH ONLY')],
    raw: { stop: { from: { address: ORIGIN } } },
  },
  {
    stopNbr: 'SAMPLE-0000000004', bol: '', stopType: 'PU', routeSeq: 3,
    routeName: 'SAMPLE ROUTE', driverName: 'SAMPLE DRIVER',
    businessName: 'SAMPLE TILE & STONE', addr1: '318 SAMPLE PARK RD', city: 'DAHLONEGA', state: 'GA', zip: '30533',
    contact: { phone: '7065550163' },
    scheduledFrom: '2026-10-05T07:00:00', scheduledTo: '2026-10-05T15:00:00', plannedEtaDTTM: '2026-10-05T11:20:00',
    weight: 905, volume: 0, cartons: 1, pallets: 1,
    stopDetails: [{ product: 'RETURN', productIdentifier: 'SAMPLE-0000000004-1', quantity: 1, weight: 905 }],
    allComments: [],
    raw: { stop: { from: { address: { name: 'SAMPLE TILE & STONE', addr1: '318 SAMPLE PARK RD', city: 'DAHLONEGA', state: 'GA', zip: '30533' } } } },
  },
];
