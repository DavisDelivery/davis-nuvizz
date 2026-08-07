#!/usr/bin/env python3
"""Render a markdown report into a typeset PDF via headless Chromium.

Design goals: a report you can read on a laptop or print, not a wall of text.
- Cover block with title, subtitle and date.
- Each numbered feature becomes a card with a big numeral and a coloured rule.
- The bold lead-ins the report uses ("What it does.", "Effort: M.") become labelled
  rows so the eye can jump straight to the part it wants.
- Risk bullets get a muted panel; the "start here" section gets an accent panel.
- Sources become a compact two-column list so they don't eat three pages.
"""
import argparse
import html
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import markdown

ap = argparse.ArgumentParser(description='Render a Markdown report as a formatted PDF.')
ap.add_argument('src', help='source .md file')
ap.add_argument('out', nargs='?', default=None, help='output .pdf (default: alongside the source)')
ap.add_argument('--title', default=None, help='cover title (default: the file\'s first H1)')
ap.add_argument('--subtitle', default='')
ap.add_argument('--date', default=datetime.now().strftime('%B %Y'))
ap.add_argument('--kicker', default='Report')
ap.add_argument('--footnote', default='', help='small line under the date on the cover')
ap.add_argument('--chrome', default=os.environ.get('CHROMIUM_PATH',
                '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'))
args = ap.parse_args()

SRC = Path(args.src)
OUT = Path(args.out) if args.out else SRC.with_suffix('.pdf')
CHROME = args.chrome

raw = SRC.read_text()

# Title falls back to the document's own H1 so a report never ships untitled.
h1 = re.search(r'^# (.+)$', raw, flags=re.M)
TITLE = args.title or (h1.group(1).strip() if h1 else SRC.stem.replace('-', ' ').title())
SUBTITLE = args.subtitle
DATE = args.date

# Drop the report's own H1/subtitle/date-ish preamble — the cover block replaces it.
raw = re.sub(r'^# .*?\n', '', raw, count=1)
raw = re.sub(r'^\*Ranked for.*?\*\n', '', raw, count=1, flags=re.M)
# …and its own "A note on how I ranked these" paragraph, which the cover lede restates.
raw = re.sub(r'^A note on how I ranked these\..*?(?=\n\n)', '', raw, count=1, flags=re.S | re.M)

# The source writes risk bullets directly under the bold lead-in with no blank line, so the
# markdown parser swallows them into that paragraph as literal "- " text. Give every such run
# the blank line it needs to become a real list.
lines, fixed = raw.split('\n'), []
for i, ln in enumerate(lines):
    if ln.startswith('- ') and fixed and fixed[-1].strip() and not fixed[-1].startswith('- '):
        fixed.append('')
    fixed.append(ln)
raw = '\n'.join(fixed)

md = markdown.Markdown(extensions=['extra', 'sane_lists'])
body = md.convert(raw)

# ── structure passes ────────────────────────────────────────────────────────
# 1. "## 4. Real reason codes…" → a card header carrying its own numeral.
def card_header(m):
    num, title = m.group(1), m.group(2)
    return (f'</section><section class="card">'
            f'<h2><span class="num">{num}</span><span class="ct">{title}</span></h2>')

body = re.sub(r'<h2>(\d+)\.\s*(.*?)</h2>', card_header, body)

# 2. Section headers that are not numbered cards (Where to start, Sources, …).
body = re.sub(r'<h1>(.*?)</h1>', r'</section><section class="band"><h1>\1</h1>', body)

# 3. Bold lead-ins at the start of a paragraph become a labelled row.
LABELS = ('What it does', 'Who ships it', 'Why it matters for Davis', "What we'd build",
          'What we would build', 'Effort', 'Risks and dependencies')
def lead_in(m):
    label, rest = m.group(1), m.group(2)
    base = label.split(':')[0].strip().rstrip('.')
    if base not in LABELS:
        return m.group(0)
    extra = label[len(base):].lstrip(':. ')
    cls = 'row effort' if base == 'Effort' else 'row'
    tail = f'<b class="eff">{html.escape(extra.rstrip(". "))}</b> ' if extra else ''
    return f'<p class="{cls}"><span class="lbl">{base}</span><span class="val">{tail}{rest}'

body = re.sub(r'<p><strong>(.*?)</strong>\s*(.*)', lead_in, body)
body = re.sub(r'(<p class="row(?: effort)?">.*?)</p>', r'\1</span></p>', body, flags=re.S)

# 4. The bullet list that follows "Risks and dependencies" gets a muted panel.
body = re.sub(r'(<p class="row"><span class="lbl">Risks and dependencies</span>.*?</p>\s*)<ul>',
              r'\1<ul class="risks">', body, flags=re.S)

body = re.sub(r'<h3>\s*Sources\s*</h3>',
              '</section><section class="band sources"><h1>Sources</h1>', body)
body = body.replace('<hr />', '')
body = '<section class="card">' + body + '</section>'
body = body.replace('<section class="card"></section>', '')
body = re.sub(r'<section class="(card|band)">\s*</section>', '', body)

CSS = """
@page { size: Letter; margin: 16mm 15mm 18mm; }
@page { @bottom-right { content: counter(page); } }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  font-family: 'Charter','Georgia',serif; font-size: 10.6pt; line-height: 1.5;
  color: #1c2530; margin: 0;
}
h1,h2,h3,.lbl,.cover .k,.eff { font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; }

/* cover */
.cover { padding: 6mm 0 9mm; border-bottom: 3px solid #1e5b92; margin-bottom: 9mm; }
.cover .k { font-size: 8pt; letter-spacing: .18em; text-transform: uppercase; color: #1e5b92; font-weight: 700; }
.cover h1 { font-size: 27pt; line-height: 1.1; margin: 5mm 0 3mm; color: #10202f; font-weight: 700; letter-spacing: -.02em; }
.cover .sub { font-size: 12pt; color: #4a5a68; margin: 0; }
.cover .date { font-size: 9pt; color: #8794a1; margin-top: 4mm; }
.lede { font-size: 10.2pt; color: #33414f; background: #f4f7fa; border-left: 3px solid #9fc0dc;
        padding: 4mm 5mm; margin: 0 0 8mm; border-radius: 2px; }
.lede p { margin: 0 0 2mm; } .lede p:last-child { margin: 0; }

/* contents */
.toc { margin: 2mm 0 0; }
.toch { font-size: 8pt; letter-spacing: .16em; text-transform: uppercase; color: #7d8b99;
  font-weight: 700; font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif;
  border-bottom: 1px solid #e3e9ee; padding-bottom: 2mm; margin-bottom: 3mm; }
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc li { display: flex; align-items: baseline; gap: 3mm; padding: 1.8mm 0;
  border-bottom: 1px dotted #e6ebf0; font-size: 10.2pt; }
.toc .tn { flex: 0 0 7mm; font-weight: 700; color: #1e5b92;
  font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; }
.toc .tt { flex: 1 1 auto; color: #24313d; }
.toc .te { flex: 0 0 auto; font-size: 7.6pt; font-weight: 700; color: #7d8b99;
  font-family: 'Helvetica Neue',Helvetica,Arial,sans-serif; letter-spacing: .06em; }
.pb { break-after: page; page-break-after: always; }

/* feature cards */
section.card { break-inside: avoid; page-break-inside: avoid;
  border: 1px solid #dfe6ec; border-radius: 4px; padding: 5mm 6mm 4mm;
  margin: 0 0 6mm; background: #fff; }
section.card h2 { display: flex; align-items: baseline; gap: 4mm;
  font-size: 14pt; line-height: 1.25; margin: 0 0 4mm; color: #10202f;
  font-weight: 700; letter-spacing: -.01em;
  border-bottom: 1px solid #edf1f5; padding-bottom: 3mm; }
h2 .num { flex: 0 0 auto; font-size: 21pt; font-weight: 800; color: #1e5b92;
  line-height: 1; min-width: 11mm; }
h2 .ct { flex: 1 1 auto; }

/* labelled rows */
p.row { display: flex; gap: 4mm; margin: 0 0 2.6mm; align-items: baseline; }
p.row .lbl { flex: 0 0 30mm; font-size: 7.6pt; font-weight: 700; letter-spacing: .07em;
  text-transform: uppercase; color: #7d8b99; padding-top: .6mm; }
p.row .val { flex: 1 1 auto; }
p.row.effort .val { }
.eff { display: inline-block; background: #1e5b92; color: #fff; font-size: 8pt; font-weight: 700;
  padding: .5mm 2mm; border-radius: 2px; margin-right: 1.5mm; }

ul.risks { margin: 1mm 0 2mm 30mm; padding: 3mm 4mm 3mm 8mm; background: #fbf7f0;
  border-left: 2px solid #e0c088; border-radius: 2px; list-style: disc; }
ul.risks li { margin: 0 0 1.6mm; font-size: 9.8pt; color: #3b4653; }
ul.risks li:last-child { margin: 0; }

/* trailing bands: Where to start, what didn't make it, sources */
section.band { break-inside: avoid-page; margin: 0 0 6mm; }
section.band h1 { font-size: 15pt; margin: 2mm 0 4mm; color: #10202f; font-weight: 700;
  border-bottom: 2px solid #1e5b92; padding-bottom: 2mm; }
section.band p { margin: 0 0 3mm; }
section.band > ul { padding-left: 5mm; }
section.band > ul li { margin-bottom: 2.4mm; }
h3 { font-size: 11pt; margin: 4mm 0 2mm; color: #1e5b92; }

a { color: #1e5b92; text-decoration: none; }
strong { color: #10202f; }
em { color: #33414f; }

/* sources: compact, two columns, no giant URLs */
.band.sources ul { columns: 2; column-gap: 8mm; font-size: 8.6pt; list-style: none; padding: 0; }
.band.sources li { break-inside: avoid; margin: 0 0 2.2mm; padding-left: 3mm;
  border-left: 2px solid #e3e9ee; color: #5a6874; }
.band.sources a { color: #33414f; }
"""

LEDE = ''

# Contents: the ten titles with their effort size, so page one is a map instead of white space.
items = re.findall(r'^## (\d+)\.\s*(.*?)\s*$', raw, flags=re.M)
efforts = re.findall(r'\*\*Effort:\s*([^.*]+)', raw)
toc_rows = ''.join(
    f'<li><span class="tn">{n}</span><span class="tt">{html.escape(t)}</span>'
    f'<span class="te">{html.escape(efforts[i].strip()) if i < len(efforts) else ""}</span></li>'
    for i, (n, t) in enumerate(items))
TOC = f'<div class="toc"><div class="toch">What\'s inside</div><ol>{toc_rows}</ol></div>' if items else ''

doc = f"""<!doctype html><html><head><meta charset="utf-8"><title>{TITLE}</title>
<style>{CSS}</style></head><body>
<div class="cover">
  <div class="k">{html.escape(args.kicker)}</div>
  <h1>{TITLE}</h1>
  <p class="sub">{SUBTITLE}</p>
  <div class="date">{DATE}{" &middot; " + html.escape(args.footnote) if args.footnote else ""}</div>
</div>
{LEDE}
{TOC}
<div class="pb"></div>
{body}
</body></html>"""

# tag the sources band so its CSS applies

tmp = SRC.with_suffix('.render.html')
tmp.write_text(doc)
subprocess.run([CHROME, '--headless', '--no-sandbox', '--disable-gpu',
                '--no-pdf-header-footer', f'--print-to-pdf={OUT}', str(tmp)],
               check=True, capture_output=True)
print(f'wrote {OUT} ({OUT.stat().st_size // 1024} KB)')
