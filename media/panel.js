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
  const btnDeepgram      = document.getElementById('btn-deepgram');
  const btnHotkey        = document.getElementById('btn-hotkey');
  const btnTarget        = document.getElementById('btn-target');
  const btnTargetLabel   = document.getElementById('btn-target-label');
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
  const btnMode          = document.getElementById('btn-mode');

  // ─── Onboarding DOM refs ───────────────────────────────────────────────────
  const obOverlay       = document.getElementById('onboarding-overlay');
  const obScreen1       = document.getElementById('ob-screen-1');
  const obScreen2       = document.getElementById('ob-screen-2');
  const obScreen3       = document.getElementById('ob-screen-3');
  const obEngineDeepgram= document.getElementById('ob-engine-deepgram');
  const obEngineGemini  = document.getElementById('ob-engine-gemini');
  const obBack2         = document.getElementById('ob-back-2');
  const obSkipKey       = document.getElementById('ob-skip-key');
  const obNext2         = document.getElementById('ob-next-2');
  const obKeyTitle      = document.getElementById('ob-key-title');
  const obKeyDesc       = document.getElementById('ob-key-desc');
  const obKeyLink       = document.getElementById('ob-key-link');
  const obKeyInput      = document.getElementById('ob-key-input');
  const obKeyHint       = document.getElementById('ob-key-hint');
  const obBack3         = document.getElementById('ob-back-3');
  const obModeContinuous= document.getElementById('ob-mode-continuous');
  const obModeVoice     = document.getElementById('ob-mode-voice');
  const obWakeRow       = document.getElementById('ob-wake-row');
  const obWakeInput     = document.getElementById('ob-wake-input');
  const obFinish        = document.getElementById('ob-finish');

  // ─── Engine picker DOM refs ────────────────────────────────────────────────
  const btnEngine    = document.getElementById('btn-engine');
  const engineLabel  = document.getElementById('engine-label');
  const engineMenu   = document.getElementById('engine-menu');
  const eoPicker     = document.getElementById('engine-picker');
  const eoCheckGemini   = document.getElementById('eo-check-gemini');
  const eoCheckDeepgram = document.getElementById('eo-check-deepgram');
  const eoManageKeys    = document.getElementById('eo-manage-keys');

  // ─── State ─────────────────────────────────────────────────────────────────
  let isRecording      = false;
  let isPaused         = false;
  let activationMode   = 'wake';          // 'wake' | 'manual'
  let postSendMode     = 'pause';         // 'continuous' | 'pause'
  let wakePhrase       = 'hey antigravity';
  let hasApiKey        = false;
  let deepgramActive   = false;
  let activeEngine     = 'gemini';        // 'gemini' | 'deepgram'
  let hotkeyCombo      = 'Ctrl+Shift+Space'; // updated by hotkeyStatus
  let isReviewing      = false;
  let savedEnhanced    = '';
  let committedText    = '';
  let interimText      = '';

  // Onboarding state
  let obEngine = 'gemini'; // 'gemini' | 'deepgram'

  function post(msg) { vscode.postMessage(msg); }

  /** Keep .vc-wake spans in sync with the configured wake phrase */
  function updateWakeSpans(phrase) {
    document.querySelectorAll('.vc-wake').forEach(el => { el.textContent = phrase || 'hey antigravity'; });
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

  /** Updates the hint text below the mic button based on current settings + state */
  function updateHint() {
    if (isRecording && !isPaused) {
      recordHint.textContent = postSendMode === 'continuous' ? 'Continuous — click to stop' : 'Listening — click to stop';
    } else if (isPaused) {
      recordHint.textContent = 'Paused — mic in monitor mode';
    } else {
      // Idle state: show wake phrase hint if activationMode=wake
      if (activationMode === 'wake') {
        recordHint.textContent = `Say "${wakePhrase}" or ${hotkeyCombo}`;
      } else {
        recordHint.textContent = hotkeyCombo;
      }
    }
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
    } else if (!active) {
      stopDots();
      btnPause.classList.add('hidden');
    }
    updateHint();
  }

  function setPaused(active) {
    isPaused = active;
    if (active) {
      btnRecord.classList.remove('recording');  // kill the red ring
      btnPause.disabled = false;                // re-enable after host confirms
      stopDots();
      interimText = '';
      renderLiveTranscript();
      setStatus('paused', 'Paused — say "resume" or "I\'m back"');
      btnPause.textContent = '▶';
      btnPause.title = 'Resume recording';
      btnPause.classList.remove('hidden');
      transcriptBox.classList.remove('active');
    } else {
      setStatus('listening', 'Listening...');
      startDots();
      btnPause.textContent = '⏸';
      btnPause.title = 'Pause — mic stays on, buffer preserved';
      transcriptBox.classList.add('active');
    }
    updateHint();
  }


  // ─── Settings panel ────────────────────────────────────────────────────────
  const settingsPanel     = document.getElementById('settings-panel');
  const settingsClose     = document.getElementById('settings-close');
  const settingsSave      = document.getElementById('settings-save');
  const settingsWakeInput = document.getElementById('settings-wake-input');
  const wakePhraseRow     = document.getElementById('wake-phrase-row');
  const scWake            = document.getElementById('sc-wake');
  const scManual          = document.getElementById('sc-manual');
  const scContinuous      = document.getElementById('sc-continuous');
  const scPause           = document.getElementById('sc-pause');

  function openSettings() {
    // Pre-fill with current state
    settingsWakeInput.value = wakePhrase;
    _selectCard(scWake,       activationMode === 'wake');
    _selectCard(scManual,     activationMode === 'manual');
    _selectCard(scContinuous, postSendMode   === 'continuous');
    _selectCard(scPause,      postSendMode   === 'pause');
    wakePhraseRow.classList.toggle('hidden', activationMode !== 'wake');
    settingsPanel.classList.remove('hidden');
  }

  function closeSettings() {
    settingsPanel.classList.add('hidden');
  }

  function _selectCard(el, selected) {
    el.classList.toggle('selected', selected);
    const radio = el.querySelector('input[type="radio"]');
    if (radio) radio.checked = selected;
  }

  // Radio card clicks
  [scWake, scManual].forEach(card => {
    card.addEventListener('click', () => {
      const val = card.querySelector('input').value;
      _selectCard(scWake,   val === 'wake');
      _selectCard(scManual, val === 'manual');
      wakePhraseRow.classList.toggle('hidden', val !== 'wake');
    });
  });

  [scContinuous, scPause].forEach(card => {
    card.addEventListener('click', () => {
      const val = card.querySelector('input').value;
      _selectCard(scContinuous, val === 'continuous');
      _selectCard(scPause,      val === 'pause');
    });
  });

  settingsClose.addEventListener('click', closeSettings);
  settingsPanel.addEventListener('click', (e) => {
    if (e.target === settingsPanel) closeSettings(); // click backdrop to close
  });

  settingsSave.addEventListener('click', () => {
    const newActivation = scWake.classList.contains('selected') ? 'wake' : 'manual';
    const newPostSend   = scContinuous.classList.contains('selected') ? 'continuous' : 'pause';
    const newPhrase     = settingsWakeInput.value.trim() || 'hey antigravity';
    post({ type: 'applySettings', activationMode: newActivation, postSendMode: newPostSend, wakePhrase: newPhrase });
    closeSettings();
  });

  /** Apply conversation mode locally after onboarding (host will also echo back via settingsStatus) */
  function setConvMode(mode) {
    // mode: 'continuous' | 'voiceActivated'
    const isContinuous = mode === 'continuous';
    postSendMode   = isContinuous ? 'continuous' : 'pause';
    activationMode = isContinuous ? 'manual'     : 'wake';
    btnMode.classList.toggle('mode-continuous', isContinuous);
    btnMode.classList.toggle('mode-voice',      !isContinuous);
    btnMode.textContent = isContinuous
      ? '🔄 Continuous'
      : `🎙 ${wakePhrase.length > 16 ? 'WAKE' : wakePhrase}`;
    updateHint();
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
        // Legacy vadMode — ignore
        break;

      case 'settingsStatus':
        activationMode = msg.activationMode || 'wake';
        postSendMode   = msg.postSendMode   || 'pause';
        wakePhrase     = msg.wakePhrase     || 'hey antigravity';
        // Keep onboarding wake input in sync
        if (obWakeInput) obWakeInput.value = wakePhrase;
        // Update hint text and example spans immediately
        updateHint();
        updateWakeSpans(wakePhrase);
        // Update header button label to reflect active mode
        btnMode.textContent = activationMode === 'wake'
          ? `🎙 ${wakePhrase.length > 16 ? 'WAKE' : wakePhrase}`
          : '👆 Manual';
        break;

      case 'showOnboarding':
        obOverlay.classList.remove('hidden');
        break;

      case 'apiKeyStatus':
        hasApiKey = msg.hasKey;
        btnApiKey.classList.toggle('key-set', msg.hasKey);
        btnApiKey.title = msg.hasKey
          ? 'Gemini key active ✓ (click to update)'
          : 'No API key — click to add';
        break;

      case 'hotkeyStatus':
        hotkeyCombo = msg.combo || 'Ctrl+Shift+Space';
        btnHotkey.title = `Global hotkey: ${hotkeyCombo} — click to change`;
        btnHotkey.textContent = '⌨ ' + hotkeyCombo;
        break;

      case 'deepgramKeyStatus':
        deepgramActive = msg.active && msg.hasKey;
        // If the host reports the engine, sync button label
        if (msg.engine) { activeEngine = msg.engine; updateEngineButton(); }
        btnDeepgram.classList.toggle('dg-active', deepgramActive);
        break;

      case 'targetState':
        if (btnTarget && btnTargetLabel) {
          var isClaude = msg.target === 'claude-code';
          btnTargetLabel.textContent = isClaude ? '→ CC' : '→ AG';
          btnTarget.classList.toggle('target-claude', isClaude);
          btnTarget.classList.toggle('target-antigravity', !isClaude);
          var lockTxt = msg.lockedTitle ? ' 🔒 ' + msg.lockedTitle.slice(0, 20) : '';
          btnTarget.title = isClaude
            ? 'Target: Claude Code' + lockTxt + ' — click to switch, shift-click to lock conversation'
            : 'Target: Antigravity — click to switch';
        }
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

      case 'hotkeyStatus':
        hotkeyCombo = msg.combo || 'Ctrl+Shift+Space';
        btnHotkey.title = `Global hotkey: ${hotkeyCombo} — click to change`;
        btnHotkey.textContent = '⌨ ' + hotkeyCombo;
        updateHint(); // refresh hint to show new keybind
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
        setStatus('paused', 'Paused — say "resume" or "I\'m back"');
        break;

      case 'resumed':
        setPaused(false);
        break;

      case 'wakeReady':
        setStatus('paused', 'Paused — say "resume" or "I\'m back"');
        break;

      case 'transcriptResult':
        if (msg.text) {
          committedText = msg.text;           // keep in sync so re-renders don't wipe it
          interimText   = '';
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
    if (isPaused) {
      post({ type: 'resumeRecording' });
    } else {
      btnPause.disabled = true;   // block rapid re-clicks until host confirms paused
      stopRecording(true);
    }
  });


  btnVad && btnVad.addEventListener('click', () => {});

  btnMode.addEventListener('click', () => openSettings());

  btnApiKey.addEventListener('click',   () => post({ type: 'openSettings' }));
  btnInfo.addEventListener('click',     () => post({ type: 'showInfo' }));
  btnContext.addEventListener('click',  () => post({ type: 'selectContext' }));
  btnDeepgram.addEventListener('click', () => post({ type: 'manageDeepgramKey' }));

  // ─── Engine picker ─────────────────────────────────────────────────────────
  function updateEngineButton() {
    if (activeEngine === 'deepgram') {
      engineLabel.textContent = '⚡ Deepgram';
      btnEngine.classList.add('engine-deepgram');
      btnEngine.classList.remove('engine-gemini');
      eoCheckDeepgram.style.visibility = 'visible';
      eoCheckGemini.style.visibility   = 'hidden';
    } else {
      engineLabel.textContent = '✦ Gemini';
      btnEngine.classList.add('engine-gemini');
      btnEngine.classList.remove('engine-deepgram');
      eoCheckGemini.style.visibility   = 'visible';
      eoCheckDeepgram.style.visibility = 'hidden';
    }
  }
  updateEngineButton(); // set initial state

  btnEngine.addEventListener('click', (e) => {
    e.stopPropagation();
    engineMenu.classList.toggle('hidden');
  });

  // Close menu when clicking outside
  document.addEventListener('click', (e) => {
    if (!eoPicker.contains(e.target)) engineMenu.classList.add('hidden');
  });

  document.querySelectorAll('.engine-option[data-engine]').forEach(btn => {
    btn.addEventListener('click', () => {
      const eng = btn.dataset.engine;
      if (eng === activeEngine) { engineMenu.classList.add('hidden'); return; }
      activeEngine = eng;
      updateEngineButton();
      engineMenu.classList.add('hidden');
      post({ type: 'setEngine', engine: eng });
    });
  });

  eoManageKeys && eoManageKeys.addEventListener('click', () => {
    engineMenu.classList.add('hidden');
    post({ type: 'openSettings' });
  });

  // ⌨ KEY button — opens VS Code's keyboard shortcut editor pre-filtered to
  // the VTP toggle command so the user can remap it without leaving the panel.
  btnHotkey.addEventListener('click', () => {
    post({ type: 'openKeybindings' });
  });

  // → Target button — short click switches Antigravity ↔ Claude Code,
  // long-press / shift-click opens the Claude conversation lock picker.
  if (btnTarget) {
    btnTarget.addEventListener('click', (ev) => {
      if (ev.shiftKey) {
        post({ type: 'lockClaudeConversation' });
      } else {
        post({ type: 'switchInjectionTarget' });
      }
    });
    btnTarget.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      post({ type: 'lockClaudeConversation' });
    });
  }

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

  // ─── Onboarding wizard ─────────────────────────────────────────────────────

  const ENGINE_META = {
    deepgram: {
      title:   'Enter your Deepgram API key',
      desc:    'Free tier: 200 hrs/month. Real-time streaming, ~300ms latency.',
      link:    'https://console.deepgram.com/signup',
      linkTxt: 'Get a free Deepgram key →',
      hint:    'Starts with "Token " or is a long hex string.',
    },
    gemini: {
      title:   'Enter your Gemini API key',
      desc:    'Free tier available via Google AI Studio. Used for transcription and intent detection.',
      link:    'https://aistudio.google.com/apikey',
      linkTxt: 'Get a free Gemini key →',
      hint:    'Starts with "AIza". Stored in VS Code SecretStorage — never written to disk.',
    },
  };

  function obShowScreen(screen) {
    [obScreen1, obScreen2, obScreen3].forEach(s => s.classList.add('hidden'));
    screen.classList.remove('hidden');
  }

  // Screen 1: engine choice
  obEngineDeepgram.addEventListener('click', () => {
    obEngine = 'deepgram';
    [obEngineDeepgram, obEngineGemini].forEach(b => b.classList.remove('selected'));
    obEngineDeepgram.classList.add('selected');
    const m = ENGINE_META.deepgram;
    obKeyTitle.textContent = m.title;
    obKeyDesc.textContent  = m.desc;
    obKeyLink.textContent  = m.linkTxt;
    obKeyLink.href         = m.link;
    obKeyHint.textContent  = m.hint;
    obKeyInput.value       = '';
    obKeyInput.placeholder = 'Paste your Deepgram API key';
    setTimeout(() => obShowScreen(obScreen2), 120);
  });

  obEngineGemini.addEventListener('click', () => {
    obEngine = 'gemini';
    [obEngineDeepgram, obEngineGemini].forEach(b => b.classList.remove('selected'));
    obEngineGemini.classList.add('selected');
    const m = ENGINE_META.gemini;
    obKeyTitle.textContent = m.title;
    obKeyDesc.textContent  = m.desc;
    obKeyLink.textContent  = m.linkTxt;
    obKeyLink.href         = m.link;
    obKeyHint.textContent  = m.hint;
    obKeyInput.value       = '';
    obKeyInput.placeholder = 'Paste your Gemini API key (starts with AIza...)';
    setTimeout(() => obShowScreen(obScreen2), 120);
  });

  // Screen 2: back / continue
  obBack2.addEventListener('click', () => obShowScreen(obScreen1));

  function obGoToScreen3() {
    obShowScreen(obScreen3);
    // Preselect Voice Activated by default
    obModeVoice.classList.add('selected');
    obModeContinuous.classList.remove('selected');
    obWakeRow.classList.remove('hidden');
    obFinish.disabled = false;
  }

  obSkipKey.addEventListener('click', () => obGoToScreen3());
  obNext2.addEventListener('click', () => {
    const key = obKeyInput.value.trim();
    if (!key) {
      obKeyHint.textContent = '⚠ Paste a key or click "Skip for now"';
      obKeyHint.style.color = '#f7768e';
      return;
    }
    obKeyHint.style.color = '';
    obGoToScreen3();
  });

  // Screen 3: flow mode
  obBack3.addEventListener('click', () => obShowScreen(obScreen2));

  let obMode = 'voiceActivated';

  function selectObMode(mode) {
    obMode = mode;
    obModeContinuous.classList.toggle('selected', mode === 'continuous');
    obModeVoice.classList.toggle('selected', mode === 'voiceActivated');
    if (mode === 'voiceActivated') {
      obWakeRow.classList.remove('hidden');
    } else {
      obWakeRow.classList.add('hidden');
    }
    obFinish.disabled = false;
  }

  obModeContinuous.addEventListener('click', () => selectObMode('continuous'));
  obModeVoice.addEventListener('click',      () => selectObMode('voiceActivated'));

  obFinish.addEventListener('click', () => {
    const key        = obKeyInput.value.trim();
    const phrase     = (obWakeInput.value.trim() || 'hey antigravity').toLowerCase();
    const isContinuous = obMode === 'continuous';
    const payload = {
      type:           'onboardingComplete',
      engine:         obEngine,
      activationMode: isContinuous ? 'manual' : 'wake',
      postSendMode:   isContinuous ? 'continuous' : 'pause',
      wakePhrase:     phrase,
    };
    if (key) {
      if (obEngine === 'deepgram') { payload.deepgramKey = key; }
      else                         { payload.geminiKey   = key; }
    }
    post(payload);
    // Update local state immediately (host will also echo via settingsStatus)
    wakePhrase = phrase;
    setConvMode(obMode);
    updateWakeSpans(phrase);
    // Fade out overlay
    obOverlay.style.animation = 'ob-fade-in 0.2s var(--ease) reverse forwards';
    setTimeout(() => obOverlay.classList.add('hidden'), 220);
  });

})();
