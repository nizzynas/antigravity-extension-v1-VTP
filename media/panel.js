// @ts-nocheck

/**
 * VTP Webview Panel script.
 *
 * Audio pipeline:
 *   - FFmpeg + silencedetect  → 1.5s auto-stop, 8s auto-pause (mic stays on)
 *   - Gemini transcription    → accurate final transcript
 *   - Gemini intent classify  → SEND / ENHANCE / COMMAND / CANCEL
 *
 * Pause/Resume:
 *   - isPaused = true means mic is on but speech is only checked for wake phrases
 *   - Voice wake phrases: "resume", "continue", "I'm back", "go", etc.
 *   - Manual ⏸ button also toggles pause
 */

(function () {
  const vscode = acquireVsCodeApi();

  // ─── DOM refs ──────────────────────────────────────────────────────────────
  const statusBar        = document.getElementById('status-bar');
  const statusText       = document.getElementById('status-text');
  const contextWorkspace = document.getElementById('context-workspace');
  const contextConv      = document.getElementById('context-conv');
  const transcriptBox    = document.getElementById('transcript-box');
  const btnRecord        = document.getElementById('btn-record');
  const btnPause         = document.getElementById('btn-pause');
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

  // ─── State ─────────────────────────────────────────────────────────────────
  let isRecording    = false;
  let isPaused       = false;
  let vadMode        = false;
  let hasApiKey      = false;
  let fullTranscript = '';

  // ─── Animated recording dots ───────────────────────────────────────────────
  let dotTimer = null;
  const DOT_FRAMES = ['Listening', 'Listening.', 'Listening..', 'Listening...'];
  let dotFrame = 0;

  function startDots() {
    dotFrame = 0;
    dotTimer = setInterval(() => {
      dotFrame = (dotFrame + 1) % DOT_FRAMES.length;
      if (isRecording && !isPaused) statusText.textContent = DOT_FRAMES[dotFrame];
    }, 400);
  }

  function stopDots() {
    if (dotTimer) { clearInterval(dotTimer); dotTimer = null; }
  }

  // ─── UI helpers ────────────────────────────────────────────────────────────

  function setStatus(state, text) {
    statusBar.className = 'status-bar status-' + state;
    statusText.textContent = text;
  }

  function setRecording(active) {
    isRecording = active;
    btnRecord.classList.toggle('recording', active);
    transcriptBox.classList.toggle('active', active && !isPaused);

    if (active && !isPaused) {
      setStatus('listening', 'Listening...');
      startDots();
      btnPause.classList.remove('hidden');
      btnPause.textContent = '⏸';
      btnPause.title = 'Pause — mic stays on, buffer preserved';
      recordHint.textContent = vadMode ? 'Auto-stops on silence' : 'Listening — click to stop';
    } else if (!active) {
      stopDots();
      btnPause.classList.add('hidden');
      if (!isPaused) recordHint.textContent = vadMode ? 'Always-on' : 'Push to Talk';
    }
  }

  function setPaused(active) {
    isPaused = active;
    if (active) {
      stopDots();
      setStatus('paused', '⏸ Paused — say "resume" or click ▶');
      btnPause.textContent = '▶';
      btnPause.title = 'Resume recording';
      btnPause.classList.remove('hidden');
      transcriptBox.classList.remove('active');
      recordHint.textContent = 'Paused — mic in monitor mode';
    } else {
      // Resumed
      setStatus('listening', 'Listening...');
      startDots();
      btnPause.textContent = '⏸';
      btnPause.title = 'Pause — mic stays on, buffer preserved';
      transcriptBox.classList.add('active');
      recordHint.textContent = vadMode ? 'Auto-stops on silence' : 'Listening — click to stop';
    }
  }

  function renderTranscript() {
    if (fullTranscript) {
      transcriptBox.textContent = fullTranscript;
      transcriptBox.classList.add('has-content');
    } else {
      transcriptBox.textContent = 'Your speech will appear here...';
      transcriptBox.classList.remove('has-content');
    }
  }

  function addCommandEntry(text) {
    commandSection.classList.remove('hidden');
    const el = document.createElement('div');
    el.className = 'command-entry';
    el.textContent = '⚡ ' + text;
    commandLog.appendChild(el);
    commandLog.scrollTop = commandLog.scrollHeight;
  }

  function clearAll() {
    fullTranscript = '';
    isPaused = false;
    promptBox.value = '';
    commandLog.innerHTML = '';
    renderTranscript();
    promptSection.classList.add('hidden');
    commandSection.classList.add('hidden');
    spinner.classList.add('hidden');
    btnPause.classList.add('hidden');
    setStatus('idle', 'Ready — press Record');
    setRecording(false);
    post({ type: 'cancel' });
  }

  function post(msg) { vscode.postMessage(msg); }

  // ─── Messages from extension host ──────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'settings':
        vadMode = msg.vadMode;
        btnVad.classList.toggle('active', vadMode);
        recordHint.textContent = vadMode ? 'Auto-stops on silence' : 'Push to Talk';
        break;

      case 'apiKeyStatus':
        hasApiKey = msg.hasKey;
        btnApiKey.classList.toggle('key-set', msg.hasKey);
        btnApiKey.title = msg.hasKey
          ? 'Gemini key active ✓ (click to update)'
          : 'No API key — click to add';
        break;

      case 'contextUpdate':
        contextWorkspace.textContent = msg.workspaceName || '—';
        contextConv.textContent      = msg.conversationTitle || '—';
        break;

      case 'recordingStarted':
        setRecording(true);
        if (!isPaused) setStatus('listening', 'Listening...');
        break;

      case 'vadAutoStop':
        setStatus('processing', 'Silence detected — transcribing...');
        break;

      case 'recordingStopped':
        setRecording(false);
        if (!isPaused) {
          if (!fullTranscript) {
            transcriptBox.innerHTML = '<span class="interim">Transcribing…</span>';
          }
          setStatus('processing', 'Transcribing…');
        }
        break;

      case 'paused':
        setPaused(true);
        break;

      case 'autoPaused':
        setPaused(true);
        setStatus('paused', '⏸ Auto-paused — say "resume" to continue');
        break;

      case 'resumed':
        setPaused(false);
        break;

      case 'transcriptResult':
        if (msg.text) {
          fullTranscript = msg.text;
          renderTranscript();
          if (!isPaused) setStatus('idle', 'Ready — press Record');
        }
        break;

      case 'intentResult':
        break;

      case 'commandFired':
        addCommandEntry(msg.description);
        setStatus('idle', 'Ready — press Record');
        break;

      case 'elaborating':
        spinner.classList.remove('hidden');
        promptSection.classList.add('hidden');
        setStatus('processing', 'Elaborating with Gemini…');
        break;

      case 'elaborated':
        spinner.classList.add('hidden');
        promptSection.classList.remove('hidden');
        promptBox.value = msg.prompt;
        promptBox.focus();
        setStatus('ready', 'Review and send');
        break;

      case 'injected':
        clearAll();
        setStatus('idle', '✓ Sent to Antigravity');
        break;

      case 'error':
        spinner.classList.add('hidden');
        if (!isPaused) setStatus('idle', '⚠ ' + msg.message);
        break;
    }
  });

  // ─── Button listeners ──────────────────────────────────────────────────────

  btnRecord.addEventListener('click', () => {
    if (isPaused) {
      // Clicking record while paused = resume
      post({ type: 'resumeRecording' });
      return;
    }
    if (isRecording) {
      post({ type: 'stopRecording' });
      setRecording(false);
    } else {
      post({ type: 'startRecording' });
      setStatus('listening', 'Starting…');
    }
  });

  btnPause.addEventListener('click', () => {
    if (isPaused) {
      post({ type: 'resumeRecording' });
    } else {
      post({ type: 'pauseRecording' });
    }
  });

  btnVad.addEventListener('click', () => {
    vadMode = !vadMode;
    btnVad.classList.toggle('active', vadMode);
    recordHint.textContent = vadMode ? 'Auto-stops on silence' : 'Push to Talk';
    if (vadMode && !isRecording && !isPaused) {
      post({ type: 'startRecording' });
    } else if (!vadMode && isRecording) {
      setStatus('idle', 'Stopping…');
      post({ type: 'stopRecording' });
    }
  });

  btnApiKey.addEventListener('click', () => post({ type: 'openSettings' }));
  btnInfo.addEventListener('click',   () => post({ type: 'showInfo' }));

  btnSend.addEventListener('click', () => {
    const prompt = promptBox.value.trim();
    if (prompt) post({ type: 'send', prompt });
  });

  btnClear.addEventListener('click', clearAll);

  btnCopy.addEventListener('click', async () => {
    if (!promptBox.value) return;
    await navigator.clipboard.writeText(promptBox.value);
    const orig = btnCopy.textContent;
    btnCopy.textContent = '✓';
    setTimeout(() => (btnCopy.textContent = orig), 1200);
  });

  // ─── Init ──────────────────────────────────────────────────────────────────
  post({ type: 'ready' });

})();
