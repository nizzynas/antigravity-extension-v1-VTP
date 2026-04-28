// @ts-nocheck

/**
 * VTP Webview Panel script.
 * Audio capture is handled by the VS Code Speech extension (extension host side).
 * This script only manages UI state and relays messages.
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
  let isRecording   = false;
  let vadMode       = false;
  let hasApiKey     = false;
  let fullTranscript = '';

  // ─── UI helpers ────────────────────────────────────────────────────────────

  function setStatus(state, text) {
    statusBar.className = 'status-bar status-' + state;
    statusText.textContent = text;
  }

  function setRecording(active) {
    isRecording = active;
    btnRecord.classList.toggle('recording', active);
    transcriptBox.classList.toggle('active', active);
    if (active) {
      setStatus('listening', 'Listening…');
      recordHint.textContent = vadMode ? 'Speaking — pause to stop' : 'Listening — click to stop';
    } else {
      recordHint.textContent = vadMode ? 'Always-on' : 'Push to Talk';
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
    promptBox.value = '';
    commandLog.innerHTML = '';
    transcriptBox.textContent = 'Your speech will appear here…';
    transcriptBox.classList.remove('active');
    promptSection.classList.add('hidden');
    commandSection.classList.add('hidden');
    spinner.classList.add('hidden');
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
        recordHint.textContent = vadMode ? 'Always-on' : 'Push to Talk';
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

      case 'recordingStarted':
        setRecording(true);
        break;

      case 'recordingStopped':
        setRecording(false);
        setStatus('idle', 'Ready — press Record');
        break;

      case 'transcriptResult':
        if (msg.text) {
          // Interim results update in-place; final results accumulate
          fullTranscript = msg.text;
          transcriptBox.textContent = fullTranscript;
        }
        break;

      case 'intentResult':
        // Buffer has been updated server-side; keep transcript visible
        break;

      case 'commandFired':
        addCommandEntry(msg.description);
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
        setStatus('idle', '⚠ ' + msg.message);
        // NOTE: do NOT call setRecording(false) here — only recordingStopped
        // should change recording state. Changing it from an error creates a
        // desync where the UI thinks it's not recording but FFmpeg still is.
        break;
    }
  });

  // ─── Button listeners ──────────────────────────────────────────────────────

  btnRecord.addEventListener('click', () => {
    if (isRecording) {
      post({ type: 'stopRecording' });
      setRecording(false);
    } else {
      post({ type: 'startRecording' });
      setStatus('listening', 'Starting…');
    }
  });

  btnVad.addEventListener('click', () => {
    vadMode = !vadMode;
    btnVad.classList.toggle('active', vadMode);
    recordHint.textContent = vadMode ? 'Always-on' : 'Push to Talk';
    if (vadMode && !isRecording) {
      post({ type: 'startRecording' });
    } else if (!vadMode && isRecording) {
      // Immediately update UI so user knows we're stopping
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
