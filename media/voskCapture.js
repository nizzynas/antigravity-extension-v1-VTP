// @ts-nocheck
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

    function startSession() {
      if (!modelReady || !model) { post({ type: 'voskError', message: 'Model not loaded yet.' }); return; }
      stopSession();
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

    function feedPcm(b64) {
      if (!recognizer || !b64) return;
      try {
        const bin = atob(b64);
        const n = bin.length >> 1;
        const f32 = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          let s = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8));
          if (s >= 0x8000) s -= 0x10000;
          f32[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
        }
        recognizer.acceptWaveformFloat(f32, SAMPLE_RATE);
      } catch (e) {}
    }

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
