# CLAUDE.md

Project-level guidance for Claude Code in this repository.

## NuVizz API — HARD RULE (cost control)

- **NEVER trigger a full / number-probe scan, or any forced/explicit
  re-scan, without explicit per-request permission from Chad.** A cold
  full scan (`nuvizz-manual-scan`, or `nuvizz-refresh-stops-background`
  / `runRefreshStops` invoked with `?date=`, `?days=`, or `manual=1`)
  number-probes the whole load-number window + unplanned descent and
  costs **~3,000 NuVizz calls**. The normal scheduled scans are the
  cheap **list-discovery** path (saved-search "planned/unplanned"
  pulls) and cost only **2–3 calls**.
- Do not call ANY NuVizz-hitting endpoint (manual scan, background
  refresh, live `?live=1` reads, or direct vendor calls) to "check" or
  "compare" data unless Chad explicitly says to in that request.
  Default to investigating in **code only**; if real numbers are
  needed, ask Chad for them rather than scanning.
- When a task seems to need fresh data, STOP and ask first — state the
  expected call cost — instead of scanning. **Ask; do not guess.** This rule
  forbids spending calls, not asking for them — see *ASK FOR THE CALL* below,
  which exists because I read it the wrong way for a whole evening.

## ASK FOR THE CALL. NEVER GUESS INSTEAD. (Chad, Sep 2026)

- Chad, after an evening of it: **"you can always ask for a call instead of
  just wasting my time guessing at things."**
- The cost rule above says never spend a NuVizz call without permission. It
  has never said to GUESS instead, and reading it that way is how a whole
  evening gets burned. **Asking is always available, always cheap, and always
  better than a confident wrong answer.** "May I spend one call on X?" is a
  complete, correct, professional answer. Four paragraphs of inference is not.
- **What this cost, on 2026-09-05, in one sitting.** Chad reported his empty
  loads missing. I answered four times without the one fact that decided it:
  first that nothing of mine was deployed (true, and irrelevant), then that
  NuVizz probably had no loads for Tuesday yet (a guess), then a scan-cadence
  fix (wrong thing — he said so), then a weekend carve-out he explicitly did
  not want (**and it merged and went live before he could stop it, so he had
  to be told to revert something already running**). The actual bug was a
  dedup discarding the evening roster pull. **One call, or one look at the
  cached roster document, would have pointed at it in the first reply.** He
  said "you are fixing the wrong thing" twice before I stopped.
- **The asymmetry is not close.** One list call is ~1 of a 2,000/day ceiling
  and takes a second. A wrong diagnosis costs Chad's evening, and it can SHIP
  — a guess that reaches main is a change he has to notice, reverse and
  re-verify on his own dispatch board.
- **What to do instead, every time the answer depends on data not in the
  repo:** say so in one line, name the exact endpoint and parameters, state
  the call cost, say precisely what the result would settle — then STOP and
  wait. Do not "proceed under the assumption" and do not bury the ask under a
  fix nobody asked for.

      I can't tell from the code whether the Sep 8 roster was captured.
      `nuvizz-load-columns?date=2026-09-08&confirm=1` is ONE call and
      returns the raw row/column count. Say the word and I'll run it.

- **Build the free diagnostic FIRST when one is possible.** Better than
  asking for a call is needing no call at all. Before guessing, ask whether a
  Firestore read, a stored summary, or a new `?explain=1` on an existing
  endpoint could answer it for nothing — and if so, build that and read it.
  The roster went four rounds undiagnosed because "the scan wrote nothing"
  and "the panel got nothing" were the same blank screen; a zero-cost
  `?explain=1` was ten minutes of work and should have been the first move.
  This is the same rule as **make it inspectable** below, arriving from the
  other direction.
- **A guess presented as a finding is the worst output this repo produces**
  (see the section below). "I cannot tell from here" is never a failure; it
  is the honest half of an answer, and the other half is the question.

## NEVER REASON AT ME — CHECK THE CODE (Chad, Aug 2026)

- Chad: **"I never want you to reason when giving me an answer. I always
  want you to have checked the code and give me factual answers."**
- Before answering ANY question about how this system behaves — what a rule
  does, why a flag fired, what a field holds, whether a job ran — **open the
  code, or query the live data, or run the function.** Then answer from what
  it returned. An answer that begins "it should" or "that would be" is not an
  answer; it is a guess wearing an answer's clothes, and it is worse than
  saying "let me check" because Chad cannot tell the two apart.
- **Run the case, do not describe it.** Asked whether a stop ten stops down an
  unassigned load flags at 7am, the right move is to build that load, call
  `computeBoardFlags`, and paste the card it produced. It took one command and
  turned a plausible yes into a verified one.
- **Measure before proposing a fix, and check the measurement.** The
  phantom-instance bug was first measured at 31 affected stops by a regex that
  collapsed `AVRT-0028093763` and `ESTES-0538243875` onto the bare strings
  "AVRT" and "ESTES" — so every carrier order looked like a sibling of every
  other. The real number was 6. Acting on the first figure would have silenced
  twelve live routed stops. A number is not a fact until the thing that
  produced it has been checked too.
- **Do not stack inference on inference.** "The browser is stale" was argued
  from a footer reading 302 open against a server reading 280 — two counts with
  different denominators, so the gap meant nothing. One reasoning step past the
  evidence had already produced a confident wrong diagnosis.
- **Never report an intent as an outcome.** "I flipped the switch" was said
  about an API call that had returned a 502. If the system did not observe it,
  the system may not claim it — and if the state cannot be read back, that is
  a bug to fix, not a thing to be careful about. A switch whose position cannot
  be read is not a switch.
- **When the answer genuinely is not knowable from here, say so and say what
  would settle it.** "I cannot tell from the code whether loads carry drivers
  overnight — that is a fact about how Davis dispatches" is a good answer.
  Inventing the probable one is not.
- Corollary: **a plausible story that fits the symptom is the most dangerous
  output this system produces.** METRO was declared correctly-silent because it
  had not been late — when in fact a human had found it on paper and moved it.
  The story fit every fact on screen and was still wrong.

## EVERY feature gets judged as a logistics professional FIRST (Chad, Aug 2026)

- Chad: **"every feature should be evaluated like you are a senior
  logistics professional."** Before any design work, before any code,
  ask what a person who has run a dock and a dispatch board would say
  about it.
- **The order is not decorative.** The engineering question is "does
  this work?" The logistics question is "is this the right thing to
  build, and does it match how freight actually moves?" A feature that
  is beautifully built and operationally wrong is a wasted week, and
  the engineering pass cannot catch that — it will happily test the
  wrong thing to four decimal places.
- What that lens actually asks:
  - **Who acts on this, and when?** A flag nobody can act on is
    decoration. A warning that arrives after the receiving window has
    shut cost more attention than it saved.
  - **What does the driver / dispatcher / customer service rep DO
    differently** because of it? If the answer is "nothing", stop.
  - **What is the real-world failure it prevents**, in freight terms —
    a refused delivery, a redelivery, a customer who stops calling.
  - **What does it cost when it is wrong in each direction?** Missing a
    real problem and crying wolf are rarely symmetrical, and the
    threshold belongs where the cheaper mistake is.
  - **Does it survive a bad day?** 700 stops, a driver out, carryover,
    a customer closed early. Design for that day, not the quiet one.
- **This is why v0.56.3 existed.** The alert was wired to `critical`
  only, which is defensible engineering — the top tier is the confident
  one. It is poor logistics: a stop nine minutes past a 2pm close is a
  phone call somebody can still make, and Chad had already SAID "we
  want every red." The screen and the inbox disagreed about the word
  urgent for weeks and no test could have caught it, because the code
  did exactly what it was told.
- Say the operational judgement out loud in the PR, not just the
  technical one. If the logistics answer and the engineering answer
  point different ways, that is the thing worth Chad's attention.

## Build it like a professional, not like a demo (Chad, Aug 2026)

- Chad: **"every feature should be designed and tested like you're a
  professional software engineer that specializes in building apps."**
- The standard, concretely:
  - **Pure core, thin edges.** The rules go in a testable module; the
    endpoint and the screen stay dumb. Every non-trivial decision in
    this repo that shipped broken shipped inside a handler nobody could
    unit-test.
  - **Tests pin the RULE, not the implementation.** Write the test that
    fails when the behaviour is wrong, and name the real-world event in
    the test name.
  - **Handle the empty, the absent and the malformed.** `Number(null)`
    is 0 and 0 is finite — that one shipped a customer-service email
    announcing a midnight deadline for a stop with no deadline at all.
  - **Never blind-write a document you do not own.** `setDoc` here
    REPLACES; use a field-masked write. A suppression flag written the
    lazy way takes the dispatcher's receiving hours with it.
  - **Two views, always.** Phone and desktop are separate work, and a
    screen added to one navigation and not the other is a screen that
    does not exist on a phone. It has shipped that way twice.
  - **Never report an intent as an outcome.** If the system did not
    observe it, the system may not claim it. A hardcoded "✅ routed to
    Google" ran for weeks and nobody could tell.
  - **Make it inspectable.** Every job that acts on its own needs a way
    to ask what it is about to do, without doing it. A dry run is part
    of the feature, not a nicety.
  - **Adversarially review before merge.** Have the change read back
    with the question "how does this fail silently?" That pass caught a
    test email that would have unsubscribed a real customer and an undo
    link that would have re-subscribed one.
- Report honestly. If a test fails, say so with the output; if a part
  is unfinished, name it. "Done" means verified.

## Merge it — do not ask (Chad, Aug 2026)

- Chad: **"add to the Claude.md file to merge everything auto."** Open
  the PR and let it land. Do not stop to ask "want me to merge?" and do
  not park finished work in draft waiting for a word that is not
  coming.
- **Green CI is still the gate.** Auto-merge means no human permission
  step, not no verification. A red build is a stop, and the
  drive-to-green posture applies: fix it and push, or say plainly what
  is blocking.
- **A decision that is Chad's does not hold the PR.** If something
  turns on a business judgement rather than a technical one — a policy
  exposure, a spend, a first email to 700 customers — merge it
  **inert behind a switch** and tell him what the switch is and what it
  costs to flip. That is what happened with the review follow-up
  mailer: shipped complete and disabled, one env var away, and he
  turned it on the same day. Holding the merge would have bought
  nothing and delayed everything else in the branch.
- The two things that still warrant asking first are unchanged and
  narrow: **a NuVizz scan** (see the cost rule above) and anything
  genuinely destructive or hard to reverse.

## NEVER enable PR auto-fix or PR watching (Chad, Aug 2026)

- Chad: **"Never enable PR auto-fix. Do not run /autofix-pr, do not
  subscribe to or 'watch' any PR for CI or review activity, and do not
  enable it when asked to 'monitor' a PR. Report status and stop."**
- Concretely, none of these, ever: `/autofix-pr`, `subscribe_pr_activity`,
  any "watch this PR" / "babysit the PR" / "keep an eye on CI" behaviour,
  and any self-scheduled check-in whose job is to re-poll a PR.
- **"Monitor this PR" does NOT mean subscribe.** It means look at the PR
  once, say what CI and the reviews currently say, and stop. If Chad
  wants another look he will ask for one.
- This **overrides the harness default**, which tells the agent to
  subscribe to every PR it opens and to keep driving it to green. When
  the two disagree, this file wins.
- **It does not change the merge rule above.** Open the PR, let it land,
  keep CI green while you are still working the branch. What is banned
  is the open-ended background subscription that wakes a session on
  every webhook long after the work is done — a stream of bot comments
  and check-run events nobody asked for, and an agent that keeps pushing
  at a branch Chad has moved on from.
- If a PR is red and you are done, **say so in the reply and stop**.
  A plain "CI is red on `smoke`, here is the failure" is what is wanted;
  a subscription that keeps retrying it is not.

## Version bump — EVERY merge (Chad, Aug 2026)

- **`APP_VERSION` in `dispatch-map/src/App.jsx` MUST be bumped in every
  change that gets merged.** Chad: "I just got a notification that the
  build has changed however the version at bottom did not — it should be
  part of the claude md file for this repo that it changes every time we
  merge."
- The version in the footer is how Chad tells whether the thing he is
  looking at is the thing that just deployed. A build that changes while
  the version does not makes that check useless: a stale cached page and
  a fresh one look identical, so "did my fix ship?" becomes unanswerable
  without digging through commits.
- This applies to EVERY merged change, including ones with no visible UI
  — a backend-only fix still produces a new deploy Chad gets told about.
- Bump the patch digit for ordinary work; minor for a new capability.
  Check `origin/main` for the current value FIRST — several sessions work
  in parallel and two branches claiming the same number collide at merge.
- Add a changelog row in the same edit, newest first, in the array
  directly below `APP_VERSION`. The row is what Chad reads to find out
  what changed; a bump with no row is half the job.
- **This is now enforced by CI, not by good intentions.** The
  `version-bump` job (`dispatch-map/scripts/check-version-bump.mjs`)
  fails any PR that touches shipping code without moving `APP_VERSION`
  and adding the matching row. It was added because the rule above was
  skipped twice on the morning it was written (#696, #697) — and #697
  was the last commit to reach production that day, so a deploy landed
  with the footer version unchanged, which is the precise thing this
  rule exists to prevent.
- **Merging is not shipping.** On 2026-08-19 production stopped taking
  main at 09:51 and five merges (v0.55.1 → .7) never went live, with
  every check green the whole time. The `deploy-watch` workflow now
  reads the version out of the LIVE bundle every 30 minutes and goes red
  when it disagrees with main. If you have merged something and Chad
  says he cannot see it, check what the site is actually serving
  (`node dispatch-map/scripts/check-deploy-fresh.mjs`) BEFORE assuming
  it is a browser cache — that check takes seconds and settles it.

## Mobile and desktop are TWO VIEWS (Chad, Aug 2026)

- **Every screen gets an individual mobile view and an individual desktop
  view.** Chad: "I've told you time and again that mobile and desktop
  should be treated as 2 different views and to quit trying to take the
  easy way out and make screens work for both." A shared layout with
  responsive patches is the easy way out; do not take it.
- **On a phone, overlay furniture lives in ONE flow container.** Never
  absolutely pin sibling controls at measured or guessed offsets — that
  architecture was collision-patched four separate times on the Map
  (v0.54.80, .82, the wrap fix, the flags-chip clip) and still put the
  draw buttons on top of the status card on 2026-08-19. In flow, when
  something grows or wraps, what is below it MOVES.
- A surface that is DESIGNED to cover the page (bottom sheet, resizable
  data grid) declares it with `data-overlay-layer` so the overlap guard
  knows it is deliberate.
- **The guard enforces this**: `verify-mobile-layout.mjs` fails CI when
  two reachable controls occupy the same pixels within one layer, on
  every screen at 390px and 360px. Do not weaken it to get green — fix
  the layout.

## Reports — always a PDF (Chad, Aug 2026)

- **Every report goes to Chad as a formatted PDF, never as raw
  Markdown and never as a `.md` file.** Chad: "stop giving me reports
  this way — all reports i want in an easy to read well formatted pdf."
  A `.md` file opens in a text editor showing `**bold**` and `##` as
  literal characters, which is unreadable.
- "Report" means any research, analysis, audit, comparison, findings
  write-up, or recommendation deliverable — anything longer than a chat
  answer. Short answers stay in chat as normal prose.
- Build it with `tools/report-pdf.py` (Markdown → styled HTML → PDF via
  headless Chromium). Write the content as Markdown, then render:

  ```bash
  python3 tools/report-pdf.py report.md "Some-Report.pdf" --title "Title" --subtitle "Subtitle"
  ```

- **Look at the rendered pages before sending** — render a few to PNG
  (`pypdfium2`) and actually read them. Catching a duplicated intro, a
  blank page, or bullets collapsed into a text run takes one minute and
  is the difference between a report and a mess.
- Send the PDF with SendUserFile. Keep the chat message a short summary
  of the findings; the PDF carries the detail.

## Response formatting

- Every coding response must be presented inside a wrapped window. In
  practice this means: wrap all code Claude shows the user in a fenced
  Markdown code block (```` ``` ````) with the appropriate language tag,
  so the renderer displays it in a bordered, scrollable/word-wrapped
  window rather than as inline prose.
- This applies to any response that includes code, shell commands,
  config snippets, diffs, or file contents — even short one-liners.
- When a response mixes explanation and code, keep the prose outside
  the fence and put only the code inside the fenced window.
- If multiple files or snippets are shown in one response, give each
  its own fenced window with the correct language tag.
- Prefer long lines that soft-wrap inside the window over manual line
  breaks that would distort the code.
