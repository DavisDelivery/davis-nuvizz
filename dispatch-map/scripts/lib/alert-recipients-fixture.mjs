// scripts/lib/alert-recipients-fixture.mjs
//
// THE ALERT RECIPIENTS PANEL, POPULATED — for every layout guard at once.
//
// WHY THIS FILE EXISTS. On 2026-09-10 Chad asked for "a place in the ui to put the name of who
// that number belongs to". That box had shipped in v1.0.0 and was rendering correctly at 390,
// 360 and 1440 — verified in a browser. What had NEVER been verified is that it renders at
// all, because no guard had a stub for alert-recipients-config: the mobile and tablet sweeps
// fall through to a generic `{ ok: true, stops: [], ... }`, and the desktop sweep routes
// nothing, so all three were measuring the panel's ERROR STATE ("the alert service answered
// without its lists"). Ten nodes and no controls. Every recipient row, every name box, every
// add field and the Save button were outside the reach of the guard written to catch exactly
// this class of defect — on the one screen in the app that edits who gets phoned at 6am.
//
// A guard measuring an empty state is worse than no guard: it reports green and teaches
// everyone that the screen is covered.
//
// THE NUMBERS AND ADDRESSES ARE FICTIONAL, DELIBERATELY. 555-01xx is the reserved range and
// the mailboxes are role words at example.com. Phone numbers here are personal data
// (lib/flag-sms.mts says so in as many words) and a fixture is a file in a public repository —
// the same rule that took real numbers out of the flag-sms tests. The first draft of this file
// used the company domain and a real first name, and BOTH repo guards caught it: Netlify's
// secrets scan reads a company-domain address as an env-var value and fails the production
// deploy while CI stays green, and a lowercase owner first name collides with the spelling
// the secrets scanner matches (OWNER_ROUTE_NAMES, src/lib/board-flags.js).
//
// The shape is the endpoint's own: channels resolved exactly as resolveAllChannels() returns
// them, so a change to that contract breaks the fixture rather than quietly drifting from it.
const sms = (key, label, when, extra = {}) => ({
  key, kind: 'sms', label, when, envVar: key === 'flagSmsTo' ? 'FLAG_SMS_TO' : 'FLAG_SMS_TO_NIGHT',
  alwaysAlso: null, floorWhenEmpty: null, floorApplied: false,
  emptyNote: 'Nobody is texted. The sweep still runs and still records what it found.',
  note: null, goesToLabel: null, envRejected: [], envWarned: [], savedRejected: [],
  ...extra,
});

export const ALERT_RECIPIENTS_FIXTURE = {
  ok: true,
  persistent: true,
  channels: [
    sms('flagSmsTo', 'Flag texts',
      'Every evening and overnight sweep, 8:00p–7:00a ET, when a stop looks like it will miss its window or is on the wrong truck.',
      {
        recipients: ['4045550148'], list: ['4045550148'], source: 'env',
        names: { 4045550148: 'Dispatch lead' },
        note: 'One text per person, per flagged stop — up to 8 a sweep. A four-name list is four texts for every problem found.',
      }),
    // TWO NUMBERS, ONE NAMED AND ONE NOT — so the guard measures a filled row AND an empty
    // one. They are different widths and only the empty one carries the placeholder.
    sms('flagSmsToNight', 'Flag texts — the router on duty',
      'Added to the list above from 7:00p ET, and dropped at 6:00a ET sharp. For whoever is building tomorrow’s loads tonight.',
      {
        recipients: ['4045550177', '7705550163'], list: ['4045550177', '7705550163'], source: 'saved',
        names: { 4045550177: 'Night router' },
        emptyNote: 'Nobody extra overnight. The list above is still texted.',
        goesToLabel: 'Also texted, 7:00p–5:59a only',
      }),
    {
      key: 'alertCc', kind: 'email', label: 'Miss-window email',
      when: 'Weekdays 7:00a–8:00p ET, the first time a stop goes critical — one email per stop per day.',
      envVar: 'ALERT_CC', recipients: ['customerservice@davisdelivery.com', 'ops@example.com'],
      list: ['ops@example.com'], source: 'saved', alwaysAlso: 'customerservice@davisdelivery.com',
      floorWhenEmpty: null, floorApplied: false,
      emptyNote: 'Customer service alone, which is how this alert worked before anyone else was added.',
      note: 'Everyone here is emailed on the same visible To: line as customer service.',
      goesToLabel: null, names: {}, envRejected: [], envWarned: [], savedRejected: [],
    },
    {
      key: 'notifyCsTo', kind: 'email', label: 'Marked-customer notice',
      when: 'Whenever a customer marked “email customer service” turns up on a board.',
      envVar: 'NOTIFY_CS_TO', recipients: ['customerservice@davisdelivery.com'],
      list: ['customerservice@davisdelivery.com'], source: 'env', alwaysAlso: null,
      floorWhenEmpty: 'customerservice@davisdelivery.com', floorApplied: false,
      emptyNote: 'Falls back to customer service. This notice is addressed TO the desk that acts on it.',
      goesToLabel: null, names: {}, envRejected: [], envWarned: [], savedRejected: [],
    },
    {
      key: 'dayReportTo', kind: 'email', label: 'End-of-day report',
      when: '6:30p ET every day — what got delivered, what did not, and what is carrying over.',
      envVar: 'DAY_REPORT_TO', recipients: ['inbox@example.com'], list: ['inbox@example.com'],
      source: 'env', alwaysAlso: null, floorWhenEmpty: null, floorApplied: false,
      emptyNote: 'The report is still built and stored; nobody is mailed a copy.',
      goesToLabel: null, names: {}, envRejected: [], envWarned: [], savedRejected: [],
    },
  ],
  stored: { flagSmsToNight: ['4045550177', '7705550163'], alertCc: ['ops@example.com'], labels: { 4045550148: 'Dispatch lead', 4045550177: 'Night router' } },
  limits: { maxPerChannel: 25, maxLabelLen: 40, internalSuffixes: ['@davisdelivery.com'] },
  transports: { email: true, sms: true },
  updatedAt: '2026-09-09T13:41:58.687Z',
  updatedBy: 'dispatcher',
};

// The evening sweep's own record, in the state that prompted all of this: a 6:00a fire, two
// texts, and the overnight list cut off. The panel draws a line from it, so the guard must
// measure the card WITH that line rather than the shorter card without it.
export const FLAG_EVENING_STATUS_FIXTURE = {
  ok: true, date: '2026-09-10', texted: 2, claims: [],
  lastSweep: {
    at: '2026-09-10T10:00:50.736Z', etMin: 360, recipients: 1, recipientStore: 'env',
    standingCount: 1, nightCount: 2, nightRode: false,
    textsSilenced: false, smsEnabled: true, sent: 2, failed: 0, alreadyClaimed: 0,
  },
  note: 'lastSweep is the MOST RECENT fire only',
};

/** Both fixtures, matched by URL. Returns null when this request is not one of ours. */
export function alertRecipientsStub(url) {
  if (url.includes('alert-recipients-config')) return ALERT_RECIPIENTS_FIXTURE;
  if (url.includes('flag-evening-status')) return FLAG_EVENING_STATUS_FIXTURE;
  return null;
}
