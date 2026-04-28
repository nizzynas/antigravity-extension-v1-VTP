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
  const btnMode          = document.getElementById('btn-mode');
  const btnApiKey        = document.getElementById('btn-apikey');
  const btnInfo          = document.getElementById('btn-info');
  const spinner          = document.getElementById('spinner');
  const recordHint       = document.getElementById('record-hint');
  const commandSection   = document.getElementById('command-section');
  const commandLog       = document.getElementById('command-log');
  // Enhance review
  const enhanceReview    = document.getElementById('enhance-review');
  const enhancedText     = document.getElementById('enhanced-text');
  const originalText     = document.getElementById('original-text');
  const btnApprove       = document.getElementById('btn-approve');
  const btnReject        = document.getElementById('btn-reject');
  const btnRegen         = document.getElementById('btn-regen');

  // ─── State ─────────────────────────────────────────────────────────────────
  let isRecording    = false;
  let isPaused       = false;
  let vadMode        = false;
  let hasApiKey      = false;
  /** 'speechRecognition' = Web Speech API (Google STT). 'ffmpeg' = FFmpeg + Gemini. */
  let transcriptionMode = 'speechRecognition';
  /** True while the enhance review card is visible */
  let isReviewing    = false;
  /** Saved enhanced text for approve path */
  let savedEnhanced  = '';
  /** Saved original text for reject path */
  let savedOriginal  = '';

  /** Committed text from previous completed utterances this session. */
  let committedText  = '';
  /** Live interim text for the utterance currently being spoken. */
  let interimText    = '';

  // ─── VAD silence timer (SR mode only) ────────────────────────────────────
  // When vadMode is on and transcriptionMode is 'speechRecognition', arm a
  // timer every time a speech result fires. If 8s pass with no new results,
  // auto-pause (same behaviour as FFmpeg silence detection).
  let srVadTimer = null;
  const SR_VAD_TIMEOUT_MS = 8000;

  function armSrVadTimer() {
    if (!vadMode || transcriptionMode !== 'speechRecognition') return;
    if (srVadTimer) clearTimeout(srVadTimer);
    srVadTimer = setTimeout(() => {
      if (isRecording && !isPaused) {
        post({ type: 'pauseRecording' });
      }
    }, SR_VAD_TIMEOUT_MS);
  }

  function clearSrVadTimer() {
    if (srVadTimer) { clearTimeout(srVadTimer); srVadTimer = null; }
  }

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
      // Reset VAD silence timer on every speech event (SR mode + vadMode)
      armSrVadTimer();

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
      // 'not-allowed' = mic permission denied (expected when FFmpeg is active)
      if (event.error === 'not-allowed') {
        intentionalStop = true; // prevent onend from restarting — FFmpeg owns the mic
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

    if (transcriptionMode === 'ffmpeg') {
      // FFmpeg mode: Web Speech API not used — extension host starts FFmpeg
      recognition = null;
      post({ type: 'startRecording' });
      return;
    }

    // SR mode: Web Speech API handles transcription
    recognition = buildRecognition();
    if (!recognition) {
      // No Web Speech API in this browser — fall back to FFmpeg
      post({ type: 'startRecording' });
      return;
    }
    try {
      recognition.start();
      post({ type: 'startRecording' }); // tells host to reset state (SR mode — no FFmpeg started)
    } catch (e) {
      post({ type: 'log', message: `[VTP/WSA] Start failed: ${e}` });
      post({ type: 'startRecording' }); // still reset host state
    }
  }

  function stopRecognition(pause = false) {
    intentionalStop = true;
    clearSrVadTimer();
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
    isReviewing = false;
    commandLog.innerHTML = '';
    renderTranscript('');
    commandSection.classList.add('hidden');
    hideEnhanceReview();
    spinner.classList.add('hidden');
    btnPause.classList.add('hidden');
    setStatus('idle', 'Ready — press Record');
    setRecording(false);
    post({ type: 'cancel' });
  }

  function showEnhanceReview(enhanced, original) {
    isReviewing = true;
    savedEnhanced = enhanced;
    savedOriginal = original;
    // Show the enhanced text in the transcript box with a visual cue
    committedText = enhanced;
    interimText   = '';
    transcriptBox.innerHTML = enhanced;
    transcriptBox.classList.add('has-content', 'enhanced-mode');
    // Populate the review card
    enhancedText.textContent = enhanced;
    originalText.textContent = original;
    enhanceReview.classList.remove('hidden');
    setStatus('ready', '✨ Approve, Reject, or Try Again');
  }

  function hideEnhanceReview() {
    isReviewing = false;
    enhanceReview.classList.add('hidden');
    transcriptBox.classList.remove('enhanced-mode');
  }

  function post(msg) { vscode.postMessage(msg); }

  function updateModeButton() {
    const isSR = transcriptionMode === 'speechRecognition';
    btnMode.textContent = isSR ? '🌐 SR' : '🔧 FFM';
    btnMode.title = isSR
      ? 'Engine: Web Speech API (Google STT) — click to switch to FFmpeg+Gemini'
      : 'Engine: FFmpeg + Gemini — click to switch to Web Speech API';
    btnMode.classList.toggle('active', !isSR); // highlight when in FFmpeg mode (non-default)
  }

  // ─── Messages from extension host ──────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'settings':
        vadMode = msg.vadMode;
        recognitionLanguage = msg.language || 'en-US';
        if (msg.transcriptionMode) {
          transcriptionMode = msg.transcriptionMode;
          updateModeButton();
        }
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
        // Stop recognition so WSA doesn't send speechFinal during the wake monitor loop.
        if (recognition) {
          intentionalStop = true;
          try { recognition.stop(); } catch (_) {}
          recognition = null;
        }
        setPaused(true);
        break;

      case 'autoPaused':
        setPaused(true);
        setStatus('paused', '⏸ Auto-paused — say "resume" to continue');
        break;

      case 'resumed':
        setPaused(false);
        clearSrVadTimer();
        // Restart Web Speech API recognition after resume (SR mode)
        if (transcriptionMode === 'speechRecognition' && !recognition) startRecognition();
        break;

      case 'wakeReady':
        setStatus('paused', '🎙 Listening for "resume"...');
        break;

      case 'transcriptResult':
        if (isRecording && !isPaused) {
          // Live rolling update — host prepends full buffer, just render it.
          if (msg.text) {
            transcriptBox.innerHTML = msg.text;
            transcriptBox.classList.add('has-content');
          }
        } else {
          // Final sync after send / cancel / clear.
          committedText = msg.text || '';
          interimText   = '';
          renderLiveTranscript();
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
        hideEnhanceReview();
        setStatus('processing', 'Enhancing with Gemini…');
        break;

      case 'elaborated':
        spinner.classList.add('hidden');
        showEnhanceReview(msg.prompt, msg.original);
        break;

      case 'enhancedApproved':
        hideEnhanceReview();
        setStatus('idle', '✨ Enhancement approved');
        break;

      case 'enhancedRejected':
        hideEnhanceReview();
        committedText = msg.original;
        interimText   = '';
        renderLiveTranscript();
        setStatus('idle', '↩ Original restored');
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

  btnMode.addEventListener('click', () => {
    transcriptionMode = transcriptionMode === 'speechRecognition' ? 'ffmpeg' : 'speechRecognition';
    updateModeButton();
    post({ type: 'setTranscriptionMode', mode: transcriptionMode });
    // If currently recording, restart with the new engine
    if (isRecording && !isPaused) {
      stopRecognition(false);
      setTimeout(() => startRecognition(), 200);
    }
  });

  // Enhance review buttons
  btnApprove.addEventListener('click', () => post({ type: 'enhancementDecision', action: 'approve' }));
  btnReject.addEventListener('click',  () => post({ type: 'enhancementDecision', action: 'reject' }));
  btnRegen.addEventListener('click',   () => {
    spinner.classList.remove('hidden');
    hideEnhanceReview();
    setStatus('processing', 'Enhancing with Gemini…');
    post({ type: 'enhancementDecision', action: 'regenerate' });
  });


  // ─── Init ──────────────────────────────────────────────────────────────────
  post({ type: 'ready' });

})();
