import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  PanelMessage,
  ExtensionMessage,
  WorkspaceContext,
  MatchedConversation,
} from '../types';
import { SecretManager } from '../config/SecretManager';
import { WorkspaceContextCollector } from '../context/WorkspaceContextCollector';
import { ConversationMatcher } from '../context/ConversationMatcher';
import { IntentProcessor } from '../pipeline/IntentProcessor';
import { CommandExecutor } from '../pipeline/CommandExecutor';
import { PromptElaborator } from '../pipeline/PromptElaborator';
import { ChatInjector } from '../pipeline/ChatInjector';
import { CommandRegistry } from '../commands/CommandRegistry';
import { AudioCapture } from '../audio/AudioCapture';
import { GoogleGenerativeAI } from '@google/generative-ai';

export class VTPPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'vtp.panel';

  private view?: vscode.WebviewView;
  private promptBuffer = '';
  private cachedContext: WorkspaceContext | null = null;
  private cachedConversation: MatchedConversation | null = null;

  private intentProcessor: IntentProcessor | null = null;
  private commandExecutor: CommandExecutor | null = null;
  private promptElaborator: PromptElaborator | null = null;

  private readonly contextCollector = new WorkspaceContextCollector();
  private readonly conversationMatcher: ConversationMatcher;
  private readonly commandRegistry: CommandRegistry;
  private readonly chatInjector = new ChatInjector();
  private readonly capture = new AudioCapture();

  private ffmpegReady  = false;
  private isPaused     = false;  // true = mic stays on but only wake phrases are processed
  private justResumed  = false;  // true = first utterance after a voice-wake, discard if pure wake noise

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secretManager: SecretManager,
    private readonly log: vscode.OutputChannel,
  ) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const contextDepth  = vscode.workspace.getConfiguration('vtp').get<number>('contextDepth', 20);

    this.conversationMatcher = new ConversationMatcher(contextDepth);
    this.commandRegistry     = new CommandRegistry(workspaceRoot);
    this.commandRegistry.initialize();

    this.log.appendLine(`[VTP] Panel created. Workspace root: ${workspaceRoot ?? 'none'}`);
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    this.log.appendLine('[VTP] Webview resolved — panel opening.');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: PanelMessage) => this.handleMessage(msg));
  }

  // ─── Message handler ──────────────────────────────────────────────────────

  private async handleMessage(msg: PanelMessage): Promise<void> {
    if (msg.type !== 'log') {
      this.log.appendLine(`[VTP] Message received: ${msg.type}`);
    }

    switch (msg.type) {
      case 'ready':          await this.onPanelReady(); break;
      case 'startRecording': await this.startRecording(); break;
      case 'stopRecording':  await this.stopRecording(); break;
      case 'pauseRecording': await this.pauseRecording(); break;
      case 'resumeRecording': await this.resumeRecording(); break;
      case 'send':           await this.onSend(msg.prompt); break;
      case 'cancel':
        this.promptBuffer = '';
        this.log.appendLine('[VTP] Buffer cleared.');
        break;
      case 'openSettings':        await this.handleOpenSettings(); break;
      case 'showInfo':            await this.showApiKeyInfo(); break;
      case 'micPermissionDenied': await this.handleMicDenied(); break;
      case 'log':
        this.log.appendLine(msg.message);
        break;
    }
  }

  // ─── Panel init ───────────────────────────────────────────────────────────

  private async onPanelReady(): Promise<void> {
    this.log.appendLine('[VTP] Panel ready — checking dependencies and context.');

    const config = vscode.workspace.getConfiguration('vtp');
    this.send({
      type: 'settings',
      vadMode: config.get<boolean>('vadMode', false),
      language: config.get<string>('language', 'en-US'),
    });

    await this.sendApiKeyStatus();
    await this.checkFFmpeg();
    this.refreshContext();
  }

  private async checkFFmpeg(): Promise<void> {
    this.ffmpegReady = await AudioCapture.isAvailable();
    this.log.appendLine(`[VTP] FFmpeg available: ${this.ffmpegReady}`);

    if (!this.ffmpegReady) {
      this.send({
        type: 'error',
        message: 'FFmpeg not found — voice input is disabled. Click to install.',
      });
      const action = await vscode.window.showWarningMessage(
        'VTP: FFmpeg is required for voice recording but was not found on your PATH.',
        'Download FFmpeg',
        'How to Install',
      );
      if (action === 'Download FFmpeg') {
        vscode.env.openExternal(vscode.Uri.parse('https://ffmpeg.org/download.html'));
      } else if (action === 'How to Install') {
        vscode.env.openExternal(
          vscode.Uri.parse('https://www.wikihow.com/Install-FFmpeg-on-Windows'),
        );
      }
    }
  }

  // ─── Audio capture ────────────────────────────────────────────────────────

  private async startRecording(): Promise<void> {
    if (!this.ffmpegReady) {
      await this.checkFFmpeg();
      if (!this.ffmpegReady) return;
    }

    if (this.capture.isRecording()) {
      this.log.appendLine('[VTP] Already recording — ignoring startRecording.');
      return;
    }

    try {
      this.log.appendLine('[VTP] Starting FFmpeg audio capture...');

      // ── Wire VAD callbacks ──────────────────────────────────────────────

      // Short silence (1.5s) → route through isPaused
      this.capture.onSilenceDetected = () => {
        if (!this.capture.isRecording()) return;

        if (this.isPaused) {
          // In pause-monitor mode: stop, transcribe, check for wake phrase
          this.log.appendLine('[VTP] Pause monitor: checking for wake phrase...');
          this.checkForWakePhrase();
        } else {
          // Normal: auto-stop + process utterance
          this.log.appendLine('[VTP] VAD: silence detected — auto-stopping.');
          this.send({ type: 'vadAutoStop' });
          this.stopRecording();
        }
      };

      // Extended silence (8s) → auto-pause: keep mic on but enter monitor mode
      this.capture.onExtendedSilence = () => {
        if (this.isPaused) return; // already paused
        if (this.capture.isRecording()) {
          this.log.appendLine('[VTP] VAD: extended silence — auto-pausing (mic stays on).');
          this.isPaused = true;
          this.send({ type: 'autoPaused' });
        }
      };

      await this.capture.start();
      this.send({ type: 'recordingStarted' });
      this.log.appendLine('[VTP] Recording started.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[VTP] Failed to start recording: ${msg}`);
      this.send({ type: 'error', message: `Mic error: ${msg}` });
    }
  }

  private async stopRecording(): Promise<void> {
    if (!this.capture.isRecording()) {
      this.send({ type: 'recordingStopped' });
      return;
    }

    this.log.appendLine('[VTP] Stopping recording...');
    this.send({ type: 'recordingStopped' });

    try {
      const result = await this.capture.stop();
      if (!result) {
        this.log.appendLine('[VTP] No audio captured.');
        this.send({ type: 'error', message: 'No audio detected — try again.' });
        return;
      }

      this.log.appendLine(`[VTP] Audio captured: ${Math.round(result.buffer.length / 1024)} KB`);
      await this.transcribeAndProcess(result.buffer, result.mimeType);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[VTP] Stop/transcribe error: ${msg}`);
      this.send({ type: 'error', message: `Recording error: ${msg}` });
    }
  }

  /**
   * Pauses recording — keeps FFmpeg alive in monitor mode.
   * Any speech while paused is checked ONLY for wake phrases.
   */
  private pauseRecording(): void {
    if (this.isPaused) {
      this.send({ type: 'paused' });
      return;
    }
    this.log.appendLine('[VTP] Pausing — mic stays on in monitor mode (buffer preserved).');
    this.isPaused = true;
    this.send({ type: 'paused' });
  }

  /**
   * Resumes from pause — clears flag so next onSilenceDetected goes through
   * the normal processing path again.
   */
  private async resumeRecording(): Promise<void> {
    this.isPaused = false;
    this.log.appendLine('[VTP] Resumed.');
    // If FFmpeg died while paused, restart it
    if (!this.capture.isRecording()) {
      await this.startRecording();
    }
    this.send({ type: 'resumed' });
  }

  /**
   * Wake-phrase monitor loop (runs when isPaused=true).
   *
   * WHY fixed 3s window instead of silence detection:
   * DirectShow on Windows takes 1–2s to initialise. With silence-detection,
   * the user says "resume" during FFmpeg's init window → we capture silence.
   * Recording for a guaranteed 3s window gives FFmpeg time to init AND
   * captures the phrase reliably.
   */
  private async checkForWakePhrase(): Promise<void> {
    await this.capture.stop(); // clean up current session
    if (!this.isPaused) return;

    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) return;

    // Detach VAD callbacks so they don't fire inside the monitor loop
    this.capture.onSilenceDetected = null;
    this.capture.onExtendedSilence = null;

    this.log.appendLine('[VTP] Wake monitor: say "resume", "continue", or "I\'m back"...');

    while (this.isPaused) {
      try {
        await this.capture.start();
        await new Promise<void>((r) => setTimeout(r, 3000)); // 3s window
        const result = await this.capture.stop();

        if (!this.isPaused) break;
        if (!result) continue;

        const base64 = result.buffer.toString('base64');
        const genai  = new GoogleGenerativeAI(apiKey);
        const model  = genai.getGenerativeModel({
          model: 'gemini-2.5-flash',
          systemInstruction:
            'Transcribe the audio exactly as spoken. Output ONLY the spoken words. If there is no speech at all, output exactly: [SILENCE]',
        });
        const res  = await model.generateContent([
          { inlineData: { mimeType: result.mimeType, data: base64 } },
          'Transcribe the audio.',
        ]);
        const text = res.response.text().trim().toLowerCase();
        this.log.appendLine(`[VTP] Wake monitor heard: "${text}"`);

        if (/\b(resume|continue|start|wake up|keep going|i'?m back|listen|go|activate|hey vtp)\b/.test(text)) {
          this.log.appendLine('[VTP] Wake phrase matched — resuming.');
          this.isPaused    = false;
          this.justResumed = true;  // first post-wake utterance may be wake noise
          this.send({ type: 'resumed' });
          await this.startRecording(); // re-wires VAD callbacks
          return;
        }
      } catch (err) {
        this.log.appendLine(`[VTP] Wake monitor error: ${this.formatError(err)}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }


  // ─── Transcription ────────────────────────────────────────────────────────

  private async transcribeAndProcess(buffer: Buffer, mimeType: string): Promise<void> {
    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) {
      this.send({ type: 'error', message: 'No API key set. Click KEY to add one.' });
      return;
    }

    this.log.appendLine('[VTP] Transcribing audio via Gemini...');

    // Skip tiny clips — < 8 KB is < 0.5s, likely silence or accidental tap
    if (buffer.length < 8192) {
      this.log.appendLine(`[VTP] Audio too short (${buffer.length} bytes) — skipping.`);
      return;
    }

    const base64 = buffer.toString('base64');
    try {
      const genai = new GoogleGenerativeAI(apiKey);
      // Use systemInstruction to separate the instruction from the audio data.
      // Inline text instructions can get echoed back into the transcription output.
      const model = genai.getGenerativeModel({
        model: 'gemini-2.5-flash',
        systemInstruction: 'You are a transcription service. Transcribe the audio exactly as spoken. Output ONLY the spoken words with no commentary, preamble, or system text. If there is no speech, output exactly: [SILENCE]',
      });

      const result = await this.withRetry(() =>
        model.generateContent([
          { inlineData: { mimeType, data: base64 } },
          'Transcribe the audio.',
        ]),
      );

      const raw = result.response.text().trim();
      const text = this.sanitizeTranscription(raw);
      this.log.appendLine(`[VTP] Transcription: "${text}"`);

      // Silently skip silence or empty results — no error shown to user
      if (!text || text === '[SILENCE]') {
        this.log.appendLine('[VTP] No speech detected — skipping.');
        return;
      }

      this.send({ type: 'transcriptResult', text });

      // Drop pure wake-phrase noise from the first utterance after a voice-resume.
      // e.g. user says "resume, I'm back, resume" while testing wake words.
      if (this.justResumed) {
        this.justResumed = false;
        const isWakeNoise = /^[\s.,!?]*((resume|continue|start|wake up|keep going|i'?m back|listen|go|activate|hey vtp)[\s.,!?]*)+$/i.test(text);
        if (isWakeNoise) {
          this.log.appendLine(`[VTP] Post-wake noise discarded: "${text}"`);
          return;
        }
      }

      await this.onFinalTranscript(text);
    } catch (err) {
      const msg = this.formatError(err);
      this.log.appendLine(`[VTP] Transcription failed: ${msg}`);
      this.send({ type: 'error', message: `Transcription failed: ${msg}` });
    }
  }

  /**
   * Strips leaked system prompt text from a Gemini transcription response.
   * The model occasionally echoes back instruction text when audio is ambiguous.
   */
  private sanitizeTranscription(raw: string): string {
    const LEAK_MARKERS = [
      'Transcribe this audio exactly as spoken',
      'Output only the transcription',
      'If no speech, output an empty string',
      'You are a transcription service',
      'Transcribe the audio.',
    ];
    let text = raw.trim();
    for (const marker of LEAK_MARKERS) {
      const idx = text.indexOf(marker);
      if (idx > -1) {
        // Take whatever was transcribed before the leaked instruction
        text = text.substring(0, idx).trim().replace(/[.,!?]+$/, '').trim();
      }
    }
    return text;
  }

  // ─── Intent processing ────────────────────────────────────────────────────

  private async onFinalTranscript(segment: string): Promise<void> {
    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) return;

    this.ensurePipeline(apiKey);
    const context = this.cachedContext ?? await this.contextCollector.collect();
    this.log.appendLine('[VTP] Classifying intent...');

    try {
      const result = await this.withRetry(() =>
        this.intentProcessor!.classify(segment, this.promptBuffer, context),
      );

      this.log.appendLine(`[VTP] Intent: ${result.type} — "${result.content || result.commandIntent || ''}"`);
      this.send({ type: 'intentResult', intent: result, buffer: this.promptBuffer });

      switch (result.type) {
        case 'PROMPT_CONTENT':
          if (result.content) {
            this.promptBuffer += (this.promptBuffer ? ' ' : '') + result.content;
            this.send({ type: 'transcriptResult', text: this.promptBuffer });
          }
          break;

        case 'COMMAND': {
          // COMMAND doesn't touch the prompt buffer
          const desc = await this.commandExecutor!.execute(result.commandIntent ?? segment);
          this.send({ type: 'commandFired', description: desc });
          break;
        }

        case 'ENHANCE':
          // LLM may have extracted content said alongside the enhance trigger —
          // e.g. "enhance this: add auth support" → content = "add auth support"
          if (result.content) {
            this.promptBuffer += (this.promptBuffer ? ' ' : '') + result.content;
          }
          await this.elaborateAndShow();
          break;

        case 'SEND': {
          // LLM extracts content spoken before/alongside the send trigger —
          // e.g. "build a login page, send it" → content = "build a login page"
          if (result.content) {
            this.promptBuffer += (this.promptBuffer ? ' ' : '') + result.content;
            this.log.appendLine(`[VTP] SEND with inline content: "${result.content}"`);
          }
          if (!this.promptBuffer.trim()) {
            this.send({ type: 'error', message: 'Nothing to send — say something first.' });
          } else {
            await this.injectRaw();
          }
          break;
        }

        case 'CANCEL':
          this.promptBuffer = '';
          this.send({ type: 'transcriptResult', text: '' });
          break;

      }
    } catch (err) {
      const msg = this.formatError(err);
      this.log.appendLine(`[VTP] Intent error: ${msg}`);
      // Save the segment as plain content so it's not lost on API errors (e.g. 503)
      if (segment.trim()) {
        this.promptBuffer += (this.promptBuffer ? ' ' : '') + segment.trim();
        this.send({ type: 'transcriptResult', text: this.promptBuffer });
        this.log.appendLine(`[VTP] Saved segment to buffer after error (${segment.length} chars).`);
        this.send({ type: 'error', message: `Classification failed (saved to buffer): ${msg}` });
      } else {
        this.send({ type: 'error', message: msg });
      }
    }
  }

  private async onSend(prompt: string): Promise<void> {
    this.log.appendLine(`[VTP] Manual send — injecting (${prompt.length} chars).`);
    await this.chatInjector.inject(prompt);
    this.promptBuffer = '';
    this.send({ type: 'injected' });
  }

  /** Voice said 'send it' — inject buffer raw, no elaboration */
  private async injectRaw(): Promise<void> {
    const prompt = this.promptBuffer.trim();
    this.log.appendLine(`[VTP] Injecting raw buffer (${prompt.length} chars).`);
    await this.chatInjector.inject(prompt);
    this.promptBuffer = '';
    this.send({ type: 'injected' });
  }

  /**
   * Strips common "send" trigger phrases from a segment so the remaining
   * content can be used as the prompt when buffer is empty.
   * e.g. "This is a test. Send the prompt." → "This is a test."
   */
  private stripSendTrigger(segment: string): string {
    const triggers = [
      'send the prompt', 'send it', 'ok send', 'okay send',
      'send message', 'go ahead and send', 'submit this',
      'send this', 'send that', 'go send', 'please send', 'just send',
    ];
    let text = segment.trim();
    for (const trigger of triggers) {
      text = text.replace(new RegExp(`[.,!?]?\\s*${trigger}[.,!?]?$`, 'gi'), '').trim();
    }
    return text;
  }


  /** Voice said 'enhance prompt' — elaborate then surface in panel for review */
  private async elaborateAndShow(): Promise<void> {
    if (!this.promptBuffer.trim()) {
      this.send({ type: 'error', message: 'Nothing to enhance — say something first.' });
      return;
    }

    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) return;

    this.ensurePipeline(apiKey);
    this.send({ type: 'elaborating' });

    try {
      const [context, conversation] = await Promise.all([
        this.contextCollector.collect(),
        this.cachedConversation ?? this.conversationMatcher.findBestMatch(),
      ]);

      const elaborated = await this.withRetry(() =>
        this.promptElaborator!.elaborate(this.promptBuffer, context, conversation),
      );

      this.promptBuffer = elaborated;
      this.send({ type: 'elaborated', prompt: elaborated });
    } catch (err) {
      const msg = this.formatError(err);
      this.send({ type: 'error', message: msg });
    }
  }

  // ─── API key handling ─────────────────────────────────────────────────────

  private async sendApiKeyStatus(): Promise<void> {
    const key = await this.secretManager.getApiKey();
    this.send({ type: 'apiKeyStatus', hasKey: !!key });
    this.log.appendLine(`[VTP] API key status: ${key ? 'set' : 'not set'}`);
  }

  private async handleOpenSettings(): Promise<void> {
    const existing = await this.secretManager.getApiKey();
    if (existing) {
      const action = await vscode.window.showInformationMessage(
        'VTP: Gemini API key is active ✓', 'Update Key',
      );
      if (action === 'Update Key') {
        const newKey = await this.secretManager.promptForApiKey();
        if (newKey) { await this.sendApiKeyStatus(); }
      }
    } else {
      const key = await this.secretManager.promptForApiKey();
      if (key) { await this.sendApiKeyStatus(); }
    }
  }

  private async showApiKeyInfo(): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      'VTP uses Gemini for intent classification and prompt elaboration. Get a free key at Google AI Studio.',
      'Open AI Studio',
      'Enter My Key Now',
    );
    if (action === 'Open AI Studio') {
      vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com/apikey'));
    } else if (action === 'Enter My Key Now') {
      await this.handleOpenSettings();
    }
  }

  private async handleMicDenied(): Promise<void> {
    // Webview mic denied — route through FFmpeg instead (already handled)
    this.log.appendLine('[VTP] Webview mic denied — FFmpeg capture is used instead.');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err: unknown) {
        const msg = String(err);
        const is429 = msg.includes('429') || msg.includes('Too Many Requests');
        if (is429 && attempt < maxRetries) {
          attempt++;
          const m = msg.match(/retryDelay['":\s]+(\d+)s/);
          const wait = m ? parseInt(m[1], 10) : 30;
          this.log.appendLine(`[VTP] Rate limited — retrying in ${wait}s (${attempt}/${maxRetries})`);
          this.send({ type: 'error', message: `Rate limited — retrying in ${wait}s…` });
          await new Promise((r) => setTimeout(r, wait * 1000));
        } else {
          throw err;
        }
      }
    }
  }

  private formatError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('429') || msg.includes('Too Many Requests')) {
      return 'Gemini rate limit reached — wait a minute and try again.';
    }
    return msg;
  }

  private refreshContext(): void {
    Promise.all([
      this.contextCollector.collect(),
      this.conversationMatcher.findBestMatch(),
    ]).then(([context, conversation]) => {
      this.cachedContext      = context;
      this.cachedConversation = conversation;
      const title = conversation?.title ?? 'No matched conversation';
      this.log.appendLine(`[VTP] Context: workspace="${context.workspaceName}", conv="${title}"`);
      this.send({ type: 'contextUpdate', workspaceName: context.workspaceName, conversationTitle: title });
    }).catch((e) => this.log.appendLine(`[VTP] Context error: ${e}`));
  }

  private ensurePipeline(apiKey: string): void {
    const model = vscode.workspace.getConfiguration('vtp').get<string>('elaborationModel', 'gemini-2.5-flash');
    if (!this.intentProcessor)  this.intentProcessor  = new IntentProcessor(apiKey);
    if (!this.commandExecutor)  this.commandExecutor  = new CommandExecutor(this.commandRegistry.getCommands());
    if (!this.promptElaborator) this.promptElaborator = new PromptElaborator(apiKey, model);
  }

  private send(msg: ExtensionMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'));
    const nonce     = this.nonce();
    const htmlPath  = path.join(this.extensionUri.fsPath, 'media', 'panel.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');
    return html
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{cspNonce\}\}/g, nonce)
      .replace('{{styleUri}}', styleUri.toString())
      .replace('{{scriptUri}}', scriptUri.toString());
  }

  private nonce(): string {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => c[Math.floor(Math.random() * c.length)]).join('');
  }

  dispose(): void {
    this.capture.kill();
    this.commandRegistry.dispose();
  }
}
