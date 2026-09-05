// scripts/lib/layout-measure.mjs — ONE measurement, shared by every layout guard.
//
// This lived inside verify-mobile-layout.mjs, which meant the phone guard could see a
// collision and the desktop guard could not — the desktop one only ever measured how much
// display width a screen used. That gap is how an iPad shipped with forty-three controls
// under the touch floor and a dropdown hanging off the left edge: the app serves the DESKTOP
// layout to anything 768px and wider, and nothing that looks for collisions had ever been
// pointed at a tablet.
//
// Extracted rather than copied, deliberately. Two guards with two copies of this expression
// is two guards that slowly disagree about what "clipped" means.
//
// Measure inside the page: find what actually sticks out, not merely that something does.
export const MEASURE = `(() => {
  const vw = window.innerWidth;
  // NOT document.scrollWidth. index.css pins html/body/#root to the viewport with
  // overflow:hidden, so the document can never report itself as wider than the window —
  // which made this guard's headline check structurally incapable of firing. Measure the
  // widest thing that actually lays out instead: the app shell and every scroll container.
  // #root ONLY. An overflow-hidden box reports its content's width in scrollWidth even
  // though it clips and cannot scroll — the scaled 600px email preview is exactly that, and
  // measuring every overflow-* element flagged it as a 600px page. A clipping box cannot
  // widen the shell, so the shell is the honest measure; anything genuinely too wide shows
  // up in #root.scrollWidth, and anything merely clipped is caught by the clipped check.
  const root = document.getElementById('root') || document.body;
  const docW = Math.max(vw, root.scrollWidth);
  const out = { vw, docW, wide: [], offscreen: [], small: [], dead: [], clipped: [], overlap: [] };
  // Controls collected during the sweep, for the pairwise overlap check below.
  const controls = [];

  const visible = (el, r) => {
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    return true;
  };
  // A deliberate horizontal SCROLLER (auto/scroll) contains its content — the operator
  // can still reach it, so a wide table inside one is a design, not a defect.
  // overflow-x: hidden is NOT that: it CLIPS, and clipped content is unreachable. Counting
  // hidden as "contained" is what let the Map's top cluster ship with its Filters button
  // sliced in half — the guard passed the screen while the label read "Fil".
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      // It must ACTUALLY scroll horizontally. Tailwind's overflow-y-auto computes
      // overflow-x to 'auto' as well, so the old test treated every vertically scrolling
      // sheet, drawer and screen body as a deliberate horizontal scroller and silently
      // switched off the wide/offscreen/clipped checks inside all of them.
      if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true;
    }
    return false;
  };
  // Content sliced by an ancestor's clip. Reported separately from page overflow: nothing
  // scrolls sideways, the operator simply cannot see part of a control.
  const clippedBy = (el, r) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'hidden' && cs.overflowY !== 'hidden') continue;
      const pr = p.getBoundingClientRect();
      if (pr.width <= 0) continue;
      if (r.right > pr.right + 1 || r.left < pr.left - 1) return Math.round(Math.max(r.right - pr.right, pr.left - r.left));
    }
    return 0;
  };
  const tagOf = (el) => el.tagName.toLowerCase();
  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 4).join('.') : '';
    const txt = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' “' + txt + '”' : '');
  };

  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    if (r.width > vw + 1 && !inScroller(el)) out.wide.push({ el: describe(el), w: Math.round(r.width) });
    if (!inScroller(el)) {
      const cut = clippedBy(el, r);
      // Only leaf-ish content: a clipped wrapper is usually just its clipped child again.
      const isControl = ['button', 'a', 'select', 'input', 'summary'].includes(tagOf(el));
      if (cut > 4 && (isControl || (el.children.length === 0 && (el.textContent || '').trim().length > 0))) {
        out.clipped.push({ el: describe(el), cut });
      }
    }
    if ((r.right > vw + 1 || r.left < -1) && !inScroller(el) && r.width < vw) {
      out.offscreen.push({ el: describe(el), left: Math.round(r.left), right: Math.round(r.right) });
    }
    const tag = el.tagName.toLowerCase();
    // A tap target is whatever a finger has to hit, not whatever happens to be a <button>.
    // The sweep at v0.54.83 found three shapes this predicate was blind to: sortable <th>
    // headers, <label>s wrapping a checkbox, and plain <a href>. All are in here now.
    const clickableTh = tag === 'th' && (el.className || '').includes('cursor-pointer');
    const labelForBox = tag === 'label' && !!el.querySelector('input[type="checkbox"], input[type="radio"]');
    const tappable = tag === 'button' || tag === 'a' || tag === 'select' || tag === 'summary'
      || (tag === 'input' && !['hidden','checkbox','radio'].includes(el.type))
      || clickableTh || labelForBox
      || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'menuitem';
    if (tappable && !el.disabled) {
      // Only controls a finger can actually REACH. A closed bottom sheet is parked with
      // translate-y-full, so its full-size, fully-"visible" inputs geometrically overlap
      // the tab bar under the viewport edge — flagging those would bury the real
      // occlusions in noise. Sample five points; if the browser's own hit-testing never
      // returns this element (or its own subtree) at any of them, no tap can land on it,
      // so it is not part of the interactive surface being judged.
      const hits = (x, y) => {
        const t = document.elementFromPoint(x, y);
        return !!t && (t === el || el.contains(t) || t.contains(el));
      };
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      const inset = Math.min(6, r.width / 4, r.height / 4);
      const reachable = hits(cx, cy)
        || hits(r.left + inset, r.top + inset) || hits(r.right - inset, r.top + inset)
        || hits(r.left + inset, r.bottom - inset) || hits(r.right - inset, r.bottom - inset);
      if (reachable) {
        // The VISIBLE rect, not the layout rect. A row half-scrolled out of a sheet
        // still reports its full box, which geometrically "overlaps" the tab bar below
        // the scroller — but it is clipped there, occluding nothing. Intersect with
        // every clipping ancestor so the overlap test judges what is actually painted.
        const vr = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (let p = el.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (!/(auto|scroll|hidden)/.test(cs.overflowX + ' ' + cs.overflowY)) continue;
          const pr = p.getBoundingClientRect();
          vr.left = Math.max(vr.left, pr.left); vr.top = Math.max(vr.top, pr.top);
          vr.right = Math.min(vr.right, pr.right); vr.bottom = Math.min(vr.bottom, pr.bottom);
        }
        if (vr.right - vr.left > 8 && vr.bottom - vr.top > 8) controls.push({ el, r: vr });
      }
      // Credit a deliberately-expanded hit area: the app's own idiom is an absolutely
      // positioned ::after with negative insets (after:-inset-y-3), which really does
      // make a 20px switch a 44px target. Measure what the finger hits, not the paint.
      let hh = r.height, hw = r.width;
      try {
        const a = getComputedStyle(el, '::after');
        if (a && a.content && a.content !== 'none' && a.position === 'absolute') {
          const t = parseFloat(a.top), b = parseFloat(a.bottom), l = parseFloat(a.left), rt = parseFloat(a.right);
          if (t < 0) hh += -t;
          if (b < 0) hh += -b;
          if (l < 0) hw += -l;
          if (rt < 0) hw += -rt;
        }
      } catch (_e) { /* no ::after */ }
      if (hh < 40 || hw < 24) out.small.push({ el: describe(el), h: Math.round(hh), w: Math.round(hw) });
    }
  }
  // Dead space: a big empty box with no rendered descendant content.
  for (const el of document.querySelectorAll('main div, section div, iframe')) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r) || r.height < window.innerHeight * 0.6) continue;
    if (el.tagName.toLowerCase() === 'iframe') continue;
    const hasInk = [...el.querySelectorAll('*')].some((c) => {
      const cr = c.getBoundingClientRect();
      if (!(cr.width > 0 && cr.height > 0)) return false;
      // AN IFRAME'S CONTENT IS INK THIS CHECK CANNOT READ. textContent stops at the document
      // boundary, so a fully-rendered email preview looked like a 526px empty white box and
      // the tablet guard reported it as dead space on three sizes. A sized iframe is content
      // by definition — whatever is inside it is not measurable from out here, and guessing
      // "empty" is the wrong default when the alternative is a false alarm on a working
      // screen. (The loop above already skips iframes as the OUTER element; this is about a
      // wrapper that CONTAINS one.)
      if (c.tagName.toLowerCase() === 'iframe') return true;
      return (c.textContent || '').trim().length > 0;
    });
    if (!hasInk && (el.textContent || '').trim().length === 0) out.dead.push({ el: describe(el), h: Math.round(r.height) });
  }
  // TWO CONTROLS ON THE SAME PIXELS. The defect class behind Chad's 2026-08-19 phone
  // screenshot ("things are laying on top of one another"): the Map's draw buttons were
  // absolutely pinned at a guessed offset and landed on the status card's own buttons the
  // moment the card wrapped and expanded. Nothing here fired — the buttons were full-size,
  // unclipped, on-screen — so the guard passed a screen where a tap on "N c/o" armed the
  // lasso. Occlusion between interactive controls is ALWAYS a defect in the resting or
  // probed state; deliberate layers are excluded structurally, not by threshold:
  //   • ancestor/descendant pairs (a badge overflowing its own button is one control)
  //   • anything inside a position:fixed layer (sheets, drawers, panels, tab bar — those
  //     are MEANT to cover the page; pinning furniture is only a bug within one layer)
  //   • sticky containers count as layers too: a sticky header EXISTS to cover the
  //     content that scrolls under it — flagging that is flagging scrolling itself.
  //   • surfaces that EXIST to cover the page declare it with data-overlay-layer
  //     (bottom sheets, the resizable data grid). A declared cover over the furniture
  //     beneath it is scrolling/sheets working as designed; two controls colliding
  //     WITHIN one layer is still always a defect.
  const fixedLayerOf = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (p.hasAttribute && p.hasAttribute('data-overlay-layer')) return p;
      const pos = getComputedStyle(p).position;
      if (pos === 'fixed' || pos === 'sticky') return p;
    }
    return null;
  };
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const A = controls[i], B = controls[j];
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
      if (fixedLayerOf(A.el) !== fixedLayerOf(B.el)) continue;
      const ox = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
      const oy = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
      // >8px on BOTH axes: real occlusion, not rounded corners touching.
      if (ox > 8 && oy > 8) {
        out.overlap.push({ el: describe(A.el) + '  ⇄  ' + describe(B.el), px: Math.round(Math.min(ox, oy)) });
      }
    }
  }
  // Dedup by description, keep the worst.
  const top = (arr, k) => Object.values(arr.reduce((m, x) => { const p = m[x.el]; if (!p || (x[k] || 0) > (p[k] || 0)) m[x.el] = x; return m; }, {})).slice(0, 6);
  out.wide = top(out.wide, 'w'); out.offscreen = top(out.offscreen, 'right');
  out.clipped = top(out.clipped, 'cut');
  out.small = Object.values(out.small.reduce((m,x)=>{m[x.el]=x;return m;},{})); out.dead = top(out.dead, 'h');
  out.overlap = top(out.overlap, 'px');
  return out;
})()`;
