// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  const _dbgEl = document.getElementById('vtp-debug');
  const _dbgLines = [];
  function dbg(text) {
    _dbgLines.push(text);
    if (_dbgLines.length > 12) _dbgLines.shift();
    if (_dbgEl) { _dbgEl.textContent = _dbgLines.join('\n'); _dbgEl.classList.remove('hidden'); }
  }
  function post(msg) {
    if (msg && msg.type === 'log') dbg(msg.message);
    if (msg && msg.type === 'voskError') dbg('✗ ' + msg.message);
    vscode.postMessage(msg);
  }

  window.addEventListener('error', (e) => {
    post({ type: 'log', message: '[error] ' + (e.message || '') + ' @ ' + (e.filename || '').split('/').pop() + ':' + (e.lineno || 0) });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    post({ type: 'log', message: '[rejection] ' + ((r && r.message) || String(r)) });
  });
  document.addEventListener('securitypolicyviolation', (e) => {
    post({ type: 'log', message: '[CSP BLOCKED] ' + e.violatedDirective + ' → ' + (e.blockedURI || e.sourceFile || '') });
  });
  post({ type: 'log', message: '[panel] booted · WASM=' + (typeof WebAssembly !== 'undefined') +
        ' Worker=' + (typeof Worker !== 'undefined') + ' Vosk=' + (typeof window.Vosk !== 'undefined') });

  setInterval(() => {
    const q = window.__vtpWorkerErrors;
    if (q && q.length) { while (q.length) post({ type: 'log', message: '[WORKER] ' + q.shift() }); }
  }, 500);

  const vosk = window.__initVosk ? window.__initVosk(post) : null;
  if (!vosk) { post({ type: 'log', message: '[panel] voskCapture failed to init — window.__initVosk missing' }); }

  const statusBar        = document.getElementById('status-bar');
  const statusText       = document.getElementById('status-text');
  const contextWorkspace = document.getElementById('context-workspace');
  const contextConv      = document.getElementById('context-conv');
  const contextPin       = document.getElementById('context-pin');
  const contextIcon      = document.getElementById('context-icon');
  const btnContext       = document.getElementById('btn-context');
  const transcriptBox    = document.getElementById('transcript-box');
  const btnRecord        = document.getElementById('btn-record');
  const btnClear         = document.getElementById('btn-clear');
  const btnPause         = document.getElementById('btn-pause');
  const btnInfo          = document.getElementById('btn-info');
  const btnHotkey        = document.getElementById('btn-hotkey');
  const btnTarget        = document.getElementById('btn-target');
  const btnTargetLabel   = document.getElementById('btn-target-label');
  const btnMode          = document.getElementById('btn-mode');
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
  const modelBanner      = document.getElementById('model-banner');
  const modelBannerText  = document.getElementById('model-banner-text');
  const micMeter         = document.getElementById('mic-meter');
  const micMeterTrack    = document.getElementById('mic-meter-track');
  const micMeterMask     = document.getElementById('mic-meter-mask');
  const micMeterPeak     = document.getElementById('mic-meter-peak');
  const micMeterGate     = document.getElementById('mic-meter-gate');
  const micMeterLabel    = document.getElementById('mic-meter-label');

  const obOverlay        = document.getElementById('onboarding-overlay');
  const obScreen1        = document.getElementById('ob-screen-1');
  const obScreen2        = document.getElementById('ob-screen-2');
  const obStart          = document.getElementById('ob-start');
  const obBack2          = document.getElementById('ob-back-2');
  const obModeContinuous = document.getElementById('ob-mode-continuous');
  const obModeVoice      = document.getElementById('ob-mode-voice');
  const obWakeRow        = document.getElementById('ob-wake-row');
  const obWakeInput      = document.getElementById('ob-wake-input');
  const obFinish         = document.getElementById('ob-finish');

  const settingsPanel     = document.getElementById('settings-panel');
  const settingsClose     = document.getElementById('settings-close');
  const settingsSave      = document.getElementById('settings-save');
  const settingsWakeInput = document.getElementById('settings-wake-input');
  const wakePhraseRow     = document.getElementById('wake-phrase-row');
  const scWake            = document.getElementById('sc-wake');
  const scManual          = document.getElementById('sc-manual');
  const scContinuous      = document.getElementById('sc-continuous');
  const scPause           = document.getElementById('sc-pause');

  let isRecording   = false;
  let isPaused      = false;
  let activationMode = 'wake';
  let postSendMode   = 'pause';
  let wakePhrase     = 'hey antigravity';
  let hotkeyCombo    = 'Ctrl+Shift+Space';
  let currentTarget  = 'antigravity';
  let lockedTitle    = '';
  let cachedAg = { workspaceName: '', conversationTitle: '', pinned: false, extrasCount: 0 };
  let modelReady = false;
  let _modelChunks = [];

  function _b64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function updateWakeSpans(phrase) {
    document.querySelectorAll('.vc-wake').forEach(el => { el.textContent = phrase || 'hey antigravity'; });
  }

  function renderTranscript(text) {
    if (text) {
      transcriptBox.innerHTML = text;
      transcriptBox.classList.add('has-content');
    } else {
      transcriptBox.textContent = 'Your speech will appear here...';
      transcriptBox.classList.remove('has-content');
    }
  }

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

  function setStatus(state, text) {
    statusBar.className = 'status-bar status-' + state;
    statusText.textContent = text;
  }

  function updateHint() {
    if (isRecording && !isPaused) {
      recordHint.textContent = postSendMode === 'continuous' ? 'Continuous — click to stop' : 'Listening — click to stop';
    } else if (isPaused) {
      recordHint.textContent = 'Paused — mic in monitor mode';
    } else if (!modelReady) {
      recordHint.textContent = 'Preparing speech model…';
    } else if (activationMode === 'wake') {
      recordHint.textContent = `Say "${wakePhrase}" or ${hotkeyCombo}`;
    } else {
      recordHint.textContent = hotkeyCombo;
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
    } else if (!active) {
      stopDots();
      btnPause.classList.add('hidden');
    }
    updateHint();
  }

  function setPaused(active) {
    isPaused = active;
    if (active) {
      btnRecord.classList.remove('recording');
      btnPause.disabled = false;
      stopDots();
      setStatus('paused', 'Paused — say "resume" or "I\'m back"');
      btnPause.textContent = '▶';
      btnPause.classList.remove('hidden');
      transcriptBox.classList.remove('active');
    } else {
      setStatus('listening', 'Listening...');
      startDots();
      btnPause.textContent = '⏸';
      transcriptBox.classList.add('active');
    }
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

  function showEnhanceReview(enhanced, original) {
    transcriptBox.innerHTML = enhanced;
    transcriptBox.classList.add('has-content', 'enhanced-mode');
    enhancedText.textContent = enhanced;
    originalText.textContent = original;
    enhanceReview.classList.remove('hidden');
    setStatus('ready', '✨ Approve, Reject, or Try Again');
  }
  function hideEnhanceReview() {
    enhanceReview.classList.add('hidden');
    transcriptBox.classList.remove('enhanced-mode');
  }

  function clearAll() {
    isPaused = false;
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

  function showBanner(text) { modelBannerText.textContent = text; modelBanner.classList.remove('hidden'); }
  function hideBanner() { modelBanner.classList.add('hidden'); }

  const METER_FLOOR_DB = -60;
  const SPEECH_RMS     = 0.005;
  const SILENT_RMS     = 0.0003;
  const QUIET_TICKS    = 30;
  const STT_SILENT_MS  = 6000;

  let micOn        = false;
  let micIsTest    = false;
  let micDevice    = '';
  let meterLevel   = 0;
  let meterPeak    = 0;
  let quietTicks   = 0;
  let quietMaxRms  = 0;
  let gateDb       = -45;
  let gateOpen     = false;
  let draggingGate = false;

  function levelToBar(v) {
    if (!(v > 0.00001)) return 0;
    const db = 20 * Math.log10(v);
    return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
  }

  function dbToBar(db) {
    return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
  }

  function paintMeter() {
    micMeterMask.style.width = (100 - Math.round(meterLevel * 100)) + '%';
    micMeterPeak.style.left = Math.round(meterPeak * 100) + '%';
    micMeterPeak.classList.toggle('hidden', meterPeak < 0.02);
    const gatePct = Math.round(dbToBar(gateDb) * 100);
    micMeterGate.style.left = gatePct + '%';
    micMeterTrack.style.setProperty('--gate-pos', gatePct + '%');
  }

  function setMeterState(cls, label) {
    micMeter.className = 'mic-meter ' + cls;
    micMeterLabel.textContent = label;
  }

  function resetMeter() {
    meterLevel = 0; meterPeak = 0; quietTicks = 0; quietMaxRms = 0;
    paintMeter();
    setMeterState('is-off', 'Mic off — click to test');
    micMeter.title = micDevice ? ('Last input: ' + micDevice) : 'Live microphone input level';
  }

  function dbOf(rms) {
    return rms > 0.000001 ? Math.round(20 * Math.log10(rms)) : -99;
  }

  function onMicLevel(msg) {
    const bar = levelToBar(msg.rms);
    meterLevel = bar > meterLevel ? bar : meterLevel * 0.75 + bar * 0.25;
    meterPeak  = Math.max(meterPeak * 0.9, levelToBar(msg.peak));
    paintMeter();

    const hearing = msg.rms >= SPEECH_RMS;
    if (hearing) { quietTicks = 0; quietMaxRms = 0; }
    else { quietTicks++; quietMaxRms = Math.max(quietMaxRms, msg.rms); }
    gateOpen = !!msg.gateOpen;
    if (!draggingGate && typeof msg.gateDb === 'number') gateDb = msg.gateDb;

    micMeter.title = (micDevice ? 'Input: ' + micDevice + '\n' : '') +
                     'Level: ' + dbOf(msg.rms) + ' dBFS (speech should peak above -35)\n' +
                     'Sensitivity: ' + gateDb + ' dBFS — drag the marker to change';

    if (msg.stalled) {
      setMeterState('is-dead', 'No audio from ' + (micDevice || 'mic'));
    } else if (quietTicks > QUIET_TICKS && quietMaxRms < SILENT_RMS) {
      setMeterState('is-quiet', 'No input — check ' + (micDevice || 'your mic'));
    } else if (quietTicks > QUIET_TICKS) {
      setMeterState('is-quiet', 'Input too low (' + dbOf(quietMaxRms) + ' dB) — raise mic volume');
    } else if (gateOpen && msg.msSinceStt > STT_SILENT_MS) {
      setMeterState('is-nostt', 'Audio OK — no words recognized');
    } else if (gateOpen) {
      setMeterState('is-live', micIsTest ? 'Mic test — hearing you' : 'Transcribing…');
    } else if (hearing) {
      setMeterState('is-gated', 'Below sensitivity — ignoring');
    } else {
      setMeterState('is-live', micIsTest ? 'Mic test — say something' : 'Listening…');
    }
  }

  function onMicState(msg) {
    micOn = !!msg.on;
    micIsTest = !!msg.test;
    if (msg.device) micDevice = msg.device;
    if (typeof msg.gateDb === 'number' && !draggingGate) { gateDb = msg.gateDb; paintMeter(); }
    if (micOn) {
      quietTicks = 0;
      micMeter.title = micDevice ? ('Input: ' + micDevice) : 'Live microphone input level';
      setMeterState('is-live', micIsTest ? 'Mic test — say something' : 'Listening…');
    } else {
      resetMeter();
    }
  }

  micMeter.addEventListener('click', () => { if (!micOn && !draggingGate) post({ type: 'micTest' }); });

  function gateFromPointer(e) {
    const box = micMeterTrack.getBoundingClientRect();
    if (!box.width) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
    gateDb = Math.round(METER_FLOOR_DB + frac * -METER_FLOOR_DB);
    micMeterLabel.textContent = 'Sensitivity ' + gateDb + ' dB';
    paintMeter();
  }
  micMeterTrack.addEventListener('pointerdown', (e) => {
    draggingGate = true;
    micMeterTrack.setPointerCapture(e.pointerId);
    gateFromPointer(e);
    e.stopPropagation();
  });
  micMeterTrack.addEventListener('pointermove', (e) => { if (draggingGate) gateFromPointer(e); });
  micMeterTrack.addEventListener('pointerup', (e) => {
    if (!draggingGate) return;
    draggingGate = false;
    try { micMeterTrack.releasePointerCapture(e.pointerId); } catch (_) {}
    post({ type: 'setInputGate', db: gateDb });
    e.stopPropagation();
  });

  resetMeter();

  window.addEventListener('message', async (event) => {
    const msg = event.data;
    switch (msg.type) {

      case 'voskModelChunk':
        try {
          if (msg.index === 0) { _modelChunks = []; }
          if (msg.data) { _modelChunks.push(_b64ToBytes(msg.data)); }
          showBanner('Loading speech model… ' + Math.round(((msg.index + 1) / msg.count) * 100) + '%');
          if (msg.done) {
            let total = 0;
            for (const c of _modelChunks) total += c.length;
            const all = new Uint8Array(total);
            let off = 0;
            for (const c of _modelChunks) { all.set(c, off); off += c.length; }
            _modelChunks = [];
            post({ type: 'log', message: '[panel] assembled model: ' + total + ' bytes' });
            await vosk.loadModel(all.buffer);
          }
        } catch (e) {
          post({ type: 'voskError', message: 'Model assemble failed: ' + (e && e.message ? e.message : String(e)) });
        }
        break;
      case 'micState': onMicState(msg); break;
      case 'micLevel': onMicLevel(msg); break;
      case 'voskStart': if (vosk) vosk.startSession(); break;
      case 'voskPcm':   if (vosk) vosk.feedPcm(msg.data); break;
      case 'voskStop':  if (vosk) vosk.stopSession(); break;
      case 'modelStatus':
        if (msg.state === 'downloading') {
          showBanner(msg.message ? msg.message : (msg.pct != null ? `Downloading speech model… ${msg.pct}%` : 'Downloading speech model…'));
        } else if (msg.state === 'loading') {
          showBanner('Loading speech model…');
        } else if (msg.state === 'ready') {
          modelReady = true;
          hideBanner();
          updateHint();
        } else if (msg.state === 'error') {
          showBanner('⚠ Speech model error: ' + (msg.message || 'unknown'));
        }
        break;

      case 'settingsStatus':
        activationMode = msg.activationMode || 'wake';
        postSendMode   = msg.postSendMode   || 'pause';
        wakePhrase     = msg.wakePhrase     || 'hey antigravity';
        if (obWakeInput) obWakeInput.value = wakePhrase;
        updateHint();
        updateWakeSpans(wakePhrase);
        btnMode.textContent = activationMode === 'wake'
          ? `🎙 ${wakePhrase.length > 16 ? 'WAKE' : wakePhrase}`
          : '👆 Manual';
        break;

      case 'showOnboarding':
        obOverlay.classList.remove('hidden');
        break;

      case 'hotkeyStatus':
        hotkeyCombo = msg.combo || 'Ctrl+Shift+Space';
        btnHotkey.title = `Global hotkey: ${hotkeyCombo} — click to change`;
        btnHotkey.textContent = '⌨ ' + hotkeyCombo;
        updateHint();
        break;

      case 'targetState':
        currentTarget = (msg.target === 'claude-code') ? 'claude-code' : 'antigravity';
        lockedTitle   = msg.lockedTitle || '';
        if (btnTarget && btnTargetLabel) {
          const isClaude = currentTarget === 'claude-code';
          btnTargetLabel.textContent = isClaude ? '→ CC' : '→ AG';
          btnTarget.classList.toggle('target-claude', isClaude);
          btnTarget.classList.toggle('target-antigravity', !isClaude);
          btnTarget.title = isClaude
            ? 'Target: Claude Code — click to switch to Antigravity'
            : 'Target: Antigravity — click to switch to Claude Code';
        }
        renderContextCard();
        break;

      case 'contextUpdate':
        cachedAg = {
          workspaceName:     msg.workspaceName     || '',
          conversationTitle: msg.conversationTitle || '',
          pinned:            !!msg.pinned,
          extrasCount:       msg.extrasCount       || 0,
        };
        renderContextCard();
        break;

      case 'recordingStarted': setRecording(true); break;
      case 'vadAutoStop':      setStatus('processing', 'Processing...'); break;
      case 'recordingStopped':
        setRecording(false);
        if (!isPaused) setStatus('processing', 'Processing…');
        break;
      case 'paused':     setPaused(true); break;
      case 'autoPaused': setPaused(true); setStatus('paused', 'Paused — say "resume" or "I\'m back"'); break;
      case 'resumed':    setPaused(false); break;
      case 'wakeReady':  setStatus('idle', `Ready — say "${wakePhrase}"`); break;

      case 'transcriptResult':
        renderTranscript(msg.text || '');
        if (!isRecording && !isPaused && !msg.text) setStatus('idle', 'Ready — press Record');
        break;

      case 'commandFired':
        addCommandEntry(msg.description);
        setStatus('idle', 'Ready — press Record');
        break;

      case 'elaborating':
        spinner.classList.remove('hidden');
        hideEnhanceReview();
        setStatus('processing', 'Enhancing locally…');
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
        renderTranscript(msg.original);
        setStatus('idle', '↩ Original restored');
        break;
      case 'awaitingDecision':
        setStatus('processing', '🎙 Say: approve, reject, or try again');
        setTimeout(() => setStatus('processing', '✨ Approve, Reject, or Try Again'), 1800);
        break;

      case 'injected':
        clearAll();
        setStatus('idle', '✓ Sent');
        break;

      case 'error':
        spinner.classList.add('hidden');
        if (!isPaused) setStatus('idle', '⚠ ' + msg.message);
        break;
    }
  });

  function renderContextCard() {
    if (currentTarget === 'claude-code') {
      contextIcon.textContent = '🔒';
      btnContext.classList.add('context-claude');
      contextPin.classList.add('hidden');
      if (lockedTitle) {
        contextWorkspace.textContent = 'Locked to:';
        contextConv.textContent      = lockedTitle;
        btnContext.classList.add('context-locked');
      } else {
        contextWorkspace.textContent = 'No chat locked';
        contextConv.textContent      = 'Click to pick a Claude chat';
        btnContext.classList.remove('context-locked');
      }
    } else {
      contextIcon.textContent = '📂';
      btnContext.classList.remove('context-claude', 'context-locked');
      contextWorkspace.textContent = cachedAg.workspaceName     || '—';
      contextConv.textContent      = cachedAg.conversationTitle || '—';
      if (cachedAg.pinned) {
        contextPin.classList.remove('hidden');
        contextPin.textContent = cachedAg.extrasCount ? ('+' + cachedAg.extrasCount) : '📌';
      } else {
        contextPin.classList.add('hidden');
        contextPin.textContent = '📌';
      }
    }
  }

  btnRecord.addEventListener('click', () => {
    if (isPaused) { post({ type: 'resumeRecording' }); return; }
    if (isRecording) { post({ type: 'stopRecording' }); setRecording(false); }
    else { post({ type: 'startRecording' }); setStatus('listening', 'Starting…'); }
  });
  btnPause.addEventListener('click', () => {
    if (isPaused) { post({ type: 'resumeRecording' }); }
    else { btnPause.disabled = true; post({ type: 'pauseRecording' }); }
  });
  btnClear.addEventListener('click', () => {
    renderTranscript('');
    hideEnhanceReview();
    post({ type: 'cancel' });
    if (isRecording && !isPaused) setStatus('listening', 'Cleared — keep talking');
    else if (!isPaused) setStatus('idle', 'Ready — press Record');
  });
  btnMode.addEventListener('click', () => openSettings());
  btnInfo.addEventListener('click', () => post({ type: 'showInfo' }));
  btnContext.addEventListener('click', () => {
    if (currentTarget === 'claude-code') post({ type: 'lockClaudeConversation' });
    else post({ type: 'selectContext' });
  });
  btnHotkey.addEventListener('click', () => post({ type: 'openKeybindings' }));
  if (btnTarget) btnTarget.addEventListener('click', () => post({ type: 'switchInjectionTarget' }));
  btnApprove.addEventListener('click', () => post({ type: 'enhancementDecision', action: 'approve' }));
  btnReject.addEventListener('click',  () => post({ type: 'enhancementDecision', action: 'reject' }));
  btnRegen.addEventListener('click',   () => {
    spinner.classList.remove('hidden');
    hideEnhanceReview();
    setStatus('processing', 'Enhancing locally…');
    post({ type: 'enhancementDecision', action: 'regenerate' });
  });

  function selectCard(el, selected) {
    el.classList.toggle('selected', selected);
    const radio = el.querySelector('input[type="radio"]');
    if (radio) radio.checked = selected;
  }
  function openSettings() {
    settingsWakeInput.value = wakePhrase;
    selectCard(scWake,       activationMode === 'wake');
    selectCard(scManual,     activationMode === 'manual');
    selectCard(scContinuous, postSendMode   === 'continuous');
    selectCard(scPause,      postSendMode   === 'pause');
    wakePhraseRow.classList.toggle('hidden', activationMode !== 'wake');
    settingsPanel.classList.remove('hidden');
  }
  function closeSettings() { settingsPanel.classList.add('hidden'); }
  [scWake, scManual].forEach(card => card.addEventListener('click', () => {
    const val = card.querySelector('input').value;
    selectCard(scWake, val === 'wake');
    selectCard(scManual, val === 'manual');
    wakePhraseRow.classList.toggle('hidden', val !== 'wake');
  }));
  [scContinuous, scPause].forEach(card => card.addEventListener('click', () => {
    const val = card.querySelector('input').value;
    selectCard(scContinuous, val === 'continuous');
    selectCard(scPause, val === 'pause');
  }));
  settingsClose.addEventListener('click', closeSettings);
  settingsPanel.addEventListener('click', (e) => { if (e.target === settingsPanel) closeSettings(); });
  settingsSave.addEventListener('click', () => {
    const newActivation = scWake.classList.contains('selected') ? 'wake' : 'manual';
    const newPostSend   = scContinuous.classList.contains('selected') ? 'continuous' : 'pause';
    const newPhrase     = settingsWakeInput.value.trim() || 'hey antigravity';
    post({ type: 'applySettings', activationMode: newActivation, postSendMode: newPostSend, wakePhrase: newPhrase });
    closeSettings();
  });

  let obMode = 'voiceActivated';
  function obShow(screen) {
    [obScreen1, obScreen2].forEach(s => s.classList.add('hidden'));
    screen.classList.remove('hidden');
  }
  obStart.addEventListener('click', () => {
    obShow(obScreen2);
    obModeVoice.classList.add('selected');
    obModeContinuous.classList.remove('selected');
    obWakeRow.classList.remove('hidden');
  });
  obBack2.addEventListener('click', () => obShow(obScreen1));
  function selectObMode(mode) {
    obMode = mode;
    obModeContinuous.classList.toggle('selected', mode === 'continuous');
    obModeVoice.classList.toggle('selected', mode === 'voiceActivated');
    obWakeRow.classList.toggle('hidden', mode !== 'voiceActivated');
  }
  obModeContinuous.addEventListener('click', () => selectObMode('continuous'));
  obModeVoice.addEventListener('click',      () => selectObMode('voiceActivated'));
  obFinish.addEventListener('click', () => {
    const phrase = (obWakeInput.value.trim() || 'hey antigravity').toLowerCase();
    const isContinuous = obMode === 'continuous';
    post({
      type: 'onboardingComplete',
      activationMode: isContinuous ? 'manual' : 'wake',
      postSendMode:   isContinuous ? 'continuous' : 'pause',
      wakePhrase:     phrase,
    });
    wakePhrase = phrase;
    updateWakeSpans(phrase);
    obOverlay.classList.add('hidden');
  });

  post({ type: 'ready' });
})();
