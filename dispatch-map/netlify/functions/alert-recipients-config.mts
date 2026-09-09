// alert-recipients-config.mts
//
// THE ENDPOINT BEHIND THE "WHO GETS ALERTED" PANEL ON DIAGNOSTICS.
//
// Chad, 2026-09-09: "we need to build a ui in the diagnostics where i can add more numbers or
// remove numbers from who gets texted same thing for emails."
//
// GET  → who each alert channel is currently going to, resolved exactly as the senders
//        resolve it, plus everything the screen needs to explain itself. Free, and ZERO
//        NuVizz calls — it reads one Firestore document and the environment.
// POST → replace one or more channel lists. Admin only.
//
// THE GET IS THE FREE DIAGNOSTIC CLAUDE.md ASKS FOR. Before this existed, "am I on the text
// list?" could only be answered by opening the Netlify console, and "why did I not get that
// email?" could not be answered at all — which is precisely how an evening was lost in
// September on a mailer that was working perfectly.
//
// AND IT IS GATED AT viewer, WHICH THE FIRST DRAFT OF THIS FILE GOT WRONG. It was left open on
// the scan-config precedent — the editor has to render to show anyone what would change — with
// the excuse that it "carries no addresses that are not already visible to anyone with the app
// open". That is true of customerservice@ and FALSE of a router's personal mobile, which until
// this feature existed lived only in the Netlify console. This repo has already written the
// rule down twice: driver-phone.mts gates a plain GET at viewer BECAUSE it turns a name into a
// personal number, and day-completion.mts reports only whether a recipient is set, with a test
// that greps the source to keep the address out of the response body. An unauthenticated
// endpoint returning every staff mobile in the company contradicts both — and this same change
// had to touch that day-completion block, which makes leaving it open harder to defend, not
// easier. A viewer is anyone signed in; the panel still renders for everybody who can open it.
//
// The POST — which changes who hears that freight is about to be refused, and spends money at
// somebody's phone — stays at admin. Both gates are inert until AUTH_REQUIRED=true on the site,
// which is the repo-wide posture and not this endpoint's decision to make.
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
  RECIPIENT_CHANNELS, CHANNEL_KEYS, MAX_PER_CHANNEL, MAX_LABEL_LEN, clampAlertRecipients,
  resolveAllChannels, resolveChannel, channelSpec, pruneLabels, ALERT_INTERNAL_SUFFIXES,
} from './lib/alert-recipients.mts';
import { emailEnabled } from './lib/email.mts';
import { smsEnabled } from './lib/sms.mts';

const J = (body: any, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
    // The body varies by caller now that the read is gated, so it must never be shared by a
    // cache — a refusal stored and served to a signed-in dispatcher, or worse the reverse.
    'Cache-Control': 'no-store',
    Vary: 'Authorization',
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
  // ONLY THE FIVE MANAGED KEYS. `stored` is the raw document, and under the live
  // firestore.rules that document is writable by anyone holding the web config out of the
  // public bundle — so echoing it whole would republish whatever an outside writer put on it,
  // beside the validated channels and looking just as official. The screen reads `channels`.
  stored: Object.fromEntries(
    [...CHANNEL_KEYS, 'labels'].filter((k) => k in (stored || {})).map((k) => [k, stored[k]]),
  ),
  limits: { maxPerChannel: MAX_PER_CHANNEL, maxLabelLen: MAX_LABEL_LEN, internalSuffixes: ALERT_INTERNAL_SUFFIXES },
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
      // Viewer: this response contains personal mobile numbers. See the header.
      const gate = await requireUser(req, { role: 'viewer' });
      if (!gate.ok) return gate.response;
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
      const namesEdited = Object.prototype.hasOwnProperty.call(body ?? {}, 'labels');
      if (!named.length && !namesEdited) {
        return J({ ok: false, error: `name at least one channel to edit: ${CHANNEL_KEYS.join(', ')}` }, 400);
      }

      const { config, rejected } = clampAlertRecipients(body);

      // Stamped every write so the panel can say "edited 3 days ago" and, when somebody asks
      // why they stopped getting texts, there is a name against the change.
      // THE NAMES ARE PRUNED AGAINST THE LISTS THIS WRITE LEAVES BEHIND, not against the ones
      // it arrived with — a name typed in the same save as its number would otherwise be
      // dropped before it was ever stored. So the post-write state is computed here first.
      const prior = namesEdited || named.length ? await readAlertRecipients().catch(() => ({})) : {};
      const after: Record<string, any> = { ...prior, ...config };
      const labelSource = namesEdited ? body.labels : (prior as any)?.labels;
      const labels = pruneLabels(
        labelSource,
        CHANNEL_KEYS.map((k) => resolveChannel(channelSpec(k)!, after).recipients),
      );

      const patch: Record<string, any> = {
        ...config,
        ...(namesEdited || Object.keys(labels).length !== Object.keys((prior as any)?.labels || {}).length
          ? { labels }
          : {}),
        updatedAt: new Date().toISOString(),
        // THE PRINCIPAL, NOT THE BODY. The panel renders this as "last changed … by X" — the
        // one line a dispatcher reads to find out who took them off a list — so a caller-
        // supplied string outranking the authenticated user makes an audit line into an
        // assertion by whoever made the request. Signed out, it says so.
        updatedBy: String(gate.user?.username || 'unauthenticated').slice(0, 120),
      };
      await writeAlertRecipients(patch);

      // Re-read rather than echoing what we just sent. The response is what the panel replaces
      // its state with, so it has to be what the DOCUMENT says, not what this request hoped —
      // never report an intent as an outcome.
      const stored = await readAlertRecipients();
      // WHAT WAS WRITTEN, not what the body mentioned. `named` counts keys present in the
      // request, and a key sent as null is a "leave it alone" that clampAlertRecipients drops —
      // so reporting `named` would tell the caller a channel had been saved when nothing was.
      // That is reporting an intent as an outcome, in the endpoint that re-reads the document
      // three lines up specifically to avoid doing that.
      return J(payload(stored, true, { saved: Object.keys(config), rejected, namesSaved: namesEdited }));
    }

    return J({ ok: false, error: 'GET or POST only' }, 405);
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'alert-recipients-config failed' }, 500);
  }
};

// Named for the tests, which assert the channel list the panel renders is the channel list
// the senders read — one registry, not two.
export { RECIPIENT_CHANNELS };
