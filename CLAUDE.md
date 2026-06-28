# CLAUDE.md

Project-level guidance for Claude Code in this repository.

## ⛔ HARD RULE — never trigger a NuVizz scan without explicit owner permission

This is the single most important rule in this repo and overrides convenience.

**No agent or automation — Claude Code (any session), the in-app "Debug this
view" coding-agent flow, a future live agent, scripts, anything — may trigger a
full NuVizz scan, or enable/instruct anything that does, without the repo
owner's (Chad's) explicit permission for that specific scan.** Ask every time; a
prior approval never carries over.

- **Why:** the `davis` NuVizz account has a runaway-call history (~1M+/day
  incident → NuVizz threatened to blacklist it; ~3,000 erroneous calls happened
  2026-06-28). Unsanctioned scans risk getting the account blacklisted, which
  takes the whole dispatch operation offline.
- **Never call or enable without an explicit OK:** `nuvizz-refresh-stops-background`,
  `nuvizz-manual-scan`, `nuvizz-att-scan-background`, the scheduled
  `fleet-refresh-background`, any `?live=1` scan path, or anything that hits
  `portal.nuvizz.com/deliverit/openapi/v7` to probe load/stop number ranges.
- **Reads are fine:** `nuvizz-pull-today-stops` (without `live=1`) only reads the
  cached Firestore stop index — it does NOT scan NuVizz. Cache reads, including
  `carryDays`, are safe.
- If a task seems to need fresher data, **ask Chad to run the scan** (or to enable
  scanning) — do not run or enable it yourself, and do not open a PR that does.

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
