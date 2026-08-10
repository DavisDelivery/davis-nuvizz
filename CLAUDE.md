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
  expected call cost — instead of scanning.

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
