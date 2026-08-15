// @ts-nocheck
/**
 * voskCapture.js — local speech-to-text in the webview (WASM), fed by the host.
 *
 * The Antigravity/VS Code webview denies getUserMedia, so the microphone is
 * captured HOST-side with FFmpeg. The host streams raw PCM (s16le, mono, 16 kHz)
 * here as base64; we feed it straight into Vosk's recognizer. Only the WASM
 * inference runs in the webview — no mic, no permission prompt.
 *
 * Model bytes arrive from the host as base64 chunks (see panel.js) → Blob →
 * Vosk.createModel(). `vosk.js` (vendored) exposes window.Vosk.
 *
 * panel.js calls window.__initVosk(post) once and routes host messages to the
 * returned controller. Messages posted up to the host:
 *   { type: 'voskReady' } | { type: 'voskError', message }
 *   { type: 'voskPartial', text } | { type: 'voskResult', text }
 */
(function () {
  window.__initVosk = function initVosk(post) {
    let model = null;
    let recognizer = null;
    let modelReady = false;
    const SAMPLE_RATE = 16000;

    function log(msg) { post({ type: 'log', message: '[VoskWV] ' + msg }); }

    async function loadModel(arrayBuffer) {
      if (modelReady) { post({ type: 'voskReady' }); return; }
      try {
        if (!window.Vosk || typeof window.Vosk.createModel !== 'function') {
          throw new Error('vosk.js failed to load (window.Vosk missing)');
        }
        log('WASM support: ' + (typeof WebAssembly !== 'undefined'));
        if (!arrayBuffer || arrayBuffer.byteLength < 1000000) {
          throw new Error('model payload too small (' + (arrayBuffer ? arrayBuffer.byteLength : 0) + ' bytes) — transfer failed');
        }
        const blob = new Blob([arrayBuffer], { type: 'application/gzip' });
        const url = URL.createObjectURL(blob);
        log('Creating model from ' + arrayBuffer.byteLength + ' bytes (blob url made)...');
        const timeout = new Promise((_, rej) =>
          setTimeout(() => rej(new Error('createModel timed out after 40s — the Vosk WASM worker likely could not start (CSP/WebAssembly).')), 40000));
        model = await Promise.race([window.Vosk.createModel(url), timeout]);
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60000);
        modelReady = true;
        log('Model ready.');
        post({ type: 'voskReady' });
      } catch (err) {
        post({ type: 'voskError', message: 'Model load failed: ' + (err && err.message ? err.message : String(err)) });
      }
    }

    /** Start a fresh recognizer for a new capture session. */
    function startSession() {
      if (!modelReady || !model) { post({ type: 'voskError', message: 'Model not loaded yet.' }); return; }
      stopSession(); // ensure no stale recognizer
      recognizer = new model.KaldiRecognizer(SAMPLE_RATE);
      recognizer.on('result', (m) => {
        const text = ((m && m.result && m.result.text) || '').trim();
        if (text) post({ type: 'voskResult', text });
      });
      recognizer.on('partialresult', (m) => {
        const text = ((m && m.result && m.result.partial) || '').trim();
        post({ type: 'voskPartial', text });
      });
      log('Recognizer session started.');
    }

    /** Feed a base64 chunk of s16le/16kHz PCM from the host's FFmpeg. */
    function feedPcm(b64) {
      if (!recognizer || !b64) return;
      try {
        const bin = atob(b64);
        const n = bin.length >> 1; // 2 bytes per sample
        const f32 = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          // little-endian int16 → float [-1, 1]
          let s = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8));
          if (s >= 0x8000) s -= 0x10000;
          f32[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
        }
        recognizer.acceptWaveformFloat(f32, SAMPLE_RATE);
      } catch (e) { /* transient decode error — skip chunk */ }
    }

    /** Flush + tear down the recognizer at end of session. */
    function stopSession() {
      if (!recognizer) return;
      try { recognizer.retrieveFinalResult(); } catch {}
      try { recognizer.remove(); } catch {}
      recognizer = null;
      log('Recognizer session stopped.');
    }

    return {
      loadModel,
      startSession,
      feedPcm,
      stopSession,
      isReady: () => modelReady,
    };
  };
})();
