// @ts-nocheck

/**
 * VTP Webview Panel script.
 * Runs inside the VS Code Webview (browser context).
 * Uses the Web Speech API for transcription — no audio streaming needed.
 * Communicates with the extension host via postMessage.
 */

(function () {
  // ─── VS Code API bridge ──────────────────────────────────────────────────
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ─── DOM refs ────────────────────────────────────────────────────────────
  const statusBar = /** @type {HTMLElement} */ (document.getElementById('status-bar'));
  const statusText = /** @type {HTMLElement} */ (document.getElementById('status-text'));
  const contextText = /** @type {HTMLElement} */ (document.getElementById('context-text'));
  const transcriptBox = /** @type {HTMLElement} */ (document.getElementById('transcript-box'));
  const btnRecord = /** @type {HTMLButtonElement} */ (document.getElementById('btn-record'));
  const btnVad = /** @type {HTMLButtonElement} */ (document.getElementById('btn-vad'));
  const btnSettings = /** @type {HTMLButtonElement} */ (document.getElementById('btn-settings'));
  const btnSend = /** @type {HTMLButtonElement} */ (document.getElementById('btn-send'));
  const btnClear = /** @type {HTMLButtonElement} */ (document.getElementById('btn-clear'));
  const btnCopy = /** @type {HTMLButtonElement} */ (document.getElementById('btn-copy'));
  const promptBox = /** @type {HTMLTextAreaElement} */ (document.getElementById('prompt-box'));
  const promptSection = /** @type {HTMLElement} */ (document.getElementById('prompt-section'));
  const commandSection = /** @type {HTMLElement} */ (document.getElementById('command-section'));
  const commandLog = /** @type {HTMLElement} */ (document.getElementById('command-log'));
  const spinner = /** @type {HTMLElement} */ (document.getElementById('spinner'));
  const recordHint = /** @type {HTMLElement} */ (document.getElementById('record-hint'));

  // ─── State ───────────────────────────────────────────────────────────────
  let isRecording = false;
  let vadMode = false;
  let recognition = /** @type {SpeechRecognition|null} */ (null);
  let fullTranscript = '';
  let interimText = '';

  // ─── Speech Recognition setup ────────────────────────────────────────────

  function createRecognition(language = 'en-US') {
    // @ts-ignore
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setStatus('idle', 'Speech recognition not supported in this environment.');
      return null;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = language;

    rec.onresult = (/** @type {SpeechRecognitionEvent} */ event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const segment = result[0].transcript.trim();
          fullTranscript += (fullTranscript ? ' ' : '') + segment;
          renderTranscript(fullTranscript, '');
          // Send final segment to extension host for intent classification
          post({ type: 'transcript', segment, isFinal: true });
        } else {
          interim += result[0].transcript;
        }
      }
      interimText = interim;
      renderTranscript(fullTranscript, interimText);
    };

    rec.onerror = (/** @type {SpeechRecognitionErrorEvent} */ e) => {
      if (e.error !== 'no-speech') {
        setStatus('idle', `Mic error: ${e.error}`);
        stopRecording();
      }
    };

    rec.onend = () => {
      // In VAD mode, restart automatically unless we stopped intentionally
      if (vadMode && isRecording) {
        rec.start();
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
    interimText = '';
    renderTranscript('', '');
    btnRecord.classList.add('recording');
    setStatus('listening', vadMode ? 'Listening (VAD)...' : 'Recording...');
    recordHint.textContent = vadMode ? 'Always-on' : 'Click to stop';
    recognition.start();
  }

  function stopRecording() {
    isRecording = false;
    btnRecord.classList.remove('recording');
    setStatus('idle', 'Ready — press Record to start');
    recordHint.textContent = vadMode ? 'Always-on' : 'Push to Talk';
    try { recognition?.stop(); } catch { /* already stopped */ }
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────

  /**
   * @param {'idle'|'listening'|'processing'|'ready'} state
   * @param {string} text
   */
  function setStatus(state, text) {
    statusBar.className = `status-bar status-${state}`;
    statusText.textContent = text;
  }

  /** @param {string} final @param {string} interim */
  function renderTranscript(final, interim) {
    transcriptBox.innerHTML =
      (final ? `<span class="final">${escapeHtml(final)}</span>` : '') +
      (interim ? `<span class="interim"> ${escapeHtml(interim)}</span>` : '') ||
      'Your speech will appear here...';
  }

  /** @param {string} text */
  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** @param {string} text */
  function addCommandEntry(text) {
    commandSection.classList.remove('hidden');
    const entry = document.createElement('div');
    entry.className = 'command-entry';
    entry.textContent = `⚡ ${text}`;
    commandLog.appendChild(entry);
    commandLog.scrollTop = commandLog.scrollHeight;
  }

  function showPromptSection(text = '') {
    promptSection.classList.remove('hidden');
    spinner.classList.add('hidden');
    if (text) promptBox.value = text;
  }

  function clearAll() {
    fullTranscript = '';
    interimText = '';
    promptBox.value = '';
    commandLog.innerHTML = '';
    transcriptBox.innerHTML = 'Your speech will appear here...';
    promptSection.classList.add('hidden');
    commandSection.classList.add('hidden');
    spinner.classList.add('hidden');
    setStatus('idle', 'Ready — press Record to start');
    post({ type: 'cancel' });
  }

  // ─── Message bus: Extension host → Webview ────────────────────────────────

  window.addEventListener('message', (/** @type {MessageEvent} */ event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'settings':
        vadMode = msg.vadMode;
        btnVad.classList.toggle('active', vadMode);
        if (recognition) recognition.lang = msg.language;
        else recognition = createRecognition(msg.language);
        break;

      case 'contextUpdate':
        contextText.textContent = `${msg.workspaceName} / ${msg.conversationTitle}`;
        break;

      case 'intentResult':
        // Update buffer display in transcript
        setStatus('listening', 'Classified — still listening...');
        break;

      case 'commandFired':
        addCommandEntry(msg.description);
        setStatus('listening', 'Command fired — still listening...');
        break;

      case 'elaborating':
        spinner.classList.remove('hidden');
        promptSection.classList.add('hidden');
        setStatus('processing', 'Elaborating with Gemini...');
        break;

      case 'elaborated':
        showPromptSection(msg.prompt);
        setStatus('ready', 'Ready to send');
        fullTranscript = '';
        break;

      case 'injected':
        clearAll();
        setStatus('idle', '✓ Sent to Antigravity');
        break;

      case 'error':
        spinner.classList.add('hidden');
        setStatus('idle', `Error: ${msg.message}`);
        break;
    }
  });

  // ─── Button event listeners ───────────────────────────────────────────────

  btnRecord.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  btnVad.addEventListener('click', () => {
    vadMode = !vadMode;
    btnVad.classList.toggle('active', vadMode);
    if (vadMode && !isRecording) {
      startRecording();
    } else if (!vadMode && isRecording) {
      stopRecording();
    }
  });

  btnSettings.addEventListener('click', () => {
    post({ type: 'send', prompt: '__vtp_open_settings__' });
    // Extension host ignores non-prompt sends and routes this to setApiKey command
  });

  btnSend.addEventListener('click', () => {
    const prompt = promptBox.value.trim();
    if (!prompt) return;
    post({ type: 'send', prompt });
  });

  btnClear.addEventListener('click', clearAll);

  btnCopy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(promptBox.value);
    btnCopy.textContent = '✓ Copied';
    setTimeout(() => (btnCopy.textContent = '📋 Copy'), 1500);
  });

  // ─── Message helper ───────────────────────────────────────────────────────

  /** @param {object} msg */
  function post(msg) {
    vscode.postMessage(msg);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  // Request settings on load
  post({ type: 'ready' });
  recognition = createRecognition();
})();
