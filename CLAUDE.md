# CLAUDE.md

Project-level guidance for Claude Code in this repository.

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
