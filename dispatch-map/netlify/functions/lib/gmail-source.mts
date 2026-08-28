// lib/gmail-source.mts
//
// ── THE NIGHTLY ULINE REPORT, READ OUT OF GMAIL ──────────────────────────────
//
// Chad: "write google mail into the app so we can parse for these manifests and
// look for any missing orders every night." The report lands in a Google mailbox,
// so this module is a MailSource over the Gmail API: list candidate messages,
// walk their MIME tree for PDF attachments, hand the bytes to the ingest. The
// ingest decides what any of it MEANS — this file only fetches.
//
// WHY OAUTH REFRESH-TOKEN, not a service account. Domain-wide delegation needs
// Workspace-admin consent and grants the app every mailbox in the domain. A
// refresh token minted once for the ONE mailbox that receives the report is the
// smaller blast radius, and it works on a plain @gmail.com account too. Scope
// gmail.readonly is enough: we never send, label, or delete.
//
// THE ONE CONFIGURATION THAT SILENTLY ROTS: an External consent screen left in
// "Testing" issues refresh tokens that expire after SEVEN DAYS. The check would
// run for a week and then stop with invalid_grant — the exact failure mode this
// whole feature exists to prevent, one level up. Use User type Internal (a
// Workspace mailbox) or publish the app to production. See .env.example.
//
// COST: zero NuVizz calls, by construction — nothing here can reach NuVizz. The
// Gmail API itself is free within a quota this uses a rounding error of (one list
// + one get per unseen message + one download per PDF, every 30 minutes).
//
// SELF-VALIDATING MATCH, same rule as the Resend path: the query below is only a
// cheap PREFILTER to keep the list small. It deliberately does NOT filter by
// sender or subject — a PDF that PARSES as a Uline freight report IS the report,
// and one that doesn't is marked ignored. So a forwarded copy, a re-send from a
// different address, or a subject-line change all still work.

import type { MailAttachment, MailMessage, MailSource } from './mail-source.mts';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';

/** Cheap prefilter, not a match rule. Overridable with GMAIL_QUERY. */
export const DEFAULT_GMAIL_QUERY = 'has:attachment filename:pdf newer_than:7d';
export const DEFAULT_MAX_RESULTS = 20;

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  user?: string;        // mailbox to read; 'me' = the token's own account
  query?: string;
  maxResults?: number;
}

/** Read the config out of the environment. Returns null when Gmail isn't set up,
 *  so an unconfigured deploy is a quiet no-op rather than an error. */
export function gmailConfigFromEnv(env: Record<string, string | undefined> = process.env): GmailConfig | null {
  const clientId = String(env.GMAIL_CLIENT_ID || '').trim();
  const clientSecret = String(env.GMAIL_CLIENT_SECRET || '').trim();
  const refreshToken = String(env.GMAIL_REFRESH_TOKEN || '').trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return {
    clientId,
    clientSecret,
    refreshToken,
    user: String(env.GMAIL_USER || 'me').trim() || 'me',
    query: String(env.GMAIL_QUERY || '').trim() || DEFAULT_GMAIL_QUERY,
    maxResults: Math.max(1, Math.min(100, Number(env.GMAIL_MAX_RESULTS) || DEFAULT_MAX_RESULTS)),
  };
}

/** Exchange the long-lived refresh token for a short-lived access token.
 *  Throws with a readable message — the caller turns that into a per-source
 *  error so one broken mailbox never takes the whole cycle down. */
export async function getAccessToken(cfg: GmailConfig, fetchImpl: typeof fetch): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json: any = await resp.json().catch(() => null);
  if (!resp.ok || !json?.access_token) {
    // invalid_grant means the refresh token was revoked or expired (Google expires
    // them on password change, and after 6 months idle on unverified apps). Say so
    // in the summary instead of a bare 400, so the fix is obvious in the logs.
    const detail = String(json?.error || `http ${resp.status}`);
    throw new Error(`gmail auth failed: ${detail}`);
  }
  return String(json.access_token);
}

const headerValue = (headers: any[], name: string): string => {
  const hit = (Array.isArray(headers) ? headers : [])
    .find((h) => String(h?.name ?? '').toLowerCase() === name.toLowerCase());
  return String(hit?.value ?? '');
};

/**
 * Walk the MIME tree and collect every part that is a real attachment.
 * Gmail nests parts arbitrarily deep (multipart/mixed wrapping multipart/
 * alternative wrapping the actual file), so this recurses rather than reading
 * payload.parts one level down — a one-level read misses the report whenever the
 * sender's mailer adds a wrapper, which is exactly the silent-miss we're here to
 * prevent. A part counts as an attachment when it has a filename AND an
 * attachmentId; inline images without a filename are skipped.
 */
export function collectAttachments(payload: any): MailAttachment[] {
  const out: MailAttachment[] = [];
  const walk = (part: any) => {
    if (!part || typeof part !== 'object') return;
    const filename = String(part?.filename ?? '');
    const attachmentId = String(part?.body?.attachmentId ?? '');
    if (filename && attachmentId) {
      out.push({ id: attachmentId, filename, contentType: String(part?.mimeType ?? '') || null });
    }
    const parts = Array.isArray(part?.parts) ? part.parts : [];
    for (const p of parts) walk(p);
  };
  walk(payload);
  return out;
}

/** Gmail returns attachment bytes base64URL-encoded (-_ instead of +/), which
 *  Buffer's 'base64' decoder does not accept as-is. Translating first is the
 *  difference between a valid PDF and bytes that fail the %PDF check. */
export function decodeBase64Url(data: string): Buffer {
  const norm = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(norm, 'base64');
}

/**
 * Build the Gmail MailSource. The access token is fetched once per cycle and
 * memoised for the life of this object — a cycle is seconds long and the token
 * lives an hour, so refreshing per request would be pure waste.
 */
export function gmailSource(cfg: GmailConfig, fetchImpl: typeof fetch): MailSource {
  const user = encodeURIComponent(cfg.user || 'me');
  let tokenPromise: Promise<string> | null = null;
  const token = () => (tokenPromise ||= getAccessToken(cfg, fetchImpl));

  const api = async (path: string): Promise<any> => {
    const t = await token();
    const resp = await fetchImpl(`${GMAIL_BASE}${path}`, { headers: { Authorization: `Bearer ${t}` } });
    if (!resp.ok) throw new Error(`gmail ${path.split('?')[0]} ${resp.status}`);
    return resp.json();
  };

  return {
    name: 'gmail',

    async list(): Promise<MailMessage[]> {
      const q = encodeURIComponent(cfg.query || DEFAULT_GMAIL_QUERY);
      const max = cfg.maxResults || DEFAULT_MAX_RESULTS;
      const listed: any = await api(`/users/${user}/messages?q=${q}&maxResults=${max}`);
      // No matches at all: Gmail omits `messages` entirely rather than sending [].
      const ids: string[] = (Array.isArray(listed?.messages) ? listed.messages : [])
        .map((m: any) => String(m?.id ?? '')).filter(Boolean);
      if (!ids.length) return [];

      // The list call returns ids only; headers and the MIME tree need a get per
      // message. metadata format won't do — we need payload.parts for attachments.
      const msgs: MailMessage[] = [];
      for (const id of ids) {
        try {
          const full: any = await api(`/users/${user}/messages/${encodeURIComponent(id)}?format=full`);
          const headers = full?.payload?.headers || [];
          msgs.push({
            id: String(full?.id ?? id),
            from: headerValue(headers, 'From'),
            subject: headerValue(headers, 'Subject'),
            attachments: collectAttachments(full?.payload),
            // Gmail's own receive time, epoch ms as a string. The ingest orders on it.
            receivedAt: Number(full?.internalDate) || null,
          });
        } catch {
          // One unreadable message must not blind the cycle to the rest. Skipping
          // it here leaves it unmarked, so the next cycle tries it again.
        }
      }
      return msgs;
    },

    async download(msg: MailMessage, att: MailAttachment): Promise<Buffer | null> {
      const got: any = await api(
        `/users/${user}/messages/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(att.id)}`,
      );
      const data = String(got?.data ?? '');
      if (!data) return null;
      return decodeBase64Url(data);
    },
  };
}
