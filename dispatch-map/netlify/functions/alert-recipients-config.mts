// alert-recipients-config.mts
//
// THE ENDPOINT BEHIND THE "WHO GETS ALERTED" PANEL ON DIAGNOSTICS.
//
// Chad, 2026-09-09: "we need to build a ui in the diagnostics where i can add more numbers or
// remove numbers from who gets texted same thing for emails."
//
// GET  → who each alert channel is currently going to, resolved exactly as the senders
//        resolve it, plus everything the screen needs to explain itself. Ungated, free,
//        ZERO NuVizz calls — it reads one Firestore document and the environment.
// POST → replace one or more channel lists. Admin only.
//
// THE GET IS THE FREE DIAGNOSTIC CLAUDE.md ASKS FOR. Before this existed, "am I on the text
// list?" could only be answered by opening the Netlify console, and "why did I not get that
// email?" could not be answered at all — which is precisely how an evening was lost in
// September on a mailer that was working perfectly. It is deliberately ungated for the same
// reason the scan-config GET is: the screen has to be able to render the current state to
// show anyone what would change, and this response carries no addresses that are not already
// visible to anyone with the app open. The POST — which changes who hears about freight
// about to be refused — is the half that gates.
//
// THE WRITE IS FIELD-MASKED AND PARTIAL. A body naming one channel edits one channel. Two
// people in two tabs editing two different lists both keep their edit; there is no
// read-merge-write window in which the second save deletes the first person's numbers.
//
// A REFUSED ENTRY COMES BACK BY NAME. `rejected` is per channel, with the reason, so the
// screen can say "678-555-01 is not a 10-digit US mobile" next to the field somebody typed it
// into. Nothing is dropped in silence — that is the whole rule this area is built around.
import { requireUser } from './lib/require-user.mts';
import { isFirestoreEnabled, readAlertRecipients, writeAlertRecipients } from './lib/firestore.mts';
import {
  RECIPIENT_CHANNELS, CHANNEL_KEYS, MAX_PER_CHANNEL, clampAlertRecipients, resolveAllChannels,
  ALERT_INTERNAL_SUFFIXES,
} from './lib/alert-recipients.mts';
import { emailEnabled } from './lib/email.mts';
import { smsEnabled } from './lib/sms.mts';

const J = (body: any, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
});

/**
 * The whole payload, built once so GET and POST cannot answer differently.
 *
 * `transports` is not decoration either. A perfectly good list of phone numbers sends nothing
 * when SIMPLETEXTING_API_KEY is unset or the deploy is a mirror, and a screen that shows the
 * list without showing that would be another way to look healthy while being silent.
 */
const payload = (stored: Record<string, any>, persistent: boolean, extra: any = {}) => ({
  ok: true,
  persistent,
  channels: resolveAllChannels(stored),
  stored,
  limits: { maxPerChannel: MAX_PER_CHANNEL, internalSuffixes: ALERT_INTERNAL_SUFFIXES },
  transports: { email: emailEnabled(), sms: smsEnabled() },
  updatedAt: stored?.updatedAt ?? null,
  updatedBy: stored?.updatedBy ?? null,
  ...extra,
});

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return J({ ok: true });

  // No Firestore (a preview build without FIREBASE_SA): still serve the resolved environment
  // lists so the panel renders and tells the truth about who is being alerted right now — it
  // simply cannot persist a change. A blank panel here would read as "nobody is alerted".
  if (!isFirestoreEnabled()) {
    return J(payload({}, false, {
      note: 'Firestore is not configured on this deploy — these lists come from environment variables and cannot be edited here.',
    }));
  }

  try {
    if (req.method === 'GET') {
      return J(payload(await readAlertRecipients(), true));
    }

    if (req.method === 'POST') {
      // Admin, because a POST here changes who finds out that a customer is about to be
      // missed — and, on the SMS channels, spends money at somebody's phone. Inert until
      // AUTH_REQUIRED=true on the site (lib/require-user.mts).
      const gate = await requireUser(req, { role: 'admin' });
      if (!gate.ok) return gate.response;

      let body: any;
      try { body = await req.json(); } catch { return J({ ok: false, error: 'invalid JSON' }, 400); }

      const named = CHANNEL_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(body ?? {}, k));
      if (!named.length) {
        return J({ ok: false, error: `name at least one channel to edit: ${CHANNEL_KEYS.join(', ')}` }, 400);
      }

      const { config, rejected } = clampAlertRecipients(body);

      // Stamped every write so the panel can say "edited 3 days ago" and, when somebody asks
      // why they stopped getting texts, there is a name against the change.
      const patch: Record<string, any> = {
        ...config,
        updatedAt: new Date().toISOString(),
        updatedBy: String(body?.updatedBy || gate.user?.username || 'diagnostics-ui').slice(0, 120),
      };
      await writeAlertRecipients(patch);

      // Re-read rather than echoing what we just sent. The response is what the panel replaces
      // its state with, so it has to be what the DOCUMENT says, not what this request hoped —
      // never report an intent as an outcome.
      const stored = await readAlertRecipients();
      return J(payload(stored, true, { saved: named, rejected }));
    }

    return J({ ok: false, error: 'GET or POST only' }, 405);
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'alert-recipients-config failed' }, 500);
  }
};

// Named for the tests, which assert the channel list the panel renders is the channel list
// the senders read — one registry, not two.
export { RECIPIENT_CHANNELS };
