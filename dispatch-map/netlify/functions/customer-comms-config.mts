// customer-comms-config.mts
//
// Read/write the customer delivery-email settings the Customer Communications tab
// edits: on/off, sender, reply-to, subject + HTML template, and the daily cap.
//
//   GET  /.netlify/functions/customer-comms-config   → current config (+ whether
//        Resend is actually configured on this site, so the UI can say WHY nothing
//        is sending instead of showing a switch that silently does nothing)
//   PUT  /.netlify/functions/customer-comms-config   → { enabled?, fromAddress?,
//   POST     replyTo?, subjectTemplate?, htmlTemplate?, dailyCap? }
//
// The write needs COMMS_ADMIN_TOKEN (x-comms-token header) and refuses without it. Every
// field is validated and bounded here rather than at the send, because this document IS
// what gets mailed to customers: an unbounded template or an address with a newline in it
// becomes a header injection or a silent config-only outage that only surfaces as failed
// sends hours later.
//
// ZERO NuVizz calls.

import { isFirestoreEnabled } from './lib/firestore.mts';
import { emailEnabled } from './lib/email.mts';
import {
  readConfig, writeConfig, DEFAULT_HTML, MERGE_FIELDS, adminTokenOk,
  clampDailyCap, isSenderAddress, isEmailAddress, MAX_HTML_TEMPLATE, MAX_SUBJECT,
} from './lib/customer-comms.mts';

export default async (req: Request): Promise<Response> => {
  const headers = { 'Content-Type': 'application/json' };
  const J = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers });

  if (!isFirestoreEnabled()) return J({ ok: false, error: 'FIREBASE_SA not set' }, 500);

  try {
    if (req.method === 'GET') {
      const cfg = await readConfig();
      return J({
        ok: true,
        config: cfg,
        fields: MERGE_FIELDS,
        defaultHtml: DEFAULT_HTML,
        // Surfaced so the tab can show "Resend not configured" rather than letting
        // someone flip Enabled on and wonder why no mail arrives.
        resendConfigured: emailEnabled(),
        // What an empty fromAddress resolves to, so the UI can show the real sender.
        effectiveFrom: cfg.fromAddress || process.env.RESEND_FROM || null,
      });
    }

    // PUT or POST. The settings siblings here (nuvizz-scan-config, routing-engine-tuning)
    // are GET/POST and the frontend has no PUT anywhere, so a PUT-only write would be the
    // one endpoint the UI cannot call with the verb it uses everywhere else.
    if (req.method === 'PUT' || req.method === 'POST') {
      if (!adminTokenOk(req)) {
        return J({ ok: false, error: 'not authorised — set COMMS_ADMIN_TOKEN on this site and send it as the x-comms-token header' }, 403);
      }

      const body = await req.json().catch(() => ({}));
      const patch: any = {};
      if (body.enabled !== undefined) patch.enabled = body.enabled === true;

      if (typeof body.fromAddress === 'string') {
        const v = body.fromAddress.trim();
        // '' is legal and means "use RESEND_FROM". Anything else must be a single
        // address, optionally with a display name.
        if (v && !isSenderAddress(v)) return J({ ok: false, error: 'fromAddress must be "name@domain" or "Name <name@domain>"' }, 400);
        patch.fromAddress = v;
      }
      if (typeof body.replyTo === 'string') {
        const v = body.replyTo.trim();
        if (v && !isEmailAddress(v)) return J({ ok: false, error: 'replyTo must be a single email address' }, 400);
        patch.replyTo = v;
      }
      if (typeof body.subjectTemplate === 'string') {
        if (body.subjectTemplate.length > MAX_SUBJECT) return J({ ok: false, error: `subjectTemplate must be <= ${MAX_SUBJECT} characters` }, 400);
        patch.subjectTemplate = body.subjectTemplate;
      }
      if (typeof body.htmlTemplate === 'string') {
        if (body.htmlTemplate.length > MAX_HTML_TEMPLATE) return J({ ok: false, error: `htmlTemplate must be <= ${MAX_HTML_TEMPLATE} bytes` }, 400);
        patch.htmlTemplate = body.htmlTemplate;
      }
      if (body.dailyCap !== undefined) {
        // Clamped, not just validated: a typo of 100000 in a text field should not be
        // the thing standing between you and 100,000 emails.
        const n = clampDailyCap(body.dailyCap);
        if (n === null) return J({ ok: false, error: 'dailyCap must be a number >= 0' }, 400);
        patch.dailyCap = n;
      }

      // Refuse to enable into a configuration that cannot send. Otherwise the switch
      // reads ON while every stop silently skips with email_not_configured.
      if (patch.enabled === true && !emailEnabled()) {
        return J({ ok: false, error: 'Cannot enable: RESEND_API_KEY / RESEND_FROM are not set on this site.' }, 400);
      }

      const cfg = await writeConfig(patch);
      return J({ ok: true, config: cfg, resendConfigured: emailEnabled() });
    }

    return J({ ok: false, error: 'method not allowed — use GET to read, PUT or POST to write' }, 405);
  } catch (e: any) {
    return J({ ok: false, error: e?.message || 'failed' }, 500);
  }
};
