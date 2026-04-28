// @ts-nocheck

/**
 * VTP Webview Panel script.
 *
 * Audio pipeline (v2 — Web Speech API):
 *   - webkitSpeechRecognition  → real-time word-by-word interim transcript (~200ms)
 *   - Final result             → sent to extension host for Gemini intent classification
 *   - Gemini                   → SEND / ENHANCE / COMMAND / CANCEL (no longer used for transcription)
 *
 * Pause/Resume:
 *   - isPaused = true means recognition is stopped; extension host monitors mic for wake phrases
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

  /** Committed text from previous completed utterances this session. */
  let committedText  = '';
  /** Live interim text for the utterance currently being spoken. */
  let interimText    = '';

  // ─── Web Speech API setup ──────────────────────────────────────────────────
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let recognitionLanguage = 'en-US';

  /** True while we intentionally stopped recognition (to prevent the onend
   *  handler from auto-restarting when the user pauses/stops recording). */
  let intentionalStop = false;

  /** True when the session ended mid-utterance and we need to restart to keep
   *  continuous recognition alive (browser stops after ~60s of no network). */
  let shouldRestart = false;

  function buildRecognition() {
    if (!SpeechRecognition) return null;
    const r = new SpeechRecognition();
    r.continuous      = true;   // don't stop after one utterance
    r.interimResults  = true;   // get live partial results
    r.maxAlternatives = 1;
    r.lang            = recognitionLanguage;

    r.onstart = () => {
      post({ type: 'log', message: '[VTP/WSA] Recognition started.' });
    };

    r.onresult = (event) => {
      // Rebuild interimText from the latest results array
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          // Append finalised utterance to committedText
          committedText = committedText
            ? committedText + ' ' + transcript.trim()
            : transcript.trim();
          interim = '';

          // Notify extension host with the full committed text so far
          post({ type: 'speechInterim', text: committedText });

          // Send the final utterance to the extension host for intent processing
          post({ type: 'speechFinal', segment: transcript.trim(), committed: committedText });
        } else {
          interim += transcript;
        }
      }
      interimText = interim;

      // Show committed + live interim in the transcript box
      renderLiveTranscript();
    };

    r.onerror = (event) => {
      // 'no-speech' and 'aborted' are expected — don't surface as errors.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      // 'not-allowed' = mic permission denied
      if (event.error === 'not-allowed') {
        post({ type: 'micPermissionDenied' });
        setStatus('idle', '⚠ Mic permission denied');
        return;
      }
      post({ type: 'log', message: `[VTP/WSA] Error: ${event.error}` });
      setStatus('idle', `⚠ Speech error: ${event.error}`);
    };

    r.onend = () => {
      // Restart unless we deliberately stopped (pause/stop button).
      if (!intentionalStop && isRecording && !isPaused) {
        // Small delay to avoid tight restart loops on repeated errors.
        setTimeout(() => {
          if (isRecording && !isPaused && recognition) {
            try { recognition.start(); } catch (_) {}
          }
        }, 150);
      }
    };

    return r;
  }

  function startRecognition() {
    intentionalStop = false;
    recognition = buildRecognition();
    if (!recognition) {
      // Fallback: no Web Speech API — tell extension host to use FFmpeg/Gemini
      post({ type: 'startRecording' });
      return;
    }
    try {
      recognition.start();
      post({ type: 'startRecording' }); // tells host to start FFmpeg for wake-monitor + VAD
    } catch (e) {
      post({ type: 'log', message: `[VTP/WSA] Start failed: ${e}` });
    }
  }

  function stopRecognition(pause = false) {
    intentionalStop = true;
    interimText = '';
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
      recognition = null;
    }
    if (pause) {
      post({ type: 'pauseRecording' });
    } else {
      post({ type: 'stopRecording' });
    }
  }

  // ─── Transcript rendering ──────────────────────────────────────────────────

  function renderLiveTranscript() {
    const display = committedText
      ? (interimText
          ? committedText + ' <span class="interim" style="opacity:0.55;font-style:italic">' + interimText + '</span>'
          : committedText)
      : (interimText
          ? '<span class="interim" style="opacity:0.55;font-style:italic">' + interimText + '</span>'
          : '');

    if (display) {
      transcriptBox.innerHTML = display;
      transcriptBox.classList.add('has-content');
    } else {
      transcriptBox.textContent = 'Your speech will appear here...';
      transcriptBox.classList.remove('has-content');
    }
  }

  function renderTranscript(text) {
    if (text) {
      committedText = text;
      interimText   = '';
      renderLiveTranscript();
    } else {
      committedText = '';
      interimText   = '';
      transcriptBox.textContent = 'Your speech will appear here...';
      transcriptBox.classList.remove('has-content');
    }
  }

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
      interimText = '';
      renderLiveTranscript();
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

  function addCommandEntry(text) {
    commandSection.classList.remove('hidden');
    const el = document.createElement('div');
    el.className = 'command-entry';
    el.textContent = '⚡ ' + text;
    commandLog.appendChild(el);
    commandLog.scrollTop = commandLog.scrollHeight;
  }

  function clearAll() {
    committedText = '';
    interimText   = '';
    isPaused = false;
    promptBox.value = '';
    commandLog.innerHTML = '';
    renderTranscript('');
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
        recognitionLanguage = msg.language || 'en-US';
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
        // In WSA mode, the send trigger fires and mic restarts automatically.
        // Just update status briefly.
        setStatus('processing', 'Processing...');
        break;

      case 'recordingStopped':
        setRecording(false);
        if (!isPaused) setStatus('processing', 'Processing…');
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
        // Restart Web Speech API recognition after resume
        if (!recognition) startRecognition();
        break;

      case 'wakeReady':
        setStatus('paused', '🎙 Listening for "resume"...');
        break;

      case 'transcriptResult':
        // Extension host sends the committed prompt buffer (after cancel/send/etc.)
        renderTranscript(msg.text);
        if (!isPaused) setStatus('idle', 'Ready — press Record');
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
      stopRecognition(false);
      setRecording(false);
    } else {
      committedText = '';
      interimText   = '';
      startRecognition();
      setStatus('listening', 'Starting…');
    }
  });

  btnPause.addEventListener('click', () => {
    if (isPaused) {
      post({ type: 'resumeRecording' });
    } else {
      stopRecognition(true); // stop recognition + tell host to pause
    }
  });

  btnVad.addEventListener('click', () => {
    vadMode = !vadMode;
    btnVad.classList.toggle('active', vadMode);
    recordHint.textContent = vadMode ? 'Auto-stops on silence' : 'Push to Talk';
    if (vadMode && !isRecording && !isPaused) {
      committedText = '';
      interimText   = '';
      startRecognition();
    } else if (!vadMode && isRecording) {
      stopRecognition(false);
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
