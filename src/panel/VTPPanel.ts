import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import {
  PanelMessage,
  ExtensionMessage,
  WorkspaceContext,
  MatchedConversation,
} from '../types';
import { ScoredConversation } from '../context/ConversationMatcher';
import { SecretManager } from '../config/SecretManager';
import { WorkspaceContextCollector } from '../context/WorkspaceContextCollector';
import { ConversationMatcher } from '../context/ConversationMatcher';
import { IntentProcessor } from '../pipeline/IntentProcessor';
import { CommandExecutor } from '../pipeline/CommandExecutor';
import { PromptElaborator } from '../pipeline/PromptElaborator';
import { ChatInjector } from '../pipeline/ChatInjector';
import { CommandRegistry } from '../commands/CommandRegistry';
import { AudioCapture } from '../audio/AudioCapture';
import { DeepgramTranscriber, DeepgramOptions } from '../audio/DeepgramTranscriber';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SettingsManager } from './SettingsManager';
import { VoiceActivationMonitor } from './VoiceActivationMonitor';
import {
  hasSendTrigger,
  sanitizeTranscription,
  hasVoiceEnergy,
  stripSendTrigger,
  stripEnhanceTrigger,
  stripFiller,
  PAUSE_CMD,
  CLEAR_CMD,
  CLEAR_FINAL_CMD,
  CLEAN_CMD,
  ENHANCE_LIVE,
  SEND_TRIGGER,
  ACTION_TRIGGER,
  WAKE_PHRASE,
  ENHANCE_APPROVE,
  ENHANCE_REJECT,
  ENHANCE_REGEN,
  extractSideCommand,
  extractPauseAndSideCmd,
} from './CommandDetector';

export class VTPPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'vtp.panel';

  private view?: vscode.WebviewView;
  private promptBuffer = '';
  private cachedContext: WorkspaceContext | null = null;
  private cachedConversation: MatchedConversation | null = null;
  /** Extra conversations the user manually added as supplementary read-only context. */
  private _extraConversations: ScoredConversation[] = [];
  /** Tracks interimTranscript.length at the time of last async classify call. */
  private _lastAsyncClassifiedLength = 0;

  private intentProcessor: IntentProcessor | null = null;
  private commandExecutor: CommandExecutor | null = null;
  private promptElaborator: PromptElaborator | null = null;

  private readonly contextCollector = new WorkspaceContextCollector();
  private readonly conversationMatcher: ConversationMatcher;
  private readonly commandRegistry: CommandRegistry;
  private readonly chatInjector = new ChatInjector();
  private readonly capture = new AudioCapture();
  private readonly settings: SettingsManager;

  /** File-system watcher on the brain directory. */
  private _brainWatcher: fs.FSWatcher | null = null;
  /** VS Code subscription for workspace folder changes. */
  private _workspaceSub: vscode.Disposable | null = null;
  /** Debounce timer handle for context refresh. */
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly REFRESH_DEBOUNCE_MS = 2_000;

  private ffmpegReady = false;
  private isPaused = false;
  private justResumed = false;
  private interimTranscript = '';
  private _chunkQueue: Promise<void> = Promise.resolve();
  private _chunkQueueDepth = 0;
  private _sendTriggerFired = false;
  private _restartAfterSend = false;
  private _vadStop = false;
  private _stopping = false;
  private _sessionGen = 0;
  private _cancelChunks = false;
  private _awaitingEnhancementDecision = false;
  private _originalBufferBeforeEnhance = '';
  private _enhanceTriggerFired = false;
  private _deepgramTranscriber: DeepgramTranscriber | null = null;
  private _voiceActivationMonitor: VoiceActivationMonitor | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secretManager: SecretManager,
    private readonly log: vscode.OutputChannel,
    private readonly globalState: vscode.Memento,
  ) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const contextDepth = vscode.workspace.getConfiguration('vtp').get<number>('contextDepth', 20);
    this.conversationMatcher = new ConversationMatcher(contextDepth);
    this.commandRegistry = new CommandRegistry(workspaceRoot);
    this.commandRegistry.initialize();
    this.settings = new SettingsManager({
      secretManager: this.secretManager,
      log: (msg) => this.log.appendLine(msg),
      send: (msg) => this.send(msg),
    });
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
    this.startContextWatchers();
    webviewView.onDidDispose(() => this.stopContextWatchers());
  }

  // ── Message handler ───────────────────────────────────────────────────────

  private async handleMessage(msg: PanelMessage): Promise<void> {
    if (msg.type !== 'log') {
      this.log.appendLine(`[VTP] Message received: ${msg.type}`);
    }
    switch (msg.type) {
      case 'ready': await this.onPanelReady(); break;
      case 'startRecording': await this.startRecording(); break;
      case 'stopRecording': await this.stopRecording(); break;
      case 'pauseRecording': await this.pauseRecording(); break;
      case 'resumeRecording': await this.resumeRecording(); break;
      case 'send': await this.onSend(msg.prompt); break;
      case 'cancel':
        this._awaitingEnhancementDecision = false;
        this.promptBuffer = '';
        this.interimTranscript = '';
        this.send({ type: 'transcriptResult', text: '' });
        this.log.appendLine('[VTP] Buffer cleared.');
        break;
      case 'enhancementDecision':
        await this.handleEnhancementDecision(msg.action);
        break;
      case 'openSettings': await this.settings.handleOpenSettings(); break;
      case 'showInfo': await this.settings.showApiKeyInfo(); break;
      case 'selectContext': await this.openConversationPicker(); break;
      case 'manageDeepgramKey': await this.settings.handleDeepgramKey(); break;
      case 'openKeybindings':
        // Opens the keyboard shortcut editor pre-filtered to the VTP toggle
        // command so the user can remap it without navigating there manually.
        await vscode.commands.executeCommand(
          'workbench.action.openGlobalKeybindings',
          'VTP: Toggle Recording',
        );
        this.log.appendLine('[VTP] Opened keyboard shortcut editor for VTP: Toggle Recording.');
        break;
      case 'onboardingComplete':
        await this.handleOnboardingComplete(msg);
        break;
      case 'applySettings':
        await this.handleApplySettings(msg.activationMode, msg.postSendMode, msg.wakePhrase);
        break;
      case 'setEngine': {
        const eng = msg.engine as 'gemini' | 'deepgram';
        await vscode.workspace.getConfiguration('vtp').update('transcriptionEngine', eng, vscode.ConfigurationTarget.Global);
        // Restart VAM with the new engine if it was running
        this._voiceActivationMonitor?.stop();
        this._voiceActivationMonitor = null;
        const cfg2 = vscode.workspace.getConfiguration('vtp');
        if (cfg2.get<string>('activationMode', 'wake') === 'wake' && !this.capture.isRecording() && !this.isPaused) {
          this._startVoiceActivation(cfg2.get<string>('wakePhrase', 'hey antigravity'));
        }
        await this.settings.sendDeepgramKeyStatus();
        this.log.appendLine(`[VTP] Transcription engine switched to: ${eng}.`);
        break;
      }
      case 'setVoiceActivation': {
        // Legacy path: map to new 2-axis model
        const cfg    = vscode.workspace.getConfiguration('vtp');
        const phrase = msg.wakePhrase || cfg.get<string>('wakePhrase', 'hey antigravity');
        const activation: 'wake' | 'manual' = msg.enabled ? 'wake' : 'manual';
        const postSend = cfg.get<'continuous' | 'pause'>('postSendMode', 'pause');
        await this.handleApplySettings(activation, postSend, phrase);
        break;
      }
      case 'log':
        this.log.appendLine(msg.message);
        break;
    }
  }

  // ── Panel init ────────────────────────────────────────────────────────────

  private async onPanelReady(): Promise<void> {
    this.log.appendLine('[VTP] Panel ready — checking dependencies and context.');
    const config = vscode.workspace.getConfiguration('vtp');
    this.send({ type: 'settings', vadMode: config.get<boolean>('vadMode', false) });
    await this.settings.sendApiKeyStatus();
    await this.settings.sendDeepgramKeyStatus();
    await this.checkFFmpeg();
    this.refreshContext();

    // ── Send current flow settings to webview ──────────────────────────────
    this._sendSettingsStatus(config);

    // ── First-run onboarding ────────────────────────────────────────────────
    const onboarded = this.globalState.get<boolean>('vtp.onboarded', false);
    if (!onboarded) {
      setTimeout(() => this.send({ type: 'showOnboarding' }), 300);
      this.log.appendLine('[VTP] First run detected — showing onboarding.');
      return;
    }

    // ── Start wake monitor if activationMode = wake ─────────────────────────
    const activationMode = config.get<string>('activationMode', 'wake');
    if (activationMode === 'wake') {
      const phrase = config.get<string>('wakePhrase', 'hey antigravity');
      this._startVoiceActivation(phrase);
    }
  }

  private _sendSettingsStatus(config?: vscode.WorkspaceConfiguration): void {
    const cfg = config ?? vscode.workspace.getConfiguration('vtp');
    const activationMode = cfg.get<'wake' | 'manual'>('activationMode', 'wake');
    const postSendMode   = cfg.get<'continuous' | 'pause'>('postSendMode', 'pause');
    const wakePhrase     = cfg.get<string>('wakePhrase', 'hey antigravity');
    this.send({ type: 'settingsStatus', activationMode, postSendMode, wakePhrase });
  }

  // ── Onboarding ───────────────────────────────────────────────────────────

  private async handleOnboardingComplete(msg: Extract<import('../types').PanelMessage, { type: 'onboardingComplete' }>): Promise<void> {
    this.log.appendLine(`[VTP] Onboarding complete. Engine: ${msg.engine}, activation: ${msg.activationMode}, postSend: ${msg.postSendMode}, phrase: "${msg.wakePhrase}"`);

    const cfg = vscode.workspace.getConfiguration('vtp');
    await cfg.update('transcriptionEngine', msg.engine, vscode.ConfigurationTarget.Global);

    if (msg.geminiKey) {
      await this.secretManager.setApiKey(msg.geminiKey);
      this.log.appendLine('[VTP] Gemini API key saved from onboarding.');
    }
    if (msg.deepgramKey) {
      await this.secretManager.storeSecret('vtp.deepgramApiKey', msg.deepgramKey);
      this.log.appendLine('[VTP] Deepgram API key saved from onboarding.');
    }

    // Save new 2-axis flow settings
    await cfg.update('activationMode', msg.activationMode, vscode.ConfigurationTarget.Global);
    await cfg.update('postSendMode',   msg.postSendMode,   vscode.ConfigurationTarget.Global);
    await cfg.update('wakePhrase',     msg.wakePhrase,     vscode.ConfigurationTarget.Global);

    await this.globalState.update('vtp.onboarded', true);

    await this.settings.sendApiKeyStatus();
    await this.settings.sendDeepgramKeyStatus();

    this._sendSettingsStatus();

    if (msg.activationMode === 'wake') {
      this._startVoiceActivation(msg.wakePhrase);
    }

    this.log.appendLine('[VTP] Onboarding data persisted.');
  }

  // ── Voice Activation ─────────────────────────────────────────────────────

  private _startVoiceActivation(phrase: string): void {
    // Don't start if mic is already in use by a recording session or pause-monitor
    if (this.capture.isRecording() || this.isPaused) return;
    this._voiceActivationMonitor?.stop();
    const engine = vscode.workspace.getConfiguration('vtp').get<string>('transcriptionEngine', 'gemini') as 'deepgram' | 'gemini';
    this._voiceActivationMonitor = new VoiceActivationMonitor(
      this.secretManager,
      (msg) => this.log.appendLine(msg),
    );
    this._voiceActivationMonitor.start(phrase, engine, () => {
      // Double-check state at callback time — user may have started recording
      // manually between when the VAM detected energy and when this fires.
      if (this.capture.isRecording() || this.isPaused) {
        this.log.appendLine('[VTP] VAM wake: panel already active — ignoring auto-start.');
        return;
      }
      this.log.appendLine('[VTP] Wake phrase detected — starting recording.');
      void this.startRecording();
    });
  }

  private async handleApplySettings(
    activationMode: 'wake' | 'manual',
    postSendMode: 'continuous' | 'pause',
    wakePhrase: string,
  ): Promise<void> {
    // ── Reset to idle first — stop whatever is currently active ──────────────
    // Kill the VAM so the old wake phrase stops listening
    this._voiceActivationMonitor?.stop();
    this._voiceActivationMonitor = null;

    // If actively recording, stop it cleanly
    if (this.capture.isRecording()) {
      this._stopping = false; // allow a fresh stop
      this.capture.kill();
      this._deepgramTranscriber?.disconnect();
      this._deepgramTranscriber = null;
      this.interimTranscript = '';
      this.send({ type: 'recordingStopped' });
      this.log.appendLine('[VTP] Settings applied mid-recording — stopped capture.');
    }

    // If in paused/wake-monitor state, force it back to idle
    if (this.isPaused) {
      this.isPaused = false;
      this.send({ type: 'recordingStopped' }); // puts JS side back to idle
    }

    this.promptBuffer         = '';
    this.interimTranscript    = '';
    this._stopping            = false;
    this._restartAfterSend    = false;

    // ── Persist the new settings ──────────────────────────────────────────────
    const cfg = vscode.workspace.getConfiguration('vtp');
    await cfg.update('activationMode', activationMode, vscode.ConfigurationTarget.Global);
    await cfg.update('postSendMode',   postSendMode,   vscode.ConfigurationTarget.Global);
    await cfg.update('wakePhrase',     wakePhrase,     vscode.ConfigurationTarget.Global);

    // ── Restart VAM with new phrase if needed ─────────────────────────────────
    if (activationMode === 'wake') {
      this._startVoiceActivation(wakePhrase);
    }

    this.send({ type: 'transcriptResult', text: '' }); // clear displayed transcript
    this._sendSettingsStatus();
    this.log.appendLine(`[VTP] Settings applied: activation=${activationMode}, postSend=${postSendMode}, phrase="${wakePhrase}".`);
  }

  /**
   * Called after a prompt is injected.
   *
   *  postSendMode=continuous → brief 800ms pause then auto-restart recording
   *  postSendMode=pause      → go idle; if activationMode=wake, restart the VAM
   *                            so the user can say the wake phrase to start the next prompt
   */
  private async _postSendFlow(): Promise<void> {
    const cfg            = vscode.workspace.getConfiguration('vtp');
    const postSendMode   = cfg.get<'continuous' | 'pause'>('postSendMode', 'pause');
    const activationMode = cfg.get<'wake' | 'manual'>('activationMode', 'wake');

    if (postSendMode === 'continuous') {
      await new Promise<void>((r) => setTimeout(r, 800));
      if (!this.capture.isRecording()) {
        this.log.appendLine(`[VTP] Post-send continuous — auto-resuming.`);
        void this.startRecording();
      }
    } else {
      // Pause mode: go idle
      if (activationMode === 'wake') {
        const phrase = cfg.get<string>('wakePhrase', 'hey antigravity');
        this.log.appendLine('[VTP] Post-send pause/wake — restarting wake monitor.');
        this._startVoiceActivation(phrase);
      } else {
        this.log.appendLine('[VTP] Post-send pause/manual — idle (button or keybind to continue).');
      }
    }
  }

  private startContextWatchers(): void {
    const brainDir = ConversationMatcher.getBrainDir();
    if (fs.existsSync(brainDir)) {
      try {
        this._brainWatcher = fs.watch(
          brainDir,
          { recursive: true, persistent: false },
          (_event, filename) => {
            if (filename && (filename.includes('overview') || filename.includes('system_generated'))) {
              this.scheduleRefresh();
            }
          },
        );
        this._brainWatcher.on('error', (err) => {
          this.log.appendLine(`[VTP] Brain watcher error (non-fatal): ${err.message}`);
        });
        this.log.appendLine('[VTP] Brain directory watcher started.');
      } catch (e: any) {
        this.log.appendLine(`[VTP] Could not watch brain dir (non-fatal): ${e.message}`);
      }
    } else {
      this.log.appendLine('[VTP] Brain directory not found — context watcher skipped.');
    }
    this._workspaceSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.log.appendLine('[VTP] Workspace folders changed — refreshing context.');
      this.scheduleRefresh();
    });
  }

  private scheduleRefresh(): void {
    // Don't refresh context mid-session — the context can't change while
    // we're recording, and the log spam makes debugging harder.
    if (this.capture.isRecording() || this.isPaused) return;
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.refreshContext();
    }, VTPPanel.REFRESH_DEBOUNCE_MS);
  }

  private stopContextWatchers(): void {
    if (this._brainWatcher) { this._brainWatcher.close(); this._brainWatcher = null; }
    if (this._workspaceSub) { this._workspaceSub.dispose(); this._workspaceSub = null; }
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
    this.log.appendLine('[VTP] Context watchers stopped.');
  }

  private async checkFFmpeg(): Promise<void> {
    this.ffmpegReady = await AudioCapture.isAvailable();
    this.log.appendLine(`[VTP] FFmpeg available: ${this.ffmpegReady}`);
    if (!this.ffmpegReady) {
      this.send({ type: 'error', message: 'FFmpeg not found — voice input is disabled. Click to install.' });
      const action = await vscode.window.showWarningMessage(
        'VTP: FFmpeg is required for voice recording but was not found on your PATH.',
        'Download FFmpeg', 'How to Install',
      );
      if (action === 'Download FFmpeg') {
        vscode.env.openExternal(vscode.Uri.parse('https://ffmpeg.org/download.html'));
      } else if (action === 'How to Install') {
        vscode.env.openExternal(vscode.Uri.parse('https://www.wikihow.com/Install-FFmpeg-on-Windows'));
      }
    }
  }

  // ── Audio capture ─────────────────────────────────────────────────────────

  private async startRecording(): Promise<void> {
    if (!this.ffmpegReady) {
      await this.checkFFmpeg();
      if (!this.ffmpegReady) return;
    }
    if (this.capture.isRecording()) {
      this.log.appendLine(`[VTP] Already recording - ignoring startRecording.`);
      return;
    }
    try {
      // Stop voice activation monitor while the mic is in use
      this._voiceActivationMonitor?.stop();

      this.isPaused             = false;
      this._stopping            = false;
      this.interimTranscript    = '';
      this._chunkQueue          = Promise.resolve();
      this._sendTriggerFired    = false;
      this._restartAfterSend    = false;
      this._enhanceTriggerFired = false;
      this._vadStop             = false;
      this._cancelChunks        = false;
      this._lastAsyncClassifiedLength = 0;
      const sessionGen          = ++this._sessionGen;

      const engine = vscode.workspace.getConfiguration('vtp').get<string>('transcriptionEngine', 'gemini');
      const dgKey  = engine === 'deepgram'
        ? await this.secretManager.getSecret('vtp.deepgramApiKey')
        : undefined;
      const useDeepgram = engine === 'deepgram' && !!dgKey;

      this.capture.onFfmpegLog = (line) => {
        if (/error|warning|cannot|failed|invalid|no such|unable|permission/i.test(line) &&
            !/^\s*(frame|fps|size|time|bitrate|speed|Stream|encoder|Press)/.test(line)) {
          this.log.appendLine(`[VTP] FFmpeg: ${line}`);
        }
      };

      if (useDeepgram) {
        this.log.appendLine('[VTP] Starting FFmpeg audio capture (Deepgram streaming mode)...');
        const dgOpts: DeepgramOptions = {
          mipOptOut:       vscode.workspace.getConfiguration('vtp').get<boolean>('deepgramMipOptOut', false),
          profanityFilter: vscode.workspace.getConfiguration('vtp').get<boolean>('deepgramProfanityFilter', false),
          redact:          vscode.workspace.getConfiguration('vtp').get<string[]>('deepgramRedact', []) as DeepgramOptions['redact'],
        };
        const dg = new DeepgramTranscriber(dgKey!, dgOpts);
        this._deepgramTranscriber = dg;

        dg.onReady = () => { this.log.appendLine('[VTP] Deepgram WebSocket connected.'); };
        dg.onInterim = (text) => {
          if (this._cancelChunks || this._stopping) return;
          const interim = (this.interimTranscript + ' ' + text).trim();
          const display = this.promptBuffer ? this.promptBuffer + ' ' + interim : interim;
          this.send({ type: 'transcriptResult', text: display });
        };
        dg.onFinal = (text) => {
          if (this._cancelChunks || this._stopping) return;
          const trimmed = text.trim();
          if (!trimmed) return;
          this.log.appendLine(`[VTP] Deepgram final: "${trimmed}"`);
          this.interimTranscript = (this.interimTranscript + ' ' + trimmed).trim();
          const displayText = this.promptBuffer
            ? this.promptBuffer + ' ' + this.interimTranscript
            : this.interimTranscript;
          this.send({ type: 'transcriptResult', text: displayText });
          this._processTranscriptChunk(trimmed, sessionGen);
        };
        dg.onError = (err) => { this.log.appendLine(`[VTP] Deepgram error: ${err.message}`); };
        let _pcmFirstLog = false;
        this.capture.onPcmData = (pcm) => {
          if (!_pcmFirstLog) {
            _pcmFirstLog = true;
            this.log.appendLine(`[VTP DBG] First PCM chunk: ${pcm.length} bytes — audio IS flowing to Deepgram.`);
          }
          dg.send(pcm);
        };
        dg.connect();
        await this.capture.startStreaming();
        this.send({ type: 'recordingStarted' });
        this.log.appendLine('[VTP] Recording started (Deepgram real-time mode).');
      } else {
        if (engine === 'deepgram' && !dgKey) {
          this.log.appendLine('[VTP] Deepgram selected but no key found -- falling back to Gemini.');
        }
        this.log.appendLine('[VTP] Starting FFmpeg audio capture (Gemini chunked mode)...');

        this.capture.onChunkReady = (chunk) => {
          if (this._cancelChunks) return;
          this._chunkQueueDepth++;
          if (this._chunkQueueDepth > 3) {
            this.log.appendLine(`[VTP] Queue backed up (${this._chunkQueueDepth} pending).`);
          }
          this._chunkQueue = this._chunkQueue.then(async () => {
            this._chunkQueueDepth--;
            await this.processLiveChunk(chunk.buffer, chunk.mimeType, sessionGen);
          });
        };
        this.capture.onChunkSkipped = () => {
          this.log.appendLine('[VTP] Chunk skipped -- audio too quiet.');
        };
        this.capture.onSilenceStart = () => {
          if (this.isPaused || this._stopping || !this.capture.isRecording()) return;
          this.log.appendLine('[VTP] VAD: silence detected -- auto-stopping.');
          this._vadStop = true;
          void this.stopRecording();
        };
        this.capture.onSilenceDetected = null;
        this.capture.onExtendedSilence = null;
        await this.capture.startChunked();
        this.send({ type: 'recordingStarted' });
        this.log.appendLine('[VTP] Recording started (Gemini chunked mode).');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[VTP] Failed to start recording: ${msg}`);
      this.send({ type: 'error', message: `Mic error: ${msg}` });
    }
  }

  private async stopRecording(): Promise<void> {
    if (this._stopping) {
      this.send({ type: 'recordingStopped' });
      return;
    }
    this._stopping = true;
    this.log.appendLine('[VTP] Stopping recording...');
    this.send({ type: 'recordingStopped' });

    try {
      const usingDeepgram = this._deepgramTranscriber !== null;
      if (usingDeepgram) {
        this._deepgramTranscriber!.disconnect();
        this._deepgramTranscriber = null;
        await this.capture.stopStreaming();
      } else {
        await this.capture.stopChunked();
        await this._chunkQueue;
      }

      const finalText = this.interimTranscript.trim();
      this.interimTranscript = '';
      const hasSpeech = finalText.length > 0;

      if (hasSpeech) {
        this.log.appendLine(`[VTP] Final transcript (${finalText.length} chars): "${finalText}"`);
        await this.onFinalTranscript(finalText);
      }

      if (this._vadStop && !this._restartAfterSend) {
        this._vadStop = false;
        if (!hasSpeech) {
          this.log.appendLine('[VTP] No speech detected.');
          this.isPaused = true;
          this.send({ type: 'autoPaused' });
          this.log.appendLine('[VTP] Wake monitor: say "resume", "continue", or "I\'m back"...');
          void this.checkForWakePhrase();
        } else if (!this.isPaused) {
          this.log.appendLine('[VTP] VAD stop -- restarting for continuous listening.');
          void this.startRecording();
        }
      } else if (this.isPaused) {
        this.log.appendLine('[VTP] Voice-paused -- launching wake monitor (say resume).');
        void this.checkForWakePhrase();
      } else if (!hasSpeech && !this._restartAfterSend) {
        this.log.appendLine('[VTP] No speech on stop -- flushing UI to idle.');
        this.send({ type: 'transcriptResult', text: this.promptBuffer });
        // If wake mode is active, restart VAM so wake phrase can trigger next session
        const cfg2 = vscode.workspace.getConfiguration('vtp');
        if (!this.isPaused && cfg2.get<string>('activationMode', 'wake') === 'wake') {
          const phrase = cfg2.get<string>('wakePhrase', 'hey antigravity');
          this.log.appendLine('[VTP] Manual stop — restarting VAM.');
          this._startVoiceActivation(phrase);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[VTP] Stop error: ${msg}`);
      this.send({ type: 'error', message: `Recording error: ${msg}` });
    } finally {
      this._stopping = false;
    }
  }

  /** Shared trigger-check logic used by both Gemini chunks and Deepgram finals. */
  private _processTranscriptChunk(text: string, sessionGen: number): void {
    if (sessionGen !== this._sessionGen) return;
    const accumulated = this.interimTranscript;

    if (!this._sendTriggerFired && (hasSendTrigger(accumulated) || hasSendTrigger(text))) {
      this._sendTriggerFired = true;
      this._restartAfterSend = true;
      this.capture.kill();
      this.log.appendLine('[VTP] Send trigger (Deepgram) -- mic muted.');
      this.send({ type: 'vadAutoStop' });
      void this.stopRecording();
      return;
    }
    if (!this._enhanceTriggerFired && !this._sendTriggerFired && ENHANCE_LIVE.test(accumulated)) {
      this._enhanceTriggerFired = true;
      this.capture.kill();
      this.log.appendLine('[VTP] Enhance trigger (Deepgram) -- mic muted.');
      this.send({ type: 'vadAutoStop' });
      void this.stopRecording();
      return;
    }
    if (PAUSE_CMD.test(text)) {
      // ── Check for combined "pause and [side command]" first ──────────────
      const pauseSide = extractPauseAndSideCmd(text);
      if (pauseSide) {
        this.log.appendLine(`[VTP] Pause+side command detected: "${pauseSide}"`);
        void this.handleSideCommand(pauseSide);
      }
      this.log.appendLine('[VTP] Pause command (Deepgram) -- pausing.');
      this.interimTranscript = this.interimTranscript
        .replace(PAUSE_CMD, '').replace(/\s{2,}/g, ' ').trim();
      this.capture.kill();
      this.isPaused = true;
      this.send({ type: 'paused' });
      void this.stopRecording();
      return;
    }
    // ── Standalone side command (keep recording) ─────────────────────────
    const sideCmd = extractSideCommand(text);
    if (sideCmd) {
      this.log.appendLine(`[VTP] Side command (Deepgram): "${sideCmd}"`);
      void this.handleSideCommand(sideCmd);
      // Strip the side-command phrase from interimTranscript so it doesn't
      // accumulate as prompt content
      this.interimTranscript = this.interimTranscript
        .replace(text, '').replace(/\s{2,}/g, ' ').trim();
      return;
    }
    if (CLEAR_CMD.test(text)) {
      this.log.appendLine('[VTP] Clear command (Deepgram) -- wiping buffer.');
      this.interimTranscript = '';
      this.promptBuffer      = '';
      this.send({ type: 'transcriptResult', text: '' });
      return;
    }
    if (CLEAN_CMD.test(text) || CLEAN_CMD.test(accumulated)) {
      this.log.appendLine('[VTP] Clean command (Deepgram) -- running cleanup pass.');
      this.capture.kill();
      void this.stopRecording();
      void this.cleanAndApply();
      return;
    }
  }

  private async cleanAndApply(): Promise<void> {
    const text = (this.promptBuffer || this.interimTranscript).trim();
    if (!text) {
      this.log.appendLine('[VTP] Clean: nothing in buffer, skipping.');
      return;
    }
    this.log.appendLine(`[VTP] Clean: running cleanup pass on ${text.length} chars.`);
    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) {
      this.send({ type: 'error', message: 'No API key set. Click KEY to add one.' });
      return;
    }
    try {
      const genai = new GoogleGenerativeAI(apiKey);
      const model = genai.getGenerativeModel({
        model: 'gemini-2.5-flash',
        systemInstruction: [
          'You are a transcript cleanup service.',
          'Your ONLY job is to remove noise from the user\'s dictated text.',
          'Remove: filler words (um, uh, like, you know, basically, so, right, I mean, kinda, sorta),',
          '         profanity unless it is clearly intentional and part of the request,',
          '         off-topic conversational tangents (e.g. talking to someone who walked in).',
          'NEVER add, rephrase, expand, or reorder the real content.',
          'NEVER add commentary or explanations.',
          'Output ONLY the cleaned text. If nothing needs cleaning, output the text unchanged.',
        ].join(' '),
        generationConfig: { temperature: 0 },
      });
      const result = await model.generateContent([`Clean up this dictated text:\n\n${text}`]);
      const cleaned = result.response.text().trim();
      if (!cleaned) {
        this.log.appendLine('[VTP] Clean: Gemini returned empty — keeping original.');
        return;
      }
      this.log.appendLine(`[VTP] Clean: done. "${cleaned}"`);
      this.promptBuffer = cleaned;
      this.interimTranscript = '';
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
    } catch (err) {
      this.log.appendLine(`[VTP] Clean error: ${this.formatError(err)}`);
      this.send({ type: 'error', message: 'Cleanup failed — buffer unchanged.' });
    }
  }

  private pauseRecording(): void {
    if (this.isPaused) {
      this.send({ type: 'paused' });
      return;
    }
    this.log.appendLine('[VTP] Manual pause — killing mic and entering wake monitor mode (buffer preserved).');
    this.isPaused = true;
    this.capture.kill();          // stop FFmpeg / Deepgram stream immediately
    this.send({ type: 'paused' });
    void this.checkForWakePhrase(); // listen for "resume" / "I'm back"
  }

  private async resumeRecording(): Promise<void> {
    // Kill any active FFmpeg process immediately — this unblocks the wake
    // monitor loop mid-cycle so it exits cleanly instead of racing with us.
    this.capture.kill();
    this.isPaused = false;
    this.log.appendLine('[VTP] Resumed — restarting to re-wire VAD callbacks.');
    await this.startRecording();
    this.send({ type: 'resumed' });
    // Re-render the preserved transcript so the user can see what they said
    // before pausing. startRecording() clears interimTranscript (correct) but
    // promptBuffer still holds the saved content.
    if (this.promptBuffer) {
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
    }
  }

  /**
   * Handles a voice side command by routing it to Antigravity's MCP toolchain.
   *
   * For URLs: injects "Please open [url] in the browser" → Antigravity uses
   *   its chrome-devtools-mcp `new_page` tool, keeping the browser session under
   *   AI control so the user can follow up with "scroll down", "take a screenshot", etc.
   *
   * For non-URL commands: injects the plain instruction as natural language.
   *   Examples: "search for React hooks", "take a screenshot", "scroll down".
   */
  private async handleSideCommand(instruction: string): Promise<void> {
    this.log.appendLine(`[VTP] Side command raw: "${instruction}"`);
    this.send({ type: 'commandFired', description: `🔗 Side cmd: ${instruction}` });

    // ── Step 1: normalize spoken URL patterns ──────────────────────────────
    const normalized = instruction
      .replace(/\s+dot\s+/gi, '.')
      .replace(/\s+slash\s+/gi, '/')
      .replace(/\.\s+([a-z]{2,6})\b/gi, '.$1')
      .replace(/([a-z])\s+\./gi, '$1.')
      .replace(/\.\s*([a-z])\s+([a-z])/gi, '.$1$2');

    // ── Step 2: build injection ────────────────────────────────────────────
    const urlMatch = normalized.match(
      /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9\-]+\.(?:com|org|net|io|dev|co|ai|app|gov|edu|uk|ca|au|me|info|tech|us|de|fr|jp|cn|ru|br|in|it|es|nl|se|no|dk|fi|pl|ch|be|at)[^\s]*)/i,
    );

    let injection: string;
    if (urlMatch) {
      const raw = urlMatch[0];
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      // Explicit MCP framing so the AI uses its browser tools, not a conversational reply.
      // Generic phrasing works across chrome-devtools-mcp, playwright-mcp, puppeteer-mcp, etc.
      injection = `[VTP Side Command] Use your MCP browser tools to open: ${url}`;
      this.log.appendLine(`[VTP] Side command → browser MCP: ${url}`);
    } else {
      // Non-URL: tell the AI to use MCP tools without specifying which ones
      injection = `[VTP Side Command] Use your available MCP tools to: ${normalized}`;
      this.log.appendLine(`[VTP] Side command → Antigravity MCP: "${normalized}"`);
    }

    try {
      await this.chatInjector.inject(injection);
    } catch (err) {
      this.log.appendLine(`[VTP] Side command inject error: ${this.formatError(err)}`);
    }
  }

  /** Transcribe a short wake-phrase audio chunk via Gemini (fallback/Gemini-engine path). */
  private async _transcribeWakeGemini(buffer: Buffer, mimeType: string, apiKey: string): Promise<string> {
    const base64 = buffer.toString('base64');
    const genai  = new GoogleGenerativeAI(apiKey);
    const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
    for (const modelName of MODELS) {
      try {
        const model = genai.getGenerativeModel({
          model: modelName,
          systemInstruction:
            'Transcribe the audio exactly as spoken. Output ONLY the spoken words. ' +
            'If there is no speech, output exactly: [SILENCE]',
          generationConfig: { temperature: 0 },
        });
        const res = await model.generateContent([
          { inlineData: { mimeType, data: base64 } },
          'Transcribe the audio.',
        ]);
        return res.response.text().trim();
      } catch (e) {
        const s = String(e);
        const retriable = s.includes('503') || s.includes('500') || s.includes('404') ||
          s.includes('overloaded') || s.includes('high demand') ||
          s.includes('Internal error') || s.includes('Service Unavailable') ||
          s.includes('no longer available');
        if (retriable) continue;
        throw e;
      }
    }
    return '';
  }

  /**
   * Wake-phrase monitor (runs while isPaused=true).
   *
   * When engine=deepgram: uses a live streaming WebSocket connection (same path
   * as normal recording) so every spoken word is transcribed with <300ms latency.
   * No more 1.5s polling windows — the word "resume" is caught the moment Deepgram
   * finalises the utterance.
   *
   * When engine=gemini: falls back to the fixed 1.5s capture-and-transcribe loop
   * (unchanged behaviour from before).
   */
  private async checkForWakePhrase(): Promise<void> {
    const savedTranscript = this.interimTranscript
      .replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();
    if (savedTranscript) {
      this.promptBuffer += (this.promptBuffer ? ' ' : '') + savedTranscript;
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
      this.log.appendLine(`[VTP] Saved to buffer before pause: "${savedTranscript}"`);
    }
    this.interimTranscript = '';

    this.capture.onChunkReady = null;
    await this._chunkQueue;

    // Stop whichever capture mode is currently active.
    const engine = vscode.workspace.getConfiguration('vtp').get<string>('transcriptionEngine', 'gemini');
    if (engine === 'deepgram') {
      await this.capture.stopStreaming();
      this._deepgramTranscriber?.disconnect();
      this._deepgramTranscriber = null;
    } else {
      await this.capture.stopChunked();
    }

    if (!this.isPaused) return;

    // Detach VAD callbacks — not used in wake-monitor mode
    this.capture.onSilenceDetected  = null;
    this.capture.onExtendedSilence  = null;
    this.capture.onSilenceStart     = null;

    this.log.appendLine('[VTP] Wake monitor active — say "resume" or "I\'m back"...');

    // ── Deepgram streaming wake monitor ──────────────────────────────────────
    if (engine === 'deepgram') {
      await this._checkForWakePhraseDeepgramStreaming();
      return;
    }

    // ── Gemini fallback: fixed 1.5s poll loop ────────────────────────────────
    while (this.isPaused) {
      try {
        await this.capture.start();
        await new Promise<void>((r) => setTimeout(r, 1_500));
        if (!this.isPaused) { this.capture.kill(); break; }

        const result = await this.capture.stop();
        if (!result) continue;
        if (!hasVoiceEnergy(result.buffer, 1500)) continue;

        const apiKey = await this.secretManager.getApiKey();
        if (!apiKey) continue;
        const wakeText = await this._transcribeWakeGemini(result.buffer, result.mimeType, apiKey);

        const clean = sanitizeTranscription(wakeText);
        if (!clean) continue;
        const text = clean.toLowerCase();
        this.log.appendLine(`[VTP] Wake monitor heard: "${text}"`);

        if (WAKE_PHRASE.test(text)) {
          this.log.appendLine('[VTP] Wake phrase matched — resuming.');
          if (!this.isPaused || this.capture.isRecording()) {
            this.log.appendLine('[VTP] Wake match: already active — skipping duplicate startRecording.');
            return;
          }
          await this._doResume(text);
          return;
        }
      } catch (err) {
        this.log.appendLine(`[VTP] Wake monitor error: ${this.formatError(err)}`);
        this.capture.kill();
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /**
   * Deepgram streaming wake monitor — mirrors the normal recording path exactly,
   * except onFinal checks for a wake phrase instead of routing to the intent pipeline.
   *
   * Why this beats the old batch-poll loop:
   *  - Deepgram's WebSocket transcribes audio in real time with ~300ms latency.
   *  - No 1.5s windows to miss — every word you say is heard immediately.
   *  - Uses the exact same FFmpeg→PCM→WebSocket pipeline as normal dictation,
   *    so there are no new code paths to break.
   */
  private async _checkForWakePhraseDeepgramStreaming(): Promise<void> {
    const dgKey = await this.secretManager.getSecret('vtp.deepgramApiKey');
    if (!dgKey) {
      this.log.appendLine('[VTP] Wake monitor: no Deepgram key — falling back to Gemini poll loop.');
      await this._wakeGeminiFallback();
      return;
    }

    const dgOpts: DeepgramOptions = {
      mipOptOut:       vscode.workspace.getConfiguration('vtp').get<boolean>('deepgramMipOptOut', false),
      profanityFilter: vscode.workspace.getConfiguration('vtp').get<boolean>('deepgramProfanityFilter', false),
      redact:          vscode.workspace.getConfiguration('vtp').get<string[]>('deepgramRedact', []) as DeepgramOptions['redact'],
    };

    // Loop so that if Deepgram disconnects unexpectedly while still paused we reconnect.
    while (this.isPaused) {
      let resolved = false;
      const dg = new DeepgramTranscriber(dgKey, dgOpts);
      this._deepgramTranscriber = dg;

      dg.onReady = () => {
        this.log.appendLine('[VTP] Wake monitor: Deepgram streaming connected.');
      };

      dg.onFinal = (text) => {
        if (!this.isPaused || resolved) return;
        const clean = sanitizeTranscription(text);
        if (!clean) return;
        const lower = clean.toLowerCase();
        this.log.appendLine(`[VTP] Wake monitor heard: "${lower}"`);

        if (WAKE_PHRASE.test(lower)) {
          this.log.appendLine('[VTP] Wake phrase matched — resuming.');
          resolved = true;
          // Disconnect before resuming so startRecording() gets a clean mic.
          dg.disconnect();
          this._deepgramTranscriber = null;
          void this.capture.stopStreaming().then(() => this._doResume(lower));
        }
      };

      dg.onError = (err) => {
        this.log.appendLine(`[VTP] Wake monitor Deepgram error: ${err.message}`);
      };

      this.capture.onPcmData = (pcm) => { dg.send(pcm); };
      dg.connect();

      try {
        await this.capture.startStreaming();
      } catch (err) {
        this.log.appendLine(`[VTP] Wake monitor stream start error: ${this.formatError(err)}`);
        dg.disconnect();
        this._deepgramTranscriber = null;
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      // Wait until either isPaused flips false (wake matched) or we need to loop.
      await new Promise<void>((r) => {
        const check = setInterval(() => {
          if (!this.isPaused || resolved) { clearInterval(check); r(); }
        }, 100);
      });

      // Clean up this streaming session before looping / returning.
      if (!resolved) {
        // Still paused but loop iteration ended (shouldn't normally happen) — clean up.
        dg.disconnect();
        this._deepgramTranscriber = null;
        await this.capture.stopStreaming();
      }

      if (resolved || !this.isPaused) return;
    }
  }

  /** Shared resume action: flip state, start recording, restore buffer. */
  private async _doResume(wakeText: string): Promise<void> {
    if (!this.isPaused || this.capture.isRecording()) {
      this.log.appendLine('[VTP] _doResume: already active — skipping.');
      return;
    }
    this.isPaused = false;
    this.justResumed = true;
    this.send({ type: 'resumed' });
    const hasSendInWake = hasSendTrigger(wakeText);

    const savedTranscript = this.interimTranscript;
    await this.startRecording();
    if (savedTranscript) {
      this.interimTranscript = savedTranscript;
      this.send({ type: 'transcriptResult', text: savedTranscript });
    } else if (this.promptBuffer) {
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
    }

    if (hasSendInWake && this.promptBuffer.trim()) {
      this.log.appendLine('[VTP] Wake+send compound — injecting buffer immediately.');
      await this.injectRaw();
    }
  }

  /** Gemini-engine fallback poll loop (1.5s windows). */
  private async _wakeGeminiFallback(): Promise<void> {
    while (this.isPaused) {
      try {
        await this.capture.start();
        await new Promise<void>((r) => setTimeout(r, 1_500));
        if (!this.isPaused) { this.capture.kill(); break; }

        const result = await this.capture.stop();
        if (!result) continue;
        if (!hasVoiceEnergy(result.buffer, 1500)) continue;

        const apiKey = await this.secretManager.getApiKey();
        if (!apiKey) continue;
        const wakeText = await this._transcribeWakeGemini(result.buffer, result.mimeType, apiKey);

        const clean = sanitizeTranscription(wakeText);
        if (!clean) continue;
        const text = clean.toLowerCase();
        this.log.appendLine(`[VTP] Wake monitor heard: "${text}"`);

        if (WAKE_PHRASE.test(text)) {
          this.log.appendLine('[VTP] Wake phrase matched — resuming.');
          if (!this.isPaused || this.capture.isRecording()) {
            this.log.appendLine('[VTP] Wake match: already active — skipping duplicate startRecording.');
            return;
          }
          await this._doResume(text);
          return;
        }
      } catch (err) {
        this.log.appendLine(`[VTP] Wake monitor error: ${this.formatError(err)}`);
        this.capture.kill();
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /**
   * Transcribes a short audio chunk using Deepgram's prerecorded (batch) HTTP API.
   * Retained as a utility but no longer used by the Deepgram wake monitor path
   * (which now uses streaming). Still available as a fallback if needed.
   */
  private transcribeWakeChunkDeepgram(
    buffer: Buffer,
    mimeType: string,
    apiKey: string,
  ): Promise<string> {
    return new Promise((resolve) => {
      const req = https.request(
        {
          method:   'POST',
          hostname: 'api.deepgram.com',
          path:     '/v1/listen?model=nova-2&smart_format=true',
          headers: {
            'Authorization':  `Token ${apiKey}`,
            'Content-Type':   mimeType,
            'Content-Length': buffer.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              const t = body?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
              resolve(t.trim());
            } catch { resolve(''); }
          });
        },
      );
      req.on('error', () => resolve(''));
      req.write(buffer);
      req.end();
    });
  }

  // ── Transcription ─────────────────────────────────────────────────────────

  private async processLiveChunk(buffer: Buffer, mimeType: string, sessionGen: number): Promise<void> {
    if (sessionGen !== this._sessionGen) return;
    if (buffer.length < 4096) return;
    if (!hasVoiceEnergy(buffer)) return;

    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) return;

    try {
      const base64 = buffer.toString('base64');
      const genai = new GoogleGenerativeAI(apiKey);
      const sysInstruction =
        'You are a verbatim speech-to-text transcriber. ' +
        'Your ONLY job is to write down the exact words spoken in the audio, nothing more. ' +
        'Output plain text only — no timestamps, no VTT format, no SRT format, no speaker labels. ' +
        'Do NOT infer, complete, or expand on what was said. ' +
        'Do NOT generate content that was not clearly spoken in the audio. ' +
        'If the audio contains silence, background noise, or no intelligible speech, output exactly: [SILENCE]';

      const CHUNK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
      let raw: string | null = null;

      const CHUNK_TIMEOUT_MS = 10000;
      let chunkTimedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          chunkTimedOut = true;
          reject(new Error('chunk-timeout'));
        }, CHUNK_TIMEOUT_MS);
      });

      try {
        for (const modelName of CHUNK_MODELS) {
          if (chunkTimedOut) break;
          try {
            const model = genai.getGenerativeModel({
              model: modelName,
              systemInstruction: sysInstruction,
              generationConfig: { temperature: 0 },
            });
            const res = await Promise.race([
              model.generateContent([
                { inlineData: { mimeType, data: base64 } },
                'Transcribe the audio.',
              ]),
              timeoutPromise,
            ]);
            raw = res.response.text().trim();
            break;
          } catch (e) {
            const s = String(e);
            if (s === 'Error: chunk-timeout') { throw e; }
            if (s.includes('503') || s.includes('500') || s.includes('404') ||
              s.includes('overloaded') || s.includes('high demand') ||
              s.includes('Internal error') || s.includes('Service Unavailable') ||
              s.includes('no longer available')) {
              continue;
            }
            throw e;
          }
        }
      } catch (e) {
        clearTimeout(timeoutHandle!);
        const s = String(e);
        if (s.includes('chunk-timeout')) {
          this.log.appendLine('[VTP] ⚠ Chunk timed out (10s) — skipping to unblock queue.');
          if (!this._sendTriggerFired && hasSendTrigger(this.interimTranscript)) {
            this._sendTriggerFired = true;
            this._restartAfterSend = true;
            this.capture.kill();
            this.log.appendLine('[VTP] Send trigger recovered from interimTranscript after chunk timeout.');
            this.send({ type: 'vadAutoStop' });
            void this.stopRecording();
          } else if (!this._enhanceTriggerFired && !this._sendTriggerFired) {
            if (ENHANCE_LIVE.test(this.interimTranscript)) {
              this._enhanceTriggerFired = true;
              this.capture.kill();
              this.log.appendLine('[VTP] Enhance trigger recovered from interimTranscript after chunk timeout.');
              this.send({ type: 'vadAutoStop' });
              void this.stopRecording();
            }
          }
          return;
        }
        throw e;
      }
      clearTimeout(timeoutHandle!);

      if (this.isPaused) return;
      if (raw === null) {
        this.log.appendLine('[VTP] All models busy — chunk skipped.');
        return;
      }

      const text = sanitizeTranscription(raw);
      if (!text || /^\[\s*SILENCE\s*\]$/i.test(text)) return;

      if (PAUSE_CMD.test(text)) {
        this.log.appendLine('[VTP] Live chunk: "pause" detected — mic muted, draining queue then pausing.');
        this.capture.kill();
        this._chunkQueue = this._chunkQueue.then(() => {
          this.interimTranscript = '';
          this.send({ type: 'transcriptResult', text: this.promptBuffer });
          this.isPaused = true;
          this.send({ type: 'paused' });
          void this.checkForWakePhrase();
        });
        return;
      }

      this.interimTranscript = this.interimTranscript
        ? this.interimTranscript + ' ' + text
        : text;

      const displayText = this.promptBuffer
        ? this.promptBuffer + ' ' + this.interimTranscript
        : this.interimTranscript;
      this.send({ type: 'transcriptResult', text: displayText });
      this.log.appendLine(`[VTP] Live chunk: "${text}"`);

      if (!this._sendTriggerFired && (hasSendTrigger(this.interimTranscript) || hasSendTrigger(text))) {
        this._sendTriggerFired = true;
        this._restartAfterSend = true;
        this.capture.kill();
        this.log.appendLine('[VTP] Send trigger — mic muted, draining queue then injecting.');
        this.send({ type: 'vadAutoStop' });
        void this.stopRecording();
      }

      if (!this._enhanceTriggerFired && !this._sendTriggerFired && ENHANCE_LIVE.test(this.interimTranscript)) {
        this._enhanceTriggerFired = true;
        this.capture.kill();
        this.log.appendLine('[VTP] Enhance trigger — mic muted, draining queue then enhancing.');
        this.send({ type: 'vadAutoStop' });
        void this.stopRecording();
      }

      const chunkWordCount = text.split(/\s+/).filter(Boolean).length;
      const newChars = this.interimTranscript.length - this._lastAsyncClassifiedLength;
      const shouldClassify = !this._sendTriggerFired
        && !this._enhanceTriggerFired
        && chunkWordCount <= 4
        && newChars >= 3
        && this.interimTranscript.trim().length >= 3;

      if (shouldClassify) {
        this._lastAsyncClassifiedLength = this.interimTranscript.length;
        void this.asyncCheckIntent(this.interimTranscript);
      }
    } catch (err) {
      this.log.appendLine(`[VTP] Chunk transcription error: ${this.formatError(err)}`);
    }
  }

  private extractTitle(id: string, rawLog: string): string {
    const match = rawLog.substring(0, 1000).match(/(?:title|Title)[:\s]+([^\n]{1,80})/);
    return match ? match[1].trim() : `Conversation ${id.slice(0, 8)}`;
  }

  private async transcribeAndProcess(buffer: Buffer, mimeType: string): Promise<void> {
    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) {
      this.send({ type: 'error', message: 'No API key set. Click KEY to add one.' });
      return;
    }
    this.log.appendLine('[VTP] Transcribing audio via Gemini...');
    if (buffer.length < 8192) {
      this.log.appendLine(`[VTP] Audio too short (${buffer.length} bytes) — skipping.`);
      return;
    }
    const base64 = buffer.toString('base64');
    try {
      const genai = new GoogleGenerativeAI(apiKey);
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
      const text = sanitizeTranscription(raw);
      this.log.appendLine(`[VTP] Transcription: "${text}"`);
      if (!text || text === '[SILENCE]') {
        this.log.appendLine('[VTP] No speech detected — skipping.');
        return;
      }
      this.send({ type: 'transcriptResult', text });
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

  // ── onFinalTranscript ─────────────────────────────────────────────────────

  private async onFinalTranscript(segment: string): Promise<void> {
    if (this._awaitingEnhancementDecision) {
      const lc = segment.toLowerCase();
      if (ENHANCE_APPROVE.test(lc)) {
        this.log.appendLine('[VTP] Voice command: approve enhancement.');
        await this.handleEnhancementDecision('approve');
        return;
      }
      if (ENHANCE_REJECT.test(lc)) {
        this.log.appendLine('[VTP] Voice command: reject enhancement.');
        await this.handleEnhancementDecision('reject');
        return;
      }
      if (ENHANCE_REGEN.test(lc)) {
        this.log.appendLine('[VTP] Voice command: regenerate enhancement.');
        await this.handleEnhancementDecision('regenerate');
        return;
      }
      this.log.appendLine('[VTP] Enhancement pending — discarding non-decision speech.');
      this.send({ type: 'awaitingDecision' });
      return;
    }

    if (PAUSE_CMD.test(segment)) {
      // Save whatever was said *before* "pause" into the buffer so it
      // survives the pause/resume cycle.
      const prePause = segment.replace(PAUSE_CMD, '').replace(/\s{2,}/g, ' ').trim();
      if (prePause) {
        this.promptBuffer += (this.promptBuffer ? ' ' : '') + prePause;
        this.send({ type: 'transcriptResult', text: this.promptBuffer });
        this.log.appendLine(`[VTP] Pre-pause content saved: "${prePause}"`);
      }
      this.log.appendLine('[VTP] Voice command: pause.');
      this._vadStop = false;
      this.pauseRecording();
      void this.checkForWakePhrase();
      return;
    }

    if (CLEAR_FINAL_CMD.test(segment)) {
      this.promptBuffer = '';
      this.interimTranscript = '';
      this.send({ type: 'transcriptResult', text: '' });
      this.log.appendLine('[VTP] Voice command: clear transcript.');
      return;
    }

    if (CLEAN_CMD.test(segment)) {
      this.log.appendLine('[VTP] Voice command: clean transcript (Gemini mode).');
      void this.cleanAndApply();
      return;
    }

    if (this._sendTriggerFired) {
      const content = stripSendTrigger(segment);
      if (content) { this.promptBuffer += (this.promptBuffer ? ' ' : '') + content; }
      this.log.appendLine('[VTP] SEND (local trigger — Gemini bypassed).');
      if (!this.promptBuffer.trim()) {
        this.send({ type: 'error', message: 'Nothing to send — say something first.' });
      } else {
        await this.injectRaw();
        void this._postSendFlow();
      }
      return;
    }

    if (this._enhanceTriggerFired) {
      this._enhanceTriggerFired = false;
      const content = stripEnhanceTrigger(segment);
      if (content) { this.promptBuffer += (this.promptBuffer ? ' ' : '') + content; }
      this.log.appendLine('[VTP] ENHANCE (local trigger — Gemini classification bypassed).');
      await this.elaborateAndShow();
      return;
    }

    const segmentCleaned = stripFiller(segment);

    if (!this._sendTriggerFired && hasSendTrigger(segment.slice(-120))) {
      this._sendTriggerFired = true;
      const tailCleaned = stripSendTrigger(segment);
      if (tailCleaned) { this.promptBuffer += (this.promptBuffer ? ' ' : '') + tailCleaned; }
      this.log.appendLine('[VTP] SEND (tail-scan trigger — chunk boundary recovery).');
      if (!this.promptBuffer.trim()) {
        this.send({ type: 'error', message: 'Nothing to send — say something first.' });
      } else {
        await this.injectRaw();
        void this._postSendFlow();
      }
      return;
    }

    if (!SEND_TRIGGER.test(segment) && !SEND_TRIGGER.test(segmentCleaned) && !ACTION_TRIGGER.test(segment)) {
      this.promptBuffer += (this.promptBuffer ? ' ' : '') + segment;
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
      this.log.appendLine('[VTP] Plain dictation — added to buffer verbatim (no classification).');
      return;
    }

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
          this.promptBuffer += (this.promptBuffer ? ' ' : '') + segment;
          this.send({ type: 'transcriptResult', text: this.promptBuffer });
          break;
        case 'COMMAND': {
          const desc = await this.commandExecutor!.execute(result.commandIntent ?? segment);
          this.send({ type: 'commandFired', description: desc });
          break;
        }
        case 'ENHANCE':
          if (result.content) { this.promptBuffer += (this.promptBuffer ? ' ' : '') + result.content; }
          await this.elaborateAndShow();
          break;
        case 'SEND': {
          if (result.content) {
            this.promptBuffer += (this.promptBuffer ? ' ' : '') + result.content;
            this.log.appendLine(`[VTP] SEND with inline content: "${result.content}"`);
          }
          if (!this.promptBuffer.trim()) {
            this.send({ type: 'error', message: 'Nothing to send — say something first.' });
          } else {
            await this.injectRaw();
            void this._postSendFlow();
          }
          break;
        }
        case 'CANCEL':
          this.promptBuffer = '';
          this.interimTranscript = '';
          this.send({ type: 'transcriptResult', text: '' });
          break;
      }
    } catch (err) {
      const msg = this.formatError(err);
      this.log.appendLine(`[VTP] Intent error: ${msg}`);
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

  private async injectRaw(): Promise<void> {
    const prompt = this.promptBuffer.trim();
    this.log.appendLine(`[VTP] Injecting raw buffer (${prompt.length} chars).`);
    await this.chatInjector.inject(prompt);
    this.promptBuffer = '';
    this.interimTranscript = '';
    this.send({ type: 'injected' });
  }

  private async asyncCheckIntent(snapshot: string): Promise<void> {
    try {
      const apiKey = await this.secretManager.getApiKey();
      if (!apiKey) return;
      this.ensurePipeline(apiKey);
      const context = this.cachedContext ?? await this.contextCollector.collect();
      const result = await this.intentProcessor!.classify(snapshot, this.promptBuffer, context);
      if (this._sendTriggerFired || this._enhanceTriggerFired) return;
      if (result.type === 'SEND') {
        this._sendTriggerFired = true;
        this._restartAfterSend = true;
        this.capture.kill();
        this.log.appendLine('[VTP] Send trigger (async intent) — mic muted, draining queue then injecting.');
        this.send({ type: 'vadAutoStop' });
        void this.stopRecording();
      } else if (result.type === 'ENHANCE') {
        this._enhanceTriggerFired = true;
        this.capture.kill();
        this.log.appendLine('[VTP] Enhance trigger (async intent) — mic muted, draining queue then enhancing.');
        this.send({ type: 'vadAutoStop' });
        void this.stopRecording();
      }
    } catch {
      // Silently swallow — best-effort background check.
    }
  }

  // ── Enhancement ───────────────────────────────────────────────────────────

  private async elaborateAndShow(): Promise<void> {
    if (!this.promptBuffer.trim()) {
      this.send({ type: 'error', message: 'Nothing to enhance — say something first.' });
      return;
    }
    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) return;
    this.ensurePipeline(apiKey);
    this.send({ type: 'elaborating' });
    this._originalBufferBeforeEnhance = this.promptBuffer;
    try {
      const context = await this.contextCollector.collect();
      const conversation = this.getEffectiveConversation();
      const elaborated = await this.withRetry(() =>
        this.promptElaborator!.elaborate(this.promptBuffer, context, conversation),
      );
      this.promptBuffer = elaborated;
      this._awaitingEnhancementDecision = true;
      this.send({ type: 'elaborated', prompt: elaborated, original: this._originalBufferBeforeEnhance });
      this.log.appendLine('[VTP] Enhancement ready -- restarting mic for voice decision.');
      void this.startRecording();
    } catch (err) {
      this._awaitingEnhancementDecision = false;
      const msg = this.formatError(err);
      this.send({ type: 'error', message: msg });
    }
  }

  private async handleEnhancementDecision(action: 'approve' | 'reject' | 'regenerate'): Promise<void> {
    this._awaitingEnhancementDecision = false;
    this.interimTranscript = '';
    if (action === 'approve') {
      this.log.appendLine('[VTP] Enhancement approved.');
      this.send({ type: 'enhancedApproved' });
      void this.startRecording();
    } else if (action === 'reject') {
      this.promptBuffer = this._originalBufferBeforeEnhance;
      this.log.appendLine('[VTP] Enhancement rejected -- original restored.');
      this.send({ type: 'enhancedRejected', original: this._originalBufferBeforeEnhance });
      void this.startRecording();
    } else if (action === 'regenerate') {
      this.promptBuffer = this._originalBufferBeforeEnhance;
      this.log.appendLine('[VTP] Enhancement regenerate — re-elaborating original.');
      await this.elaborateAndShow();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err: unknown) {
        const msg = String(err);
        const is429 = msg.includes('429') || msg.includes('Too Many Requests');
        const is503 = msg.includes('503') || msg.includes('Service Unavailable') || msg.includes('high demand');
        const isRetryable = (is429 || is503) && attempt < maxRetries;
        if (isRetryable) {
          attempt++;
          let wait: number;
          if (is429) {
            const m = msg.match(/retryDelay['"\s:]+(\d+)s/);
            wait = m ? parseInt(m[1], 10) : 30;
            this.log.appendLine(`[VTP] Rate limited — retrying in ${wait}s (${attempt}/${maxRetries})`);
            this.send({ type: 'error', message: `Rate limited — retrying in ${wait}s…` });
          } else {
            wait = attempt * 5;
            this.log.appendLine(`[VTP] Gemini overloaded (503) — retrying in ${wait}s (${attempt}/${maxRetries})`);
            this.send({ type: 'error', message: `Gemini busy — retrying in ${wait}s…` });
          }
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
    if (msg.includes('503') || msg.includes('Service Unavailable') || msg.includes('high demand')) {
      return 'Gemini is experiencing high demand — text saved to buffer, will retry next time.';
    }
    return msg;
  }

  private refreshContext(): void {
    // Don't run while recording or paused — context is stable during a session
    // and the log entries confuse debugging.
    if (this.capture.isRecording() || this.isPaused) return;
    Promise.all([
      this.contextCollector.collect(),
      this.conversationMatcher.findBestMatch(),
    ]).then(([context, conversation]) => {
      // Only log + send if something meaningful changed
      const newTitle = conversation?.title ?? 'none';
      const prevTitle = this.cachedConversation?.title ?? 'none';
      const prevWorkspace = this.cachedContext?.workspaceName ?? '';
      const changed = newTitle !== prevTitle || context.workspaceName !== prevWorkspace;

      this.cachedContext = context;
      this.cachedConversation = conversation;

      if (changed) {
        const shortTitle = newTitle.length > 60 ? newTitle.slice(0, 57) + '...' : newTitle;
        const extrasCount = this._extraConversations.length;
        this.log.appendLine(`[VTP] Context ready — workspace="${context.workspaceName}", conv="${shortTitle}", extras=${extrasCount}`);
        this.send({
          type: 'contextUpdate',
          workspaceName: context.workspaceName,
          conversationTitle: shortTitle,
          pinned: extrasCount > 0,
        });
      }
    }).catch((e) => this.log.appendLine(`[VTP] Context error: ${e}`));
  }

  private getEffectiveConversation(): MatchedConversation | null {
    const primary = this.cachedConversation;
    if (!this._extraConversations.length) return primary;
    const primaryMsgs = primary?.messages ?? [];
    const extraMsgs = this._extraConversations.flatMap((c) => c.messages);
    const depth = vscode.workspace.getConfiguration('vtp').get<number>('contextDepth', 20);
    return {
      id: (primary?.id ?? 'primary') + '+' + this._extraConversations.map((c) => c.id).join('+'),
      title: primary?.title ?? 'none',
      messages: [...primaryMsgs, ...extraMsgs].slice(-depth * 2),
      score: primary?.score ?? 0,
    };
  }

  private async openConversationPicker(): Promise<void> {
    const all: ScoredConversation[] = await this.conversationMatcher.findAllMatches();
    if (!all.length) {
      vscode.window.showWarningMessage('VTP: No Antigravity conversation logs found in ~/.gemini/antigravity/brain.');
      return;
    }
    const primaryId = this.cachedConversation?.id;
    const fmt = (c: ScoredConversation): string => {
      const d = new Date(c.lastModified);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return `${c.title}   ${date}`;
    };
    type Item = vscode.QuickPickItem & { conv?: ScoredConversation };
    const items: Item[] = [
      {
        label: `$(eye)  Current (auto): ${this.cachedConversation?.title?.slice(0, 50) ?? 'none'}`,
        description: 'Primary context — auto-detected, always active',
        kind: vscode.QuickPickItemKind.Default,
      },
      { label: 'Extra context — toggle to add or remove', kind: vscode.QuickPickItemKind.Separator },
      ...all
        .filter((c) => c.id !== primaryId)
        .map((c): Item => ({
          label: fmt(c),
          description: c.workspacePath || undefined,
          picked: this._extraConversations.some((e) => e.id === c.id),
          conv: c,
        })),
    ];

    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'VTP — Extra Conversation Context';
    qp.placeholder = 'Check conversations to add as supplementary context (read-only)';
    qp.canSelectMany = true;
    qp.matchOnDescription = true;
    qp.items = items;
    qp.selectedItems = items.filter((i) => i.conv && this._extraConversations.some((e) => e.id === i.conv!.id));

    const result = await new Promise<Item[] | undefined>((resolve) => {
      qp.onDidAccept(() => { resolve([...qp.selectedItems]); qp.dispose(); });
      qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
      qp.show();
    });

    if (result === undefined) return;
    const newExtras = result.filter((i) => !!i.conv).map((i) => i.conv!);
    this._extraConversations = newExtras;
    const extrasCount = newExtras.length;
    const primaryTitle = this.cachedConversation?.title ?? 'none';
    const shortTitle = primaryTitle.length > 60 ? primaryTitle.slice(0, 57) + '...' : primaryTitle;
    this.log.appendLine(`[VTP] Extra context updated: ${extrasCount} conversation(s) added.`);
    this.send({
      type: 'contextUpdate',
      workspaceName: this.cachedContext?.workspaceName ?? '',
      conversationTitle: shortTitle,
      pinned: extrasCount > 0,
      extrasCount,
    });
  }

  private ensurePipeline(apiKey: string): void {
    const model = vscode.workspace.getConfiguration('vtp').get<string>('elaborationModel', 'gemini-2.5-flash');
    if (!this.intentProcessor) this.intentProcessor = new IntentProcessor(apiKey);
    if (!this.commandExecutor) this.commandExecutor = new CommandExecutor(this.commandRegistry.getCommands());
    if (!this.promptElaborator) this.promptElaborator = new PromptElaborator(apiKey, model);
  }

  private send(msg: ExtensionMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'));
    const nonce = this.nonce();
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'panel.html');
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

  /**
   * Public toggle used by the global hotkey and `vtp.toggleRecording` command.
   * Can be called from any app — the sidebar is focused by extension.ts first.
   */
  public toggleRecording(): void {
    if (this.capture.isRecording()) {
      this.log.appendLine('[VTP] toggleRecording: stopping.');
      void this.stopRecording();
    } else if (this.isPaused) {
      this.log.appendLine('[VTP] toggleRecording: resuming from pause.');
      void this.resumeRecording();
    } else {
      this.log.appendLine('[VTP] toggleRecording: starting.');
      void this.startRecording();
    }
  }

  dispose(): void {
    this.capture.kill();
    this._voiceActivationMonitor?.stop();
    this.commandRegistry.dispose();
  }
}
