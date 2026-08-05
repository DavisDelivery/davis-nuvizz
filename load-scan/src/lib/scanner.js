// scanner.js — dual-engine barcode capture, rewritten from the Davis-wms
// public/index.html camera path (vanilla, single file) into something a React
// component can own and tear down cleanly.
//
// ── ENGINE CHOICE BY CAPABILITY ──────────────────────────────────────────────
//   native  BarcodeDetector / ML Kit. Android Chrome, desktop Chrome.
//   quagga  iOS Safari has NO BarcodeDetector, so it gets Quagga2 off the CDN.
//
// ── BUG FIXED ON PORT ────────────────────────────────────────────────────────
// The WMS capability gate reads:
//     if (fmts && fmts.includes('code_128')) nativeOK = true;
// That checks the wrong symbology. The PRO barcode is Code 39, so a device with
// Code 128 but no Code 39 support would take the native path and then never read
// a PRO. Both formats are required here.
//
// ── BEHAVIOUR CHANGE ON PORT ─────────────────────────────────────────────────
// The WMS takes the FIRST valid PRO in a frame and breaks out of the loop. This
// app needs both barcodes off one label, so every barcode in the frame is
// collected and handed to the pair buffer. Quagga's decoder also moves from
// `multiple: false` to `multiple: true` for the same reason.
//
// ── PRESERVED FROM THE SOURCE (hard-won, not incidental) ─────────────────────
//   - Android focusMode 'continuous' plus a modest zoom via applyConstraints.
//     The source comment names this as the actual reason close labels would not
//     focus-lock.
//   - Quagga confidence gating: avgError < 0.15 accept; 0.15-0.35 require two
//     consecutive identical reads; > 0.35 discard.
//   - Split rearm windows: 1500 ms iOS/Quagga, 5000 ms Android native, because
//     the native detector hunts focus at close range and drops a held label.

import { createPairBuffer } from './scan-logic.js';

const QUAGGA_CDN = 'https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js';

export const REARM_MS_QUAGGA = 1500;
export const REARM_MS_NATIVE = 5000;
const NATIVE_DETECT_INTERVAL = 60; // ms, ~16 fps — lets autofocus settle
const NATIVE_ZOOM_TARGET = 1.8;

/** Both symbologies must be supported, not just one. */
export async function detectNativeSupport() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return false;
  try {
    const fmts = await window.BarcodeDetector.getSupportedFormats();
    return !!fmts && fmts.includes('code_128') && fmts.includes('code_39');
  } catch {
    return false;
  }
}

function loadQuagga() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.Quagga) return Promise.resolve(window.Quagga);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = QUAGGA_CDN;
    s.async = true;
    s.onload = () => (window.Quagga ? resolve(window.Quagga) : reject(new Error('Quagga did not register')));
    s.onerror = () => reject(new Error('Quagga failed to load — no signal at the dock?'));
    document.head.appendChild(s);
  });
}

/**
 * Start scanning.
 *
 * @param videoEl     <video> for the native path
 * @param containerEl <div> Quagga renders into
 * @param onPair      ({pro, og, engine}) for each complete piece
 * @param onPartial   ({pro, og}) so the UI can say "hold steady, need the OG"
 * @param onStatus    (string) human-readable engine/state line
 * @param onRaw       (string[]) EVERY value the decoder returned, classified or
 *                    not. The dock has no console, so without this "the scanner
 *                    doesn't work" cannot be told apart from "it read something
 *                    the rules rejected".
 * @returns { stop, engine }
 */
export async function startScanner({ videoEl, containerEl, onPair, onPartial, onStatus, onRaw }) {
  const useNative = await detectNativeSupport();
  const buffer = createPairBuffer({ windowMs: useNative ? REARM_MS_NATIVE : REARM_MS_QUAGGA });

  const emit = (values, engine) => {
    onRaw?.(values);
    const pair = buffer.push(values);
    if (pair) onPair?.({ ...pair, engine });
    else onPartial?.(buffer.state());
  };

  if (useNative) {
    try {
      const stop = await startNative({ videoEl, emit, onStatus });
      return { stop, engine: 'native' };
    } catch (e) {
      console.error('[scanner] native path failed, falling back', e);
      // fall through — a broken native path should not leave the driver with no scanner
    }
  }

  const stop = await startQuagga({ containerEl, emit, onStatus });
  return { stop, engine: 'quagga' };
}

// ── Native (BarcodeDetector) ─────────────────────────────────────────────────

async function startNative({ videoEl, emit, onStatus }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  videoEl.srcObject = stream;
  videoEl.setAttribute('playsinline', '');
  videoEl.playsInline = true;
  videoEl.muted = true;
  await videoEl.play();

  // Android autofocus + slight zoom — the real reason close labels wouldn't lock.
  let zoomApplied = null;
  try {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const adv = [];
    if (caps.focusMode && caps.focusMode.includes('continuous')) adv.push({ focusMode: 'continuous' });
    if (caps.zoom && typeof caps.zoom.max === 'number') {
      zoomApplied = Math.min(caps.zoom.max, Math.max(caps.zoom.min || 1, NATIVE_ZOOM_TARGET));
      adv.push({ zoom: zoomApplied });
    }
    if (adv.length) await track.applyConstraints({ advanced: adv });
  } catch {
    /* capability probing is best-effort; scanning still works without it */
  }

  onStatus?.(`native detector${zoomApplied ? ` · zoom ${zoomApplied.toFixed(1)}x` : ''}`);

  const detector = new window.BarcodeDetector({ formats: ['code_128', 'code_39'] });
  let running = true;
  let busy = false;
  let lastAt = 0;
  let interval = null;

  const frame = async () => {
    if (!running) return;
    const now = performance.now();
    if (!busy && videoEl.readyState >= 2 && now - lastAt >= NATIVE_DETECT_INTERVAL) {
      busy = true;
      lastAt = now;
      try {
        const codes = await detector.detect(videoEl);
        // EVERY barcode in the frame, not just the first — this is the port's
        // behaviour change and the reason one gesture can capture a whole piece.
        if (codes.length) emit(codes.map((c) => c.rawValue), 'native');
      } catch {
        /* a dropped frame is normal; keep looping */
      }
      busy = false;
    }
    if (!running) return;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) videoEl.requestVideoFrameCallback(frame);
  };

  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) videoEl.requestVideoFrameCallback(frame);
  else interval = setInterval(frame, 150);

  return () => {
    running = false;
    if (interval) clearInterval(interval);
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* already gone */
    }
    videoEl.srcObject = null;
  };
}

// ── Quagga2 (iOS Safari) ─────────────────────────────────────────────────────

async function startQuagga({ containerEl, emit, onStatus }) {
  const Quagga = await loadQuagga();
  containerEl.innerHTML = '';

  await new Promise((resolve, reject) => {
    Quagga.init(
      {
        inputStream: {
          name: 'Live',
          type: 'LiveStream',
          target: containerEl,
          constraints: {
            facingMode: 'environment',
            width: { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
            aspectRatio: { ideal: 16 / 9 },
            focusMode: 'continuous',
            advanced: [{ focusMode: 'continuous' }, { focusMode: 'auto' }],
          },
          // WHOLE FRAME. This was { top: '15%', bottom: '15%' }, which threw
          // away the top and bottom bands of every frame — and on a Uline label
          // held close the OG barcode sits right at the top edge, so it could
          // never be decoded and the pair never completed. The driver saw
          // "point at a label" while pointing straight at one.
          //
          // The cost is CPU on a frame with nothing in it. That is the right
          // trade: a missed decode is a truck loaded wrong.
          area: { top: '0%', right: '0%', left: '0%', bottom: '0%' },
        },
        locator: { patchSize: 'medium', halfSample: true },
        numOfWorkers: navigator.hardwareConcurrency || 4,
        // multiple: true is the change from the WMS — both label barcodes at once.
        decoder: { readers: ['code_128_reader', 'code_39_reader'], multiple: true },
        locate: true,
        frequency: 20,
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });

  Quagga.start();
  onStatus?.('Quagga2 · iOS path');

  const qVid = containerEl.querySelector('video');
  if (qVid) qVid.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;z-index:1;';
  containerEl.querySelectorAll('canvas').forEach((c) => {
    c.style.display = 'none';
  });

  // Confidence gating, preserved from the source: clean reads go straight
  // through, borderline reads must repeat, noisy reads are discarded.
  const pending = new Map(); // code -> consecutive count

  const gate = (code, decodedCodes) => {
    const errors = (decodedCodes || []).map((d) => d.error).filter((e) => e !== undefined);
    const avgError = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
    if (avgError < 0.15) {
      pending.delete(code);
      return true;
    }
    if (avgError < 0.35) {
      const n = (pending.get(code) || 0) + 1;
      pending.set(code, n);
      if (n >= 2) {
        pending.delete(code);
        return true;
      }
      return false;
    }
    return false; // > 0.35 is too noisy to trust
  };

  const handler = (result) => {
    // With multiple: true Quagga2 reports result.barcodes; keep the single-result
    // shape working too, so a version change degrades instead of breaking.
    const list = Array.isArray(result?.barcodes) ? result.barcodes : result?.codeResult ? [result] : [];
    const accepted = [];
    for (const r of list) {
      const code = r?.codeResult?.code;
      if (!code) continue;
      if (gate(code, r.codeResult.decodedCodes)) accepted.push(code);
    }
    if (accepted.length) emit(accepted, 'quagga');
  };

  Quagga.onDetected(handler);

  return () => {
    try {
      Quagga.offDetected(handler);
    } catch {
      /* older builds lack offDetected */
    }
    try {
      Quagga.stop();
    } catch {
      /* already stopped */
    }
    containerEl.innerHTML = '';
  };
}
