// open-orders-email.mts — the dry run of the 5:30p open-orders email. Sends nothing.
//
// A scheduled function is not reachable over plain HTTP in this app, so "what would 5:30 send,
// and would it send right now?" is answered here: the same builder (lib/open-orders.mts) over
// the same board, the same send decision, and who it would go to. Zero NuVizz calls.
//
//   /.netlify/functions/open-orders-email                 today, summary + decision
//   /.netlify/functions/open-orders-email?date=YYYY-MM-DD another day's board
//   /.netlify/functions/open-orders-email?email=1         + the subject and text it would send
import { isFirestoreEnabled, readStops, etDayString, getDoc, readScanKindStamps, readAlertRecipients } from './lib/firestore.mts';
import { recipientsFor } from './lib/alert-recipients.mts';
import { emailEnabled } from './lib/email.mts';
import { buildOpenOrders, sendDecision, openOrdersSubject, openOrdersText, openOrdersPath, openOrdersEmailEnabled, etClock, etTime, boardAsOf } from './lib/open-orders.mts';
import { requireUser } from './lib/require-user.mts';

const TENANT = 'davis';

export default async (req: Request): Promise<Response> => {
  const J = (b: any, s = 200) => new Response(JSON.stringify(b, null, 1), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=60', Vary: 'Authorization' },
  });
  const gate = await requireUser(req, { role: 'viewer' });
  if (!gate.ok) return gate.response;
  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);
  try {
    const url = new URL(req.url);
    const now = new Date();
    const date = url.searchParams.get('date') || etDayString(now);
    const { stops } = await readStops(TENANT, date);
    const report = buildOpenOrders(stops || [], { date });
    const stamps = await readScanKindStamps().catch(() => ({} as Record<string, string>));
    const record = await getDoc(openOrdersPath(date)).catch(() => null);
    const { hour, minute, weekday } = etClock(now);
    let stored: any = null;
    let recipientStoreError: string | null = null;
    try { stored = await readAlertRecipients(); } catch (e: any) { recipientStoreError = String(e?.message || e); }
    const asOf = etTime(boardAsOf(stamps));
    return J({
      ok: true, dryRun: true, date,
      planned: report.planned, delivered: report.delivered, openCount: report.open.length,
      excludedRoutes: report.excludedRoutes,
      open: report.open,
      boardAsOf: asOf,
      record,
      wouldDoNow: date === etDayString(now)
        ? sendDecision({ weekday, hour, minute, nowMs: now.getTime(), stamps, alreadySent: !!record?.sentAt })
        : null,
      delivery: {
        enabled: openOrdersEmailEnabled(), switch: 'OPEN_ORDERS_EMAIL',
        emailConfigured: emailEnabled(),
        recipientCount: recipientsFor('openOrdersTo', stored).length,
        ...(recipientStoreError ? { recipientStoreError } : {}),
      },
      ...(url.searchParams.get('email') === '1'
        ? { emailPreview: { subject: openOrdersSubject(report), text: openOrdersText(report, asOf) } }
        : {}),
    });
  } catch (e: any) {
    return J({ ok: false, error: String(e?.message || e) }, 500);
  }
};
