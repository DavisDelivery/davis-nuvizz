import fs from 'fs';
import { wrap } from './build.mjs';

fs.writeFileSync('Ask.dc.html', wrap(`
<div class="pad">
  <div class="kicker">Before a line of this gets built</div>
  <h2>One question for you, one read that costs nothing</h2>

  <div class="card" style="border-color:#1e5b92;border-width:2px;margin:20px 0">
    <h3 style="color:#1e5b92">The question that decides the whole feature</h3>
    <p class="lede" style="font-size:17px;margin:8px 0 10px">When you see “this stop has a 1,259&nbsp;lb single piece”, what do you actually <i>do</i> differently?</p>
    <p class="note">Send a second man · put it last on · require a dock rather than a gate · call ahead to ask if they have a forklift · move it earlier in the sequence · nothing.</p>
    <p class="note" style="margin-top:10px"><b style="color:#1c1917">If the honest answer is “nothing”, say so and I'll drop it.</b> A flag nobody acts on is decoration, and this one costs a line of screen on every heavy stop.</p>
  </div>

  <div class="card" style="margin-bottom:24px">
    <h3>The threshold should be measured, not picked by me</h3>
    <p class="note">I've proposed 500&nbsp;lb off a single screenshot. On this one stop anything from ~175&nbsp;lb to ~1,259&nbsp;lb gives the same answer, because the gap between the heaviest piece and the next is 7.2×. That is a wide band on <b style="color:#1c1917">n=1</b> — it is not evidence that the threshold is safe in general.</p>
    <p class="note" style="margin-top:10px"><span class="mono">freight-class-report</span> reads the Firestore history warehouse only, and its own header says “no NuVizz (or any other) API calls”. One 90-day read would settle: how often <span class="mono">UNT</span> appears, whether <span class="mono">weight</span> is always the line total, what the real product vocabulary is, where the per-piece distribution actually breaks, and <b style="color:#1c1917">how many stops a day would wear this mark</b>. <b style="color:#1c1917">Say the word and I'll run it.</b> Zero NuVizz calls.</p>
  </div>

  <div class="rule"></div>
  <h2 style="margin-bottom:4px">Two things I found on the way</h2>
  <p class="note" style="margin-bottom:18px">Both independent of the icon. Neither is fixed — this branch changes no app code — and both are yours to call.</p>

  <div class="grid2">
    <div class="card" style="background:#fef2f2;border-color:#fecaca">
      <h3 style="color:#991b1b">This stop is badged the opposite of its own instructions</h3>
      <p class="note">The note reads <b style="color:#1c1917">“NO STRAIGHT TRUCK OR LIFT / GATE! MUST SHIP UPRIGHT.”</b> — most likely one sentence Uline wrapped across two 25-character records.</p>
      <p class="mono" style="margin:11px 0;line-height:1.65;background:#fff;padding:9px 11px;border-radius:6px;border:1px solid #fecaca">"NO STRAIGHT TRUCK OR LIFT"<br>&nbsp;&nbsp;→ MATCH /\\bSTRAIGHT\\s+TRUCK\\b/i<br>&nbsp;&nbsp;→ uline_straight_truck<br>&nbsp;&nbsp;→ "Uline: straight truck only (advisory)"</p>
      <p class="note">I ran the real patterns rather than reading them; that list has no negation guard. Downstream, <span class="mono">routing-constraints</span> maps the flag to “must NOT be a tractor”, which forces the 26ft box — the one truck in the fleet with a liftgate. The customer said no straight truck and no lift gate.</p>
      <p class="note" style="margin-top:10px">The label does carry <b style="color:#1c1917">“(advisory)”</b>, and the repo treats this source as advisory by design — so it is a mislabel, not a hard block. It still reaches truck choice through the solver.</p>
      <p class="note" style="margin-top:10px"><b style="color:#1c1917">Caveat I can't close from here:</b> the badge draws from the stored <span class="mono">customer_notes</span> doc, so whether SHARPS MWS carries it <i>today</i> is a Firestore fact. The code path is proven; the stored state is not. Also a free read.</p>
    </div>

    <div class="card" style="background:#fffbeb;border-color:#fde68a">
      <h3 style="color:#92400e">The oversize “L” chip may never have fired</h3>
      <p class="note">The amber <b>L</b> chip keys on <span class="mono">productCategory === 'L'</span>, documented in one repo comment as “S standard / L long-oversize”. NuVizz's own OpenAPI spec describes that field differently:</p>
      <p class="mono" style="margin:11px 0;line-height:1.65;background:#fff;padding:9px 11px;border-radius:6px;border:1px solid #fde68a">productCategory — "Type of carton or<br>package Cooler, stote,ltote,<br>refrigerated etc."&nbsp; example: <b>DRY</b></p>
      <p class="note">Free text, max length 45. Every <span class="mono">'L'</span> and <span class="mono">'S'</span> value in this repo is in a <b style="color:#1c1917">hand-written test fixture</b> — none is captured NuVizz traffic — and the screenshot shows no L chip on a 1,259&nbsp;lb machine.</p>
      <p class="note" style="margin-top:10px">That does not prove it never fires: Uline could populate it however they like regardless of the spec's examples. It does mean nothing in the repo is evidence that it does. The same free read answers it — and it is a second reason not to build the new mark on that field.</p>
    </div>
  </div>

  <div class="rule"></div>
  <div class="card">
    <h3>What I'd build first, if you say go</h3>
    <p class="note">Not the icon. The free read, then the threshold, then the mark — in that order. The rule itself belongs beside <span class="mono">LONG_KEYWORDS</span> in <span class="mono">freight-geometry.mts</span>, which is already the pure, unit-tested, server-side home for freight rules and already keyword-scans product names today. One definition there feeds the screen, the grid and the paper, instead of three renderers each deciding for themselves.</p>
  </div>
</div>`));

fs.writeFileSync('canvas.json', JSON.stringify({
  artboards: [
    { file: 'Main.dc.html',     title: '1 · The reframe',        x: 0,    y: 0,    w: 1000, h: 1330 },
    { file: 'Mark.dc.html',     title: '2 · The mark',           x: 1100, y: 0,    w: 1000, h: 930 },
    { file: 'Phone.dc.html',    title: '3 · Mobile + the widths', x: 2200, y: 0,   w: 1180, h: 840 },
    { file: 'Desktop.dc.html',  title: '4 · Desktop',            x: 0,    y: 1450, w: 1000, h: 670 },
    { file: 'Paper.dc.html',    title: '5 · The printed ticket', x: 1100, y: 1450, w: 1000, h: 800 },
    { file: 'Escalate.dc.html', title: '6 · Escalation',         x: 2200, y: 1450, w: 1060, h: 810 },
    { file: 'Ask.dc.html',      title: '7 · Over to you',        x: 0,    y: 2380, w: 1160, h: 1520 },
  ],
  annotations: [
    { id: 'start-here', x: 0, y: -170, w: 460,
      text: 'Start at 1 · THE REFRAME, then 2 · THE MARK.\n\nBoard 7 is the one that needs an answer from you — the rest is only worth building if that answer isn\'t "nothing".' },
    { id: 'corrected', x: 2200, y: -170, w: 460,
      text: 'Board 3 carries a correction: my first pass measured the row widths 32px narrow and I drew the wrong conclusion from it. The re-measured numbers are on that board.' },
  ],
  launch: { view: 'canvas' },
}, null, 2));
console.log('Ask + canvas.json');
