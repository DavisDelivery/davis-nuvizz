// lib/mail-source.mts
//
// The one shape every mailbox adapter presents to the manifest ingest. Keeping
// it here (rather than in whichever adapter happened to be written first) means
// a new mailbox — Outlook, IMAP, a shared drive — is a new file that imports
// these types, and nothing in the ingest or the other adapters moves.
//
// The contract is deliberately three small steps, because each costs something
// different and the ingest wants to pay for them at different times:
//   list()        — cheap, once per cycle, every message the prefilter matched.
//   attachments() — OPTIONAL, and called only AFTER the already-seen marker
//                   check, so a mailbox that needs a second round-trip to
//                   enumerate attachments never spends it on an email we have
//                   already handled. Omit it when list() already fills them in.
//   download()    — the expensive one: the actual bytes, one PDF at a time.
//
// Errors are thrown, not returned. The ingest catches per message and leaves the
// email UNMARKED so the next cycle retries — the "fail toward retry" rule.

export interface MailAttachment {
  id: string;
  filename: string | null;
  contentType: string | null;
  /** Resend hands out a short-lived URL for the bytes; Gmail addresses them by
   *  id instead. Adapters that don't use URLs leave this null. */
  downloadUrl?: string | null;
}

export interface MailMessage {
  id: string;
  from: string;
  subject: string;
  attachments: MailAttachment[];
  /** WHEN THE MAILBOX RECEIVED IT, epoch ms. The ingest sorts on this so the NEWEST report
   *  of a night is filed LAST — see orderOldestFirst in manifest-email-ingest. Optional
   *  because a source may not expose it; an adapter that omits it gets id order, which is
   *  the behaviour that produced the bug this field exists to fix, so fill it in if you can. */
  receivedAt?: number | null;
}

export interface MailSource {
  /** Stable, lowercase; namespaces this mailbox's per-email markers and labels
   *  the stored run. Changing it re-processes that mailbox's backlog once. */
  name: string;
  list(): Promise<MailMessage[]>;
  attachments?(msg: MailMessage): Promise<MailAttachment[]>;
  download(msg: MailMessage, att: MailAttachment): Promise<Buffer | null>;
}
