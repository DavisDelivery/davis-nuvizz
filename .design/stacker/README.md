# Heavy-piece freight flag — design working files

Design-only. **No app code is changed by this branch.**

Source artboards for the published design canvas, which proposes an item-level
freight mark for the stop card's Items list. It argues that the icon Chad asked
for ("flag the HYDRAULIC STACKER") should key on **weight per piece**, not on the
product name — the row already prints the product name, and the same stop's
PLATFORM TRUCK is the same Uline equipment family at 174 lb/piece.

## Files

| File | Board |
| --- | --- |
| `Main.dc.html` | The reframe — why the mark says the weight, not "stacker" |
| `Mark.dc.html` | The icon, rendered at 56/22/16/14/13 px and 11px black |
| `Phone.dc.html` | Item row at 328px (360px phone) — the wrap test |
| `Desktop.dc.html` | Item row at 348px (the `w-[380px]` sidebar) |
| `Paper.dc.html` | The printed Delivery Ticket |
| `Escalate.dc.html` | Collapsed header + planning grid placements |
| `Ask.dc.html` | The open question, and two live issues found on the way |
| `canvas.json` | Artboard layout |
| `build.mjs` / `gen*.mjs` | Regenerate the artboards |

## Regenerate

```bash
node gen.mjs && node gen2.mjs && node gen3.mjs
node "<design skill dir>/seed-canvas.mjs" \
  --template "<design skill dir>/payload.template.html" \
  --out heavy-piece-freight-flag.html \
  --title "Heavy Piece Freight Flag" \
  --artboard Main.dc.html --artboard Mark.dc.html --artboard Phone.dc.html \
  --artboard Desktop.dc.html --artboard Paper.dc.html \
  --artboard Escalate.dc.html --artboard Ask.dc.html \
  --canvas canvas.json
```

The seeded `heavy-piece-freight-flag.html` is gitignored — it embeds the whole
canvas editor (~2.5 MB) and is rebuilt from the files above.

## Open question

Whether this gets built at all turns on one answer from Chad: when a stop shows
"one 1,259 lb piece", what changes — second man, load it last, require a dock,
call ahead, or nothing? If nothing, it is decoration and should be dropped.
