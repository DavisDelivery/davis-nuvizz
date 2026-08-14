// src/lib/viewport.js
//
// HOW TALL IS THE SCREEN, REALLY — the rule the app shell is sized by.
//
// The shell is `position:fixed` with a PIXEL height (not dvh) because the Google Maps
// container must resolve a real non-zero size, and because iOS Safari's dynamic toolbars
// make `100vh` extend behind them. That pixel height comes from `window.visualViewport`,
// which reports the area the user can actually SEE.
//
// THE BUG THIS EXISTS FOR (Chad, v0.54.69, phone screenshot): the board list squeezed into
// three rows with a dead grey slab filling the bottom quarter of the screen. The shell was
// ~630px tall on an 844px phone — which is 844 minus an iOS keyboard. He had typed in the
// search box; the keyboard shrank the visual viewport (correctly — the shell should sit
// above the keyboard); and when the keyboard went away iOS never fired the final
// `visualViewport resize`. The app kept the keyboard-sized height forever, and the grey was
// the page background showing through under a shell that had stopped believing in a quarter
// of the screen.
//
// THE RULE: the visible viewport is only legitimately SHORTER than the layout viewport while
// something is focused that raises the keyboard (or an iOS picker). With nothing focused, a
// visual viewport shorter than the layout viewport is STALE, and the layout viewport wins.
//
// This only ever raises the height, and only when no field is focused, so it cannot disturb
// the keyboard case it is carefully preserving. Scrolled-away toolbars make the visual
// viewport TALLER than the layout viewport, and `max` keeps that too.

// A focused element that can shrink the visual viewport on a phone. Text fields and
// textareas raise the keyboard; a <select> raises iOS's picker wheel, which shrinks it
// exactly the same way. contenteditable and role=textbox cover the rest.
export function raisesKeyboard(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    // Buttons/checkboxes wearing an <input> tag raise nothing.
    const type = String(el.type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(type);
  }
  if (el.isContentEditable) return true;
  return String(el.getAttribute?.('role') || '').toLowerCase() === 'textbox';
}

/**
 * PURE: the size the shell should be pinned to.
 *
 * @param {object} m  measurements taken together, so the rule can be tested without a DOM:
 *   vvHeight/vvWidth      window.visualViewport.height/width  (0/null when unsupported)
 *   vvLeft/vvTop          visualViewport.offsetLeft/offsetTop — how far the visible area has
 *                         scrolled inside the layout viewport (iOS does this when a field is
 *                         focused; the shell re-applies it so it doesn't slide off-screen)
 *   innerHeight/innerWidth  window.innerWidth/innerHeight
 *   clientHeight/clientWidth document.documentElement.clientWidth/Height — the LAYOUT viewport
 *   keyboardOpen          is a keyboard/picker-raising element focused right now
 * @returns {{h:number,w:number,x:number,y:number}}
 */
export function resolveViewportSize(m = {}) {
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const vvH = num(m.vvHeight);
  const vvW = num(m.vvWidth);
  const layoutH = num(m.clientHeight) || num(m.innerHeight);
  const layoutW = num(m.innerWidth) || num(m.clientWidth);

  // No visualViewport at all (older browsers): the layout viewport is all we have.
  let h = vvH || layoutH;
  let w = vvW || layoutW;

  if (!m.keyboardOpen) {
    // Nothing is focused, so nothing can be legitimately covering the screen. A shorter
    // visual viewport is a stale reading — take the layout viewport instead. `max`, never
    // a straight overwrite: a scrolled-away iOS toolbar makes the visible area TALLER than
    // the layout viewport, and that reading is real and worth keeping.
    if (layoutH) h = Math.max(h, layoutH);
    // The WIDTH stays pinned to the visible width even when idle: iOS's layout viewport can
    // be a few px WIDER than the visible one, and matching the wider value is what pushes
    // the right-hand controls (the last tab, the AI button) off the screen. Only rescue a
    // width that has collapsed to nothing.
    if (!w) w = layoutW;
  }

  return {
    h,
    w,
    // The visible area only scrolls inside the layout viewport while a field is focused, so
    // a non-zero offset with nothing focused is the same stale reading — and leaving it in
    // pins the whole shell a few dozen pixels off the top-left corner.
    x: m.keyboardOpen ? num(m.vvLeft) : 0,
    y: m.keyboardOpen ? num(m.vvTop) : 0,
  };
}

/** Read the live browser measurements and apply the rule. Returns zeros during SSR. */
export function readViewportSize(win = typeof window === 'undefined' ? null : window) {
  if (!win) return { h: 0, w: 0, x: 0, y: 0 };
  const vv = win.visualViewport;
  const de = win.document?.documentElement;
  return resolveViewportSize({
    vvHeight: vv?.height, vvWidth: vv?.width, vvLeft: vv?.offsetLeft, vvTop: vv?.offsetTop,
    innerHeight: win.innerHeight, innerWidth: win.innerWidth,
    clientHeight: de?.clientHeight, clientWidth: de?.clientWidth,
    keyboardOpen: raisesKeyboard(win.document?.activeElement),
  });
}
