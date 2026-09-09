# Hydraulic stacker flag — design working files

Design only. **No app code is changed by this branch.**

Source artboards for the published design canvas.

## The decided design (Chad, Sep 2026)

Show a **bright yellow badge with a dark H** on any item row whose product text
contains **"hydraulic stacker"**.

| | |
| --- | --- |
| fill | `#facc15` |
| letter | `#1f2937` |
| ring | `#ffffff`, 1.5 |
| geometry | `r=7` disc in a 14×14 box — same construction as `RESTRICTION_ICONS` |
| label | "Hydraulic stacker" |

Two things settled along the way:

- **The letter is dark, not white.** Every existing badge uses a white glyph, but
  all of them sit on dark fills. On bright yellow, white washes out at the 13px
  item-row size. `readableTextColor()` (App.jsx:2955) already returns `#1f2937`
  for any fill this light, so dark is the house rule here.
- **A letterform is what survives 13px.** A drawn machine (mast, forks, casters)
  needs five or six shapes and turns to mush at row size — the same thing that
  already happens to the truck glyphs in the existing set.

Chad's scope, explicitly: match the text, show the icon, **nothing else**. No
derived weight rule, no thresholds, no changes to the ticket, grid or map pin.

## Files

| File | Board |
| --- | --- |
| `Main.dc.html` | The mark at 64/28/22/16/14/13 px, the spec, and why the H is dark |
| `Phone.dc.html` | The full stop card at 390px and 360px |
| `Desktop.dc.html` | The full stop card in the `w-[380px]` sidebar (347px rows) |
| `canvas.json` | Artboard layout |
| `build.mjs` / `gen.mjs` | Regenerate the artboards |

## Regenerate

```bash
node gen.mjs
node "<design skill dir>/seed-canvas.mjs" \
  --template "<design skill dir>/payload.template.html" \
  --out heavy-piece-freight-flag.html --title "Hydraulic Stacker Flag" \
  --artboard Main.dc.html --artboard Phone.dc.html --artboard Desktop.dc.html \
  --canvas canvas.json
```

The seeded `heavy-piece-freight-flag.html` is gitignored — it embeds the whole
canvas editor (~2.5 MB) and is rebuilt from the files above.

## Superseded

Earlier boards in #868 / #869 argued for a *weight-per-piece* mark instead of a
product-name match. Chad reviewed that and chose the simpler literal version, so
those boards are removed rather than left to contradict the decision. The two
unrelated findings from that pass still stand and are unfixed:

- `"NO STRAIGHT TRUCK OR LIFT"` matches a bare `/\bSTRAIGHT\s+TRUCK\b/i` in
  `ORDER_INSTR_PATTERNS` with no negation guard, badging the stop
  *straight-truck-only* — the inverse of the instruction.
- The amber `L` oversize chip keys on `productCategory === 'L'`, a value that
  appears nowhere in this repo outside hand-written test fixtures.
