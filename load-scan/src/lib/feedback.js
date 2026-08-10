// feedback.js — audible scan verdicts.
//
// Nobody reads a screen forty times a truck at 5am with gloves on. In gun mode
// the BEEP is the interface and the screen's job is what is still left to
// load, not what just happened:
//
//   good piece   short high beep      (plus a green flash that clears itself)
//   wrong freight harsh low buzz      (plus a red screen that stays until acknowledged)
//   duplicate    flat low tone        (already on the truck — no action needed)
//
// WebAudio oscillators only — no audio assets to fetch at a dock with no
// signal. The AudioContext must be created/resumed inside a user gesture
// (autoplay policy), so initAudio() is called from the gun-mode toggle tap.

let ctx = null;

/** Create or resume the shared AudioContext. Call from a user gesture at least once. */
export function initAudio() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, ms, { type = 'sine', gain = 0.5, delayMs = 0 } = {}) {
  const c = initAudio();
  if (!c) return;
  const t0 = c.currentTime + delayMs / 1000;
  const secs = ms / 1000;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + secs);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + secs + 0.02);
}

/**
 * Play the sound for a scan verdict: 'green' | 'amber' | 'red' | 'dup' | 'orphan'.
 * Distinct enough to tell apart over a forklift with ear protection on.
 */
export function playVerdict(kind) {
  if (kind === 'orphan') {
    // A falling two-tone: something was read, and then thrown away. Deliberately
    // unlike 'green' (nothing was booked) and unlike 'red' (nothing is wrong with
    // the freight) — the label just needs scanning again. Silence here is what
    // let a whole load be mis-attributed unnoticed.
    tone(760, 120, { type: 'triangle', gain: 0.45 });
    tone(430, 200, { type: 'triangle', gain: 0.45, delayMs: 130 });
    return;
  }
  if (kind === 'green') {
    tone(1400, 130, { type: 'square', gain: 0.35 });
  } else if (kind === 'amber') {
    // Two quick highs: loaded, but the stop needs an appointment confirmed.
    tone(1400, 90, { type: 'square', gain: 0.35 });
    tone(1400, 90, { type: 'square', gain: 0.35, delayMs: 150 });
  } else if (kind === 'red') {
    // Harsh double buzz — unmissable, unpleasant on purpose.
    tone(150, 380, { type: 'sawtooth', gain: 0.6 });
    tone(130, 380, { type: 'sawtooth', gain: 0.6, delayMs: 420 });
  } else if (kind === 'dup') {
    tone(330, 260, { type: 'sine', gain: 0.4 });
  }
}
