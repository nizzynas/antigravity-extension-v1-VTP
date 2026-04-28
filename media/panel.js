// @ts-nocheck

/**
 * VTP Webview Panel script.
 * Records audio via MediaRecorder + getUserMedia, sends base64 chunks
 * to the extension host for Gemini transcription.
 * No dependency on Web Speech API (unavailable in VS Code's Electron shell).
 */

(function () {
  const vscode = acquireVsCodeApi();

  // ─── DOM refs ────────────────────────────────────────────────────────────
  const statusBar        = document.getElementById('status-bar');
  const statusText       = document.getElementById('status-text');
  const contextWorkspace = document.getElementById('context-workspace');
  const contextConv      = document.getElementById('context-conv');
  const transcriptBox    = document.getElementById('transcript-box');
  const btnRecord        = document.getElementById('btn-record');
  const btnVad           = document.getElementById('btn-vad');
  const btnApiKey        = document.getElementById('btn-apikey');
  const btnInfo          = document.getElementById('btn-info');
  const btnSend          = document.getElementById('btn-send');
  const btnClear         = document.getElementById('btn-clear');
  const btnCopy          = document.getElementById('btn-copy');
  const promptBox        = document.getElementById('prompt-box');
  const promptSection    = document.getElementById('prompt-section');
  const commandSection   = document.getElementById('command-section');
  const commandLog       = document.getElementById('command-log');
  const spinner          = document.getElementById('spinner');
  const recordHint       = document.getElementById('record-hint');

  // ─── State ───────────────────────────────────────────────────────────────
  let isRecording   = false;
  let vadMode       = false;
  let mediaRecorder = null;
  let audioChunks   = [];
  let mediaStream   = null;
  let silenceTimer  = null;
  let audioContext  = null;
  let analyser      = null;
  let hasApiKey     = false;
  let fullTranscript = '';

  // ─── Mic helpers ─────────────────────────────────────────────────────────

  async function getMicStream() {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      const msg = err.name === 'NotAllowedError'
        ? 'Microphone access denied. Allow mic access and try again.'
        : 'Could not access microphone: ' + err.message;
      setStatus('idle', msg);
      log('getUserMedia failed: ' + err.name + ' — ' + err.message);
      return null;
    }
  }

  function pickMimeType() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
    ];
    return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  // ─── VAD (silence detection) ──────────────────────────────────────────────

  function setupVAD(stream) {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    let hasSpeech = false;
    const SPEECH_THRESHOLD = 0.01;
    const SILENCE_DELAY_MS = 2000;

    function tick() {
      if (!isRecording) return;

      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);

      if (rms > SPEECH_THRESHOLD) {
        hasSpeech = true;
        clearTimeout(silenceTimer);
        silenceTimer = null;
      } else if (hasSpeech && !silenceTimer) {
        // Silence detected after speech — flush after delay
        silenceTimer = setTimeout(() => {
          hasSpeech = false;
          silenceTimer = null;
          if (isRecording && mediaRecorder?.state === 'recording') {
            // Stop → triggers ondataavailable → sends chunk
            mediaRecorder.stop();
            // Restart for next utterance
            setTimeout(() => {
              if (isRecording) restartRecorder();
            }, 300);
          }
        }, SILENCE_DELAY_MS);
      }

      requestAnimationFrame(tick);
    }

    tick();
  }

  function teardownVAD() {
    clearTimeout(silenceTimer);
    silenceTimer = null;
    if (audioContext) { audioContext.close(); audioContext = null; }
    analyser = null;
  }

  // ─── Recorder ─────────────────────────────────────────────────────────────

  function buildRecorder(stream, mimeType) {
    const opts = mimeType ? { mimeType } : {};
    const rec = new MediaRecorder(stream, opts);
    audioChunks = [];

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    rec.onstop = () => {
      if (!audioChunks.length) return;
      const blob = new Blob(audioChunks, { type: rec.mimeType || mimeType || 'audio/webm' });
      audioChunks = [];
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        log('Audio chunk ready — ' + Math.round(blob.size / 1024) + 'KB, sending to Gemini...');
        setStatus('processing', 'Transcribing with Gemini...');
        post({ type: 'audioChunk', base64, mimeType: blob.type || mimeType });
      };
      reader.readAsDataURL(blob);
    };

    return rec;
  }

  function restartRecorder() {
    if (!mediaStream || !isRecording) return;
    const mimeType = pickMimeType();
    mediaRecorder = buildRecorder(mediaStream, mimeType);
    mediaRecorder.start();
  }

  // ─── Start / Stop ─────────────────────────────────────────────────────────

  async function startRecording() {
    if (isRecording) return;

    const stream = await getMicStream();
    if (!stream) return;

    mediaStream = stream;
    isRecording = true;
    fullTranscript = '';
    transcriptBox.textContent = 'Listening...';
    transcriptBox.classList.add('active');
    btnRecord.classList.add('recording');

    const mimeType = pickMimeType();
    log('Starting recorder. mimeType: ' + (mimeType || 'browser-default'));
    mediaRecorder = buildRecorder(stream, mimeType);

    if (vadMode) {
      setupVAD(stream);
      mediaRecorder.start();
      setStatus('listening', 'Listening (VAD on) — speak naturally');
      recordHint.textContent = 'Say "OK send" to finish';
    } else {
      mediaRecorder.start();
      setStatus('listening', 'Recording — release to transcribe');
      recordHint.textContent = 'Release to transcribe';
    }
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;

    teardownVAD();

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }

    btnRecord.classList.remove('recording');
    transcriptBox.classList.remove('active');
    recordHint.textContent = vadMode ? 'Always-on' : 'Push to Talk';
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────

  function setStatus(state, text) {
    statusBar.className = 'status-bar status-' + state;
    statusText.textContent = text;
  }

  function addCommandEntry(text) {
    commandSection.classList.remove('hidden');
    const el = document.createElement('div');
    el.className = 'command-entry';
    el.textContent = '⚡ ' + text;
    commandLog.appendChild(el);
    commandLog.scrollTop = commandLog.scrollHeight;
  }

  function showPromptSection(text) {
    spinner.classList.add('hidden');
    promptSection.classList.remove('hidden');
    if (text) promptBox.value = text;
    promptBox.focus();
  }

  function clearAll() {
    fullTranscript = '';
    promptBox.value = '';
    commandLog.innerHTML = '';
    transcriptBox.textContent = 'Your speech will appear here...';
    transcriptBox.classList.remove('active');
    promptSection.classList.add('hidden');
    commandSection.classList.add('hidden');
    spinner.classList.add('hidden');
    setStatus('idle', 'Ready — press Record');
    post({ type: 'cancel' });
  }

  function log(msg) {
    post({ type: 'log', message: '[Webview] ' + msg });
  }

  // ─── Messages from extension host ─────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'settings':
        vadMode = msg.vadMode;
        btnVad.classList.toggle('active', vadMode);
        break;

      case 'apiKeyStatus':
        hasApiKey = msg.hasKey;
        btnApiKey.classList.toggle('key-set', msg.hasKey);
        btnApiKey.title = msg.hasKey ? 'Gemini key active ✓ (click to update)' : 'No API key — click to add';
        break;

      case 'contextUpdate':
        contextWorkspace.textContent = msg.workspaceName || '—';
        contextConv.textContent      = msg.conversationTitle || '—';
        break;

      case 'transcriptResult':
        fullTranscript += (fullTranscript ? ' ' : '') + msg.text;
        transcriptBox.textContent = fullTranscript;
        setStatus(isRecording ? 'listening' : 'ready', isRecording ? 'Listening...' : 'Ready — press Record');
        // If VAD mode and not recording any more, VAD already restarted the recorder
        break;

      case 'intentResult':
        if (isRecording) setStatus('listening', 'Intent classified — still listening...');
        break;

      case 'commandFired':
        addCommandEntry(msg.description);
        if (isRecording) setStatus('listening', 'Command done — still listening...');
        break;

      case 'elaborating':
        spinner.classList.remove('hidden');
        promptSection.classList.add('hidden');
        setStatus('processing', 'Elaborating with Gemini...');
        break;

      case 'elaborated':
        showPromptSection(msg.prompt);
        setStatus('ready', 'Ready — review and send');
        break;

      case 'injected':
        clearAll();
        setStatus('idle', '✓ Sent to Antigravity');
        break;

      case 'error':
        spinner.classList.add('hidden');
        setStatus('idle', '⚠ ' + msg.message);
        break;
    }
  });

  // ─── Button listeners ─────────────────────────────────────────────────────

  // Push-to-talk: click to start, click again to stop
  btnRecord.addEventListener('click', () => {
    isRecording ? stopRecording() : startRecording();
  });

  btnVad.addEventListener('click', () => {
    vadMode = !vadMode;
    btnVad.classList.toggle('active', vadMode);
    if (vadMode && !isRecording) startRecording();
    else if (!vadMode && isRecording) stopRecording();
  });

  // API key button: green = has key (click to update), red = no key (click to add)
  btnApiKey.addEventListener('click', () => {
    post({ type: 'openSettings' });
  });

  btnInfo.addEventListener('click', () => {
    post({ type: 'showInfo' });
  });

  btnSend.addEventListener('click', () => {
    const prompt = promptBox.value.trim();
    if (prompt) post({ type: 'send', prompt });
  });

  btnClear.addEventListener('click', clearAll);

  btnCopy.addEventListener('click', async () => {
    if (!promptBox.value) return;
    await navigator.clipboard.writeText(promptBox.value);
    const orig = btnCopy.textContent;
    btnCopy.textContent = '✓ Copied';
    setTimeout(() => (btnCopy.textContent = orig), 1500);
  });

  // ─── Init ─────────────────────────────────────────────────────────────────
  log('Panel script loaded. MediaRecorder supported: ' + (typeof MediaRecorder !== 'undefined'));
  post({ type: 'ready' });

  function post(msg) { vscode.postMessage(msg); }

})();
