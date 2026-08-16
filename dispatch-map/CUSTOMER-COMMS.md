# Customer Communications — the delivery-complete email

The branded email Davis sends a customer when their freight is delivered, instead of
NuVizz's unbranded one. From our own system, replies reach a human, and it asks how the
delivery went.

**ZERO NuVizz calls.** The trigger is a stop the scans already wrote to the board cache
with `normalizedStatus === 'DELIVERED'`; the recipient comes off that same cached stop.
Nothing here touches the vendor — see CLAUDE.md.

## What is here

```
netlify/functions/lib/customer-comms.mts    config, ledger, recipient, template, send, sweep
netlify/functions/customer-comms-config.mts GET/PUT the settings
netlify/functions/customer-comms-log.mts    GET the send log + per-day status
netlify/functions/customer-comms-test.mts   preview, coverage, and one test send
test/customer-comms.test.mjs                28 pure tests
```

Two shared libs gained one additive helper each: `firestore.createDocIfAbsent` (the atomic
claim) and an optional `from` on `email.sendEmail` (unset ⇒ `RESEND_FROM`, so every existing
cs-notify send is unchanged).

## What is NOT here yet

1. **The scan hook.** `sweepDelivered(stops, date)` has no caller. It belongs beside the
   existing cs-notify hook in `lib/refresh-stops-core.mts` — at the **list-discovery** call
   site only (the production path), not the legacy number-probe one, wrapped in its own
   try/catch so a mail failure cannot break a scan.
2. **The UI tab.** `CustomerCommsScreen` plus entries in the phone More block and the
   desktop More dropdown. `App.jsx` is 1.67 MB; that edit wants its own commit, and it
   should bump `APP_VERSION`.
3. **The opt-out writer.** `customer_notes.comms_opt_out` and `comms_email` are read but
   nothing writes them — the notes editor has name/phone/role contacts and a `notify_cs`
   toggle, and no email field. The toggle lands with the UI half.
4. **A bulk `customer_notes` load in the sweep.** `sendForStop` does one `getDoc` per
   delivered stop, and a stop with no address returns *before* the claim — so it never
   enters the ledger and the read repeats on every scan. At ~15-minute scans and a few
   hundred deliveries that is thousands of reads a day, and the daily cap does not bound it
   because skipped stops cost no budget. Fix it the way `cs-notify` already does (one
   filtered query per sweep, threaded into the pure `chooseRecipient`) **before wiring the
   hook**, not after.

## Endpoints

```
GET      /.netlify/functions/customer-comms-config          → config, merge fields, effectiveFrom
PUT|POST /.netlify/functions/customer-comms-config          → { enabled, fromAddress, replyTo,
                                                                subjectTemplate, htmlTemplate, dailyCap }
                                                               needs the x-comms-token header

GET  /.netlify/functions/customer-comms-log?date=YYYY-MM-DD
GET  /.netlify/functions/customer-comms-log?days=7          → entries + totals + per-day status

GET  /.netlify/functions/customer-comms-test?preview=1&date=&pro=   renders, sends nothing
GET  /.netlify/functions/customer-comms-test?coverage=1&date=       how many stops have an address
POST /.netlify/functions/customer-comms-test?to=you@davisdelivery.com&pro=   one [TEST] email
```

## Before you turn it on

Work down this list. Step 2 is the one that decides whether the feature is worth having.

1. **Verify the sending domain in Resend** and point `RESEND_FROM` at the notifications
   address. Until then `emailEnabled()` is false, the config endpoint refuses to enable, and
   nothing can send. This is the same unverified-sender problem that has been swallowing the
   tracking site's review alerts.
2. **Measure coverage.** `GET customer-comms-test?coverage=1&date=<a past delivery date>`
   reports how many delivered stops actually have an address on file, and whether it came
   from the order or from a note. Firestore-only, zero NuVizz calls.
   An address only exists where the scan enriched the stop *and* the shipper filled in the
   optional consignee-email field, so this number may be low. **If it is near zero, this is a
   data-entry project before it is a code project** — the notes-editor email field (deferred
   item 3) is what fixes it.
3. **Look at the email.** `?preview=1` renders it from a real delivered stop. Then set
   `COMMS_ADMIN_TOKEN` (see below — without it the send returns 403) and
   `POST ?to=<your own address>` with an `x-comms-token` header; check it in Gmail *and*
   Outlook. Click the header logo
   and the "Rate this delivery" button — both point at `tracking.davisdelivery.com`, whose
   source lives in a different repo, so neither is verified from here. Both are fixable
   without a redeploy: the template lives in Firestore.
4. **Land the opt-out toggle** (deferred item 3). An opt-out you cannot honour is worse than
   no opt-out.
5. **Wire the hook** (deferred item 1), still with `enabled: false`. Watch the per-day status
   doc in the log endpoint: it will show `considered` and a `skipped` histogram without
   sending anything.
6. **Then** `PUT { enabled: true }`, leave `dailyCap` at 25 for the first day, and read the
   log the next morning before raising it.

## Safety properties — please preserve these in review

1. **Disabled by default.** The config endpoint refuses to enable when `RESEND_API_KEY` /
   `RESEND_FROM` are unset, so the switch can never read ON while every send silently skips.
2. **Claim before send, atomically.** The ledger entry is a Firestore create-if-absent whose
   precondition is evaluated inside the commit, so of two overlapping sweeps exactly one wins
   the claim and only the winner sends. A claim that cannot be written means **no send** —
   never a send without a durable claim. One email per delivery, ever.
3. **Keyed on `stopNbr`, not `pro`.** `pro` is not a pinned list field: enrichment can
   rewrite it without leading zeros, which would claim under one spelling and check under
   another. Leading zeros are stripped so both spellings collapse to one key.
4. **Daily cap**, default 25, clamped to 2000. A definitive Resend rejection releases its
   claim and costs no budget, so an outage cannot burn the day's cap on mail that never went
   out; five consecutive failures stop the sweep.
5. **Board-date freshness.** A sweep refuses any board older than yesterday. Nothing upstream
   bounds `?date=` — the refresh entrypoint takes it off the query string — so without this a
   single hand-typed date could mail customers about six-week-old deliveries.
6. **Never throws.** A mail failure must never break a scan (same contract as cs-notify).
7. **Template rendering is dumb substitution** — `{{field}}` and `{{#field}}…{{/field}}`, no
   expressions, no eval. The template is user-editable from the UI, so it must not be able to
   execute anything, and every merge value is HTML-escaped on the way in because it is
   shipper-typed data landing in someone's inbox.

## Environment

| Variable | Effect |
| --- | --- |
| `RESEND_API_KEY`, `RESEND_FROM` | Required to send anything (shared with cs-notify). |
| `COMMS_TEST_ALLOWED_TO` | Comma-separated addresses and/or `@domain` suffixes a **test** send may reach. Defaults to `@davisdelivery.com`. |
| `COMMS_ADMIN_TOKEN` | **Required to write or send.** The config write and the test send need it as an `x-comms-token` header (or `?token=`). Unset ⇒ both refuse with a 403 naming the variable. The read endpoints stay open. |

A note on that last one: this site has no login, so any token the UI holds ships in the
bundle. It stops a drive-by, not a determined attacker. Real auth is a site-wide decision,
not a decision for this feature.

It nonetheless fails **closed**, unlike the read-only functions next door, because the
config document persists. An unowned write puts a template, a sender and an `enabled` flag
into Firestore that outlive the deploy, and the first live sweep uses what is stored — not
the shipped defaults. "Ships disabled" is a property of `DEFAULT_CONFIG`, not of the state on
disk a month from now. So **set `COMMS_ADMIN_TOKEN` in the Netlify site env before step 3**;
until you do, the write and the test send return 403 and the coverage read still works.
