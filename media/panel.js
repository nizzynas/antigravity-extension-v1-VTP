// @ts-nocheck
/**
 * VTP Webview Panel — FFmpeg + Gemini transcription engine.
 *
 * Pipeline: FFmpeg captures 1-second WAV chunks → Gemini transcribes live →
 *           final transcript → Gemini intent: SEND / ENHANCE / COMMAND / CANCEL
 *
 * Pause/Resume: FFmpeg stops; host monitors mic for wake phrases.
 */
(function () {
  const vscode = acquireVsCodeApi();

  // ─── DOM refs ──────────────────────────────────────────────────────────────
  const statusBar        = document.getElementById('status-bar');
  const statusText       = document.getElementById('status-text');
  const contextWorkspace = document.getElementById('context-workspace');
  const contextConv      = document.getElementById('context-conv');
  const contextPin       = document.getElementById('context-pin');
  const btnContext       = document.getElementById('btn-context');
  const transcriptBox    = document.getElementById('transcript-box');
  const btnRecord        = document.getElementById('btn-record');
  const btnPause         = document.getElementById('btn-pause');
  const btnVad           = document.getElementById('btn-vad');
  const btnApiKey        = document.getElementById('btn-apikey');
  const btnInfo          = document.getElementById('btn-info');
  const spinner          = document.getElementById('spinner');
  const recordHint       = document.getElementById('record-hint');
  const commandSection   = document.getElementById('command-section');
  const commandLog       = document.getElementById('command-log');
  const enhanceReview    = document.getElementById('enhance-review');
  const enhancedText     = document.getElementById('enhanced-text');
  const originalText     = document.getElementById('original-text');
  const btnApprove       = document.getElementById('btn-approve');
  const btnReject        = document.getElementById('btn-reject');
  const btnRegen         = document.getElementById('btn-regen');

  // ─── State ─────────────────────────────────────────────────────────────────
  let isRecording  = false;
  let isPaused     = false;
  let vadMode      = false;
  let hasApiKey    = false;
  let isReviewing  = false;
  let savedEnhanced = '';
  let committedText = '';
  let interimText   = '';

  function post(msg) { vscode.postMessage(msg); }

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
    committedText = text || '';
    interimText   = '';
    if (text) {
      transcriptBox.innerHTML = text;
      transcriptBox.classList.add('has-content');
    } else {
      transcriptBox.textContent = 'Your speech will appear here...';
      transcriptBox.classList.remove('has-content');
    }
  }

  // ─── Animated dots ────────────────────────────────────────────────────────
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
  function stopDots() { if (dotTimer) { clearInterval(dotTimer); dotTimer = null; } }

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
    committedText = enhanced;
    interimText   = '';
    transcriptBox.innerHTML = enhanced;
    transcriptBox.classList.add('has-content', 'enhanced-mode');
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

  // ─── Recording control ─────────────────────────────────────────────────────
  function startRecording() {
    committedText = '';
    interimText   = '';
    post({ type: 'startRecording' });
  }

  function stopRecording(pause = false) {
    post({ type: pause ? 'pauseRecording' : 'stopRecording' });
  }

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
        if (msg.pinned) {
          contextPin.classList.remove('hidden');
          contextPin.textContent = msg.extrasCount ? `+${msg.extrasCount}` : '📌';
          btnContext.title = `Extra context active — click to manage`;
        } else {
          contextPin.classList.add('hidden');
          contextPin.textContent = '📌';
          btnContext.title = 'Click to add extra conversation context';
        }
        break;

      case 'recordingStarted':
        setRecording(true);
        break;

      case 'vadAutoStop':
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
        break;

      case 'wakeReady':
        setStatus('paused', '🎙 Listening for "resume"...');
        break;

      case 'transcriptResult':
        if (msg.text) {
          transcriptBox.innerHTML = msg.text;
          transcriptBox.classList.add('has-content');
        } else {
          committedText = '';
          interimText   = '';
          renderLiveTranscript();
        }
        if (!isRecording && !isPaused) setStatus('idle', 'Ready — press Record');
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

      case 'awaitingDecision':
        // Non-decision speech was discarded — pulse the status bar as a reminder
        setStatus('processing', '🎙 Say: approve, reject, or try again');
        setTimeout(() => setStatus('processing', '✨ Approve, Reject, or Try Again'), 1800);
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
    if (isPaused) { post({ type: 'resumeRecording' }); return; }
    if (isRecording) {
      stopRecording(false);
      setRecording(false);
    } else {
      startRecording();
      setStatus('listening', 'Starting…');
    }
  });

  btnPause.addEventListener('click', () => {
    if (isPaused) { post({ type: 'resumeRecording' }); }
    else          { stopRecording(true); }
  });

  btnVad.addEventListener('click', () => {
    vadMode = !vadMode;
    btnVad.classList.toggle('active', vadMode);
    recordHint.textContent = vadMode ? 'Auto-stops on silence' : 'Push to Talk';
    post({ type: 'setVadMode', vadMode });
    if (vadMode && !isRecording && !isPaused)  { startRecording(); }
    else if (!vadMode && isRecording)           { stopRecording(false); }
  });

  btnApiKey.addEventListener('click', () => post({ type: 'openSettings' }));
  btnInfo.addEventListener('click',   () => post({ type: 'showInfo' }));
  btnContext.addEventListener('click', () => post({ type: 'selectContext' }));

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
