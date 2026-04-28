// @ts-nocheck

/**
 * VTP Webview Panel script.
 * Runs inside the VS Code Webview (browser context).
 * Uses the Web Speech API for transcription.
 * Communicates with the extension host via acquireVsCodeApi().postMessage().
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
  const btnSettings      = document.getElementById('btn-settings');
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
  let isRecording  = false;
  let vadMode      = false;
  let recognition  = null;
  let fullTranscript = '';

  // ─── Speech Recognition ──────────────────────────────────────────────────

  function createRecognition(language) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setStatus('idle', 'Speech API not available in this browser.');
      return null;
    }

    const rec = new SR();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = language || 'en-US';

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) {
          const segment = r[0].transcript.trim();
          fullTranscript += (fullTranscript ? ' ' : '') + segment;
          renderTranscript(fullTranscript, '');
          post({ type: 'transcript', segment, isFinal: true });
        } else {
          interim += r[0].transcript;
        }
      }
      if (interim) renderTranscript(fullTranscript, interim);
      transcriptBox.classList.add('active');
    };

    rec.onerror = (e) => {
      if (e.error !== 'no-speech') {
        setStatus('idle', 'Mic error: ' + e.error);
        stopRecording();
      }
    };

    rec.onend = () => {
      // In VAD mode keep restarting, otherwise stop
      if (vadMode && isRecording) {
        try { rec.start(); } catch {}
      } else {
        stopRecording();
      }
    };

    return rec;
  }

  // ─── Recording controls ───────────────────────────────────────────────────

  function startRecording() {
    if (!recognition) {
      setStatus('idle', 'Speech recognition unavailable.');
      return;
    }
    isRecording = true;
    fullTranscript = '';
    renderTranscript('', '');
    btnRecord.classList.add('recording');
    setStatus('listening', vadMode ? 'Listening (VAD on)...' : 'Recording...');
    recordHint.textContent = vadMode ? 'Always-on — say "OK send" to finish' : 'Click to stop';
    try { recognition.start(); } catch {}
  }

  function stopRecording() {
    isRecording = false;
    btnRecord.classList.remove('recording');
    transcriptBox.classList.remove('active');
    setStatus('idle', 'Ready — press Record');
    recordHint.textContent = vadMode ? 'Always-on' : 'Push to Talk';
    try { recognition.stop(); } catch {}
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────

  function setStatus(state, text) {
    statusBar.className = 'status-bar status-' + state;
    statusText.textContent = text;
  }

  function renderTranscript(final, interim) {
    transcriptBox.innerHTML =
      (final  ? '<span class="final">'   + esc(final)  + '</span>' : '') +
      (interim ? '<span class="interim"> ' + esc(interim) + '</span>' : '') ||
      'Your speech will appear here...';
  }

  function esc(t) {
    return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
    transcriptBox.innerHTML = 'Your speech will appear here...';
    transcriptBox.classList.remove('active');
    promptSection.classList.add('hidden');
    commandSection.classList.add('hidden');
    spinner.classList.add('hidden');
    setStatus('idle', 'Ready — press Record');
    post({ type: 'cancel' });
  }

  // ─── Messages from extension host ─────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
      case 'settings':
        vadMode = msg.vadMode;
        btnVad.classList.toggle('active', vadMode);
        if (recognition) recognition.lang = msg.language;
        else recognition = createRecognition(msg.language);
        break;

      case 'contextUpdate':
        contextWorkspace.textContent = msg.workspaceName || '—';
        contextConv.textContent      = msg.conversationTitle || '—';
        break;

      case 'intentResult':
        // Keep status updated while still listening
        if (isRecording) setStatus('listening', 'Classified — still listening...');
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

  btnRecord.addEventListener('click', () => {
    isRecording ? stopRecording() : startRecording();
  });

  btnVad.addEventListener('click', () => {
    vadMode = !vadMode;
    btnVad.classList.toggle('active', vadMode);
    if (vadMode && !isRecording) startRecording();
    else if (!vadMode && isRecording) stopRecording();
  });

  // ⚙ Settings — triggers the API key prompt in the extension host
  btnSettings.addEventListener('click', () => {
    post({ type: 'openSettings' });
  });

  // ℹ Info — explains how to get an API key
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
  post({ type: 'ready' });
  recognition = createRecognition('en-US');

  function post(msg) { vscode.postMessage(msg); }

})();
