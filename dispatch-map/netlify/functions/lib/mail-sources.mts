// lib/mail-sources.mts
//
// WHICH MAILBOXES ARE SWITCHED ON, in one place.
//
// Two callers need the identical answer — the scheduled poll and the "Check
// email now" button on the Manifest check tab — and if they ever disagreed the
// button would be testing something other than what runs at night, which is the
// one thing a "check now" button must never do.
//
// Gmail can be configured two ways, and BOTH are honoured:
//   • GMAIL_REFRESH_TOKEN in the environment (v0.54.74's original path, minted
//     by hand). Checked FIRST, so an existing deploy's behaviour is unchanged.
//   • a grant obtained through the Connect Gmail button, sealed in Firestore.
// The env path winning matters: someone who has deliberately pinned a token in
// Netlify should not have it silently overridden by whatever was last clicked.

import type { MailSource } from './mail-source.mts';
import { resendSource } from './manifest-email-ingest.mts';
import { gmailConfigFromEnv, gmailSource, DEFAULT_GMAIL_QUERY, type GmailConfig } from './gmail-source.mts';
import { gmailOAuthConfig } from './gmail.mts';
import { loadGrant, readStatus, patchStatus } from './gmail-store.mts';

/** Blank/whitespace saved searches fall back to the shared default rather than
 *  searching the whole mailbox. */
export function normalizeQuery(q: any): string {
  const s = String(q ?? '').trim();
  return s || DEFAULT_GMAIL_QUERY;
}

/**
 * The Gmail config to poll with, or null when Gmail is not set up at all.
 * Env first (see above), then the stored grant.
 */
export async function resolveGmailConfig(): Promise<GmailConfig | null> {
  const fromEnv = gmailConfigFromEnv();
  if (fromEnv) return fromEnv;

  const oauth = gmailOAuthConfig();
  if (!oauth.configured) return null;
  const grant = await loadGrant().catch(() => null);
  if (!grant?.refreshToken) return null;

  const status = await readStatus().catch(() => null);
  return {
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
    refreshToken: grant.refreshToken,
    user: 'me',
    query: normalizeQuery(status?.query),
    maxResults: Math.max(1, Math.min(100, Number(process.env.GMAIL_MAX_RESULTS) || 20)),
  };
}

/** Every configured mailbox, plus a note per mailbox that is deliberately off —
 *  a cycle that polled nothing should be able to say WHY. */
export async function buildMailSources(fetchImpl: typeof fetch = fetch): Promise<{ sources: MailSource[]; off: string[] }> {
  const sources: MailSource[] = [];
  const off: string[] = [];

  if (process.env.RESEND_API_KEY) sources.push(resendSource(process.env.RESEND_API_KEY, fetchImpl));
  else off.push('resend: no RESEND_API_KEY');

  const gmailCfg = await resolveGmailConfig();
  if (gmailCfg) sources.push(gmailSource(gmailCfg, fetchImpl));
  else {
    off.push(gmailOAuthConfig().configured
      ? 'gmail: no mailbox connected — use Connect Gmail on the Manifest check tab'
      : 'gmail: no GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET');
  }

  return { sources, off };
}

/** PURE — one line of plain English for what a cycle did. Exported for tests. */
export function summarizeCycle(out: any): string {
  if (!out) return '';
  if (out.skipped) return String(out.skipped);
  const outcomes: any[] = Array.isArray(out.outcomes) ? out.outcomes : [];
  const checked = outcomes.filter((o) => o.outcome === 'checked').length;
  if (checked) return `${checked} freight report${checked === 1 ? '' : 's'} read and checked`;
  const retry = outcomes.filter((o) => o.outcome === 'retry').length;
  if (retry) return `${retry} message${retry === 1 ? '' : 's'} could not be read yet — will retry`;
  if (!out.inbox) return 'no matching email found';
  if (!outcomes.length) return `nothing new (${out.inbox} already-judged message${out.inbox === 1 ? '' : 's'} matched)`;
  return `${outcomes.length} new message${outcomes.length === 1 ? '' : 's'} looked at, no freight report among them`;
}

/** PURE — did the cycle fail in a way only RECONNECTING fixes? A lapsed or
 *  revoked refresh token fails every cycle forever, so the tab has to stop
 *  saying "connected" and start asking. Anything else is transient and must NOT
 *  nag the dispatcher into re-authorising for a blip. Exported for tests. */
export function gmailNeedsReconnect(errorText: any): boolean {
  const s = String(errorText ?? '');
  if (!/gmail:/i.test(s)) return false;
  return /invalid_grant|auth failed|unauthorized|401|403/i.test(s);
}

/**
 * Record what the last cycle did for a mailbox connected THROUGH THE TAB, so it
 * can show "last poll …" and flag a grant that has lapsed.
 *
 * No-op when Gmail is pinned by environment variable or absent: the tab does not
 * own those, and writing a status doc every 30 minutes for a mailbox nobody
 * connected from the UI is pure churn.
 */
export async function recordGmailRun(out: any): Promise<void> {
  if (gmailConfigFromEnv()) return;
  if (!(await loadGrant().catch(() => null))) return;
  const err = String(out?.error || '');
  const gmailErr = /gmail:/i.test(err) ? err.slice(err.search(/gmail:/i)) : '';
  await patchStatus({
    lastRunAt: new Date().toISOString(),
    lastRunSummary: gmailErr || summarizeCycle(out),
    needsReconnect: gmailNeedsReconnect(err),
  }).catch(() => { /* status is a convenience, never a reason to fail a cycle */ });
}
