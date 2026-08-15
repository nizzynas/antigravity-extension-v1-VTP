import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  PanelMessage,
  ExtensionMessage,
  WorkspaceContext,
  MatchedConversation,
} from '../types';
import { ScoredConversation } from '../context/ConversationMatcher';
import { WorkspaceContextCollector } from '../context/WorkspaceContextCollector';
import { ConversationMatcher } from '../context/ConversationMatcher';
import { IntentProcessor } from '../pipeline/IntentProcessor';
import { CommandExecutor } from '../pipeline/CommandExecutor';
import { PromptElaborator, NoLocalModelError } from '../pipeline/PromptElaborator';
import { PromptCleaner } from '../pipeline/PromptCleaner';
import { OllamaClient } from '../pipeline/OllamaClient';
import { ChatInjector } from '../pipeline/ChatInjector';
import { CommandRegistry } from '../commands/CommandRegistry';
import { VoskModelManager } from '../audio/VoskModelManager';
import { MicCapture } from '../audio/MicCapture';
import { SettingsManager } from './SettingsManager';
import {
  hasSendTrigger,
  stripSendTrigger,
  stripEnhanceTrigger,
  stripFiller,
  PAUSE_CMD,
  CLEAR_CMD,
  CLEAR_FINAL_CMD,
  CLEAN_CMD,
  CLEAN_REVIEW_CMD,
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

type WakeMode = 'idle' | 'paused';

/**
 * VTPPanel — orchestrates the fully-local voice→prompt pipeline.
 *
 * Speech-to-text runs in the WEBVIEW via Vosk (WASM). The host tells the webview
 * when to capture (micStart/micStop) and receives transcripts back
 * (voskPartial / voskResult). Everything downstream — trigger detection, intent,
 * cleanup, optional Ollama enhancement, injection — runs here in the host. No
 * FFmpeg, no cloud STT, no API key.
 */
export class VTPPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'vtp.panel';

  private view?: vscode.WebviewView;
  private promptBuffer = '';
  private cachedContext: WorkspaceContext | null = null;
  private cachedConversation: MatchedConversation | null = null;
  private _extraConversations: ScoredConversation[] = [];
  private _lockedConversationId: string | null = null;

  private intentProcessor: IntentProcessor | null = null;
  private commandExecutor: CommandExecutor | null = null;
  private promptElaborator: PromptElaborator | null = null;

  private readonly contextCollector = new WorkspaceContextCollector();
  private readonly conversationMatcher: ConversationMatcher;
  private readonly commandRegistry: CommandRegistry;
  private readonly chatInjector = new ChatInjector();
  private readonly settings: SettingsManager;

  private _brainWatcher: fs.FSWatcher | null = null;
  private _workspaceSub: vscode.Disposable | null = null;
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly REFRESH_DEBOUNCE_MS = 2_000;

  // ── Capture / STT state ────────────────────────────────────────────────────
  private readonly mic = new MicCapture();
  private _voskReady = false;
  private _ffmpegReady = false;
  private _micOn = false;
  private isRecording = false;
  private isPaused = false;
  private _wakeActive = false;
  private _wakeMode: WakeMode | null = null;

  // ── Input meter ────────────────────────────────────────────────────────────
  // Levels are measured on the same PCM we hand to Vosk, so a moving bar proves
  // audio reached the recognizer — if words still don't appear, it's STT's fault.
  private static readonly METER_MS = 100;
  private static readonly METER_STALL_MS = 1_500;
  private _meterTimer: ReturnType<typeof setInterval> | null = null;
  private _levelSumSq = 0;
  private _levelCount = 0;
  private _levelPeak = 0;
  private _lastPcmAt = 0;
  private _lastSttAt = 0;
  private _micTestTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Input gate ─────────────────────────────────────────────────────────────
  // Below the sensitivity threshold nothing reaches Vosk, so background audio
  // (game sound, a TV, speaker bleed into the mic) never becomes prompt text.
  private static readonly GATE_HOLD_MS = 900;      // stay open after level drops
  private static readonly GATE_PREROLL_BYTES = 16_000; // ~0.5s of lead-in kept
  private _gateOpenUntil = 0;
  private _gateWasOpen = false;
  private _preroll: Buffer[] = [];
  private _prerollBytes = 0;
  private _lastPartialLogged = '';
  private _meterTicks = 0;

  private interimTranscript = '';
  private _sendTriggerFired = false;
  private _restartAfterSend = false;
  private _enhanceTriggerFired = false;
  private _stopping = false;
  private _sessionGen = 0;

  private _awaitingEnhancementDecision = false;
  private _originalBufferBeforeEnhance = '';
  private _lastCleanedSnapshot: string | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.OutputChannel,
    private readonly globalState: vscode.Memento,
    private readonly modelManager: VoskModelManager,
  ) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const contextDepth = vscode.workspace.getConfiguration('vtp').get<number>('contextDepth', 20);
    this.conversationMatcher = new ConversationMatcher(contextDepth);
    this.commandRegistry = new CommandRegistry(workspaceRoot);
    this.commandRegistry.initialize();
    this.settings = new SettingsManager({
      log: (msg) => this.log.appendLine(msg),
      send: (msg) => this.send(msg),
    });
    this.log.appendLine(`[VTP] Panel created (local mode). Workspace root: ${workspaceRoot ?? 'none'}`);
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    this.log.appendLine('[VTP] Webview resolved — panel opening.');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        this.modelManager.storageUri, // so the webview can fetch the downloaded model
      ],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: PanelMessage) => this.handleMessage(msg));
    this.startContextWatchers();
    webviewView.onDidDispose(() => this.stopContextWatchers());
  }

  // ── Message handler ─────────────────────────────────────────────────────────

  private async handleMessage(msg: PanelMessage): Promise<void> {
    if (msg.type !== 'log' && msg.type !== 'voskPartial') {
      this.log.appendLine(`[VTP] Message received: ${msg.type}`);
    }
    switch (msg.type) {
      case 'ready': await this.onPanelReady(); break;
      case 'startRecording': await this.startRecording(); break;
      case 'stopRecording': await this.stopRecording(); break;
      case 'pauseRecording': this.pauseRecording(); break;
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
      case 'showInfo': await this.settings.showInfo(); break;
      case 'selectContext': await this.openConversationPicker(); break;
      case 'openKeybindings':
        await vscode.commands.executeCommand(
          'workbench.action.openGlobalKeybindings',
          'VTP: Toggle Recording',
        );
        break;
      case 'switchInjectionTarget':
        await vscode.commands.executeCommand('vtp.switchTarget');
        await this.sendTargetState();
        break;
      case 'lockClaudeConversation':
        await vscode.commands.executeCommand('vtp.lockClaudeConversation');
        await this.sendTargetState();
        break;
      case 'onboardingComplete':
        await this.handleOnboardingComplete(msg);
        break;
      case 'applySettings':
        await this.handleApplySettings(msg.activationMode, msg.postSendMode, msg.wakePhrase);
        break;
      case 'setVoiceActivation': {
        const cfg    = vscode.workspace.getConfiguration('vtp');
        const phrase = msg.wakePhrase || cfg.get<string>('wakePhrase', 'hey antigravity');
        const activation: 'wake' | 'manual' = msg.enabled ? 'wake' : 'manual';
        const postSend = cfg.get<'continuous' | 'pause'>('postSendMode', 'pause');
        await this.handleApplySettings(activation, postSend, phrase);
        break;
      }
      case 'micTest': await this.runMicTest(); break;
      case 'setInputGate': {
        const db = Math.max(-70, Math.min(-10, Math.round(msg.db)));
        await vscode.workspace.getConfiguration('vtp')
          .update('inputGateDb', db, vscode.ConfigurationTarget.Global);
        this.log.appendLine(`[VTP] Input sensitivity set to ${db} dBFS.`);
        break;
      }
      // ── Vosk STT events from the webview ────────────────────────────────────
      case 'voskReady': this.onVoskReady(); break;
      case 'voskError': this.onVoskError(msg.message); break;
      case 'voskPartial':
        if (msg.text?.trim()) {
          this._lastSttAt = Date.now();
          // Log only when it changes — partials repeat many times per second.
          if (msg.text !== this._lastPartialLogged) {
            this._lastPartialLogged = msg.text;
            this.log.appendLine(`[VTP] Partial: "${msg.text}"`);
          }
        }
        this.onVoskPartial(msg.text);
        break;
      case 'voskResult':
        if (msg.text?.trim()) this._lastSttAt = Date.now();
        this.onVoskResult(msg.text);
        break;
      case 'log':
        this.log.appendLine(msg.message);
        break;
    }
  }

  // ── Panel init ──────────────────────────────────────────────────────────────

  private async onPanelReady(): Promise<void> {
    this.log.appendLine('[VTP] Panel ready — booting local STT.');
    const config = vscode.workspace.getConfiguration('vtp');
    this.refreshContext();
    await this.sendTargetState();
    this._sendSettingsStatus(config);

    await this.checkFFmpeg();

    // Kick off the one-time model download + load in the webview.
    void this.loadVoskModel();

    const onboarded = this.globalState.get<boolean>('vtp.onboarded', false);
    if (!onboarded) {
      setTimeout(() => this.send({ type: 'showOnboarding' }), 300);
      this.log.appendLine('[VTP] First run — showing onboarding.');
    }
  }

  private _sendSettingsStatus(config?: vscode.WorkspaceConfiguration): void {
    const cfg = config ?? vscode.workspace.getConfiguration('vtp');
    const activationMode = cfg.get<'wake' | 'manual'>('activationMode', 'wake');
    const postSendMode   = cfg.get<'continuous' | 'pause'>('postSendMode', 'pause');
    const wakePhrase     = cfg.get<string>('wakePhrase', 'hey antigravity');
    this.send({ type: 'settingsStatus', activationMode, postSendMode, wakePhrase });
  }

  // ── Vosk model loading ────────────────────────────────────────────────────

  private async loadVoskModel(): Promise<void> {
    try {
      this.send({ type: 'modelStatus', state: 'downloading', pct: 0 });
      await this.modelManager.ensureModel(
        (received, total) => {
          const pct = total ? Math.round((received / total) * 100) : undefined;
          this.send({ type: 'modelStatus', state: 'downloading', pct });
        },
        (msg) => this.send({ type: 'modelStatus', state: 'downloading', message: msg }),
      );
      this.send({ type: 'modelStatus', state: 'loading' });
      // Stream the model to the webview as base64 chunks, reading from disk
      // incrementally so we never hold the whole (up to ~130 MB) model in the
      // SHARED extension host — a big buffer here can destabilize other
      // extensions (e.g. Claude Code). 3 MB chunk = multiple of 3 so each
      // chunk's base64 is independently decodable in the webview.
      const size = (await fs.promises.stat(this.modelManager.modelPath)).size;
      const CHUNK = 3 * 1024 * 1024;
      const count = Math.ceil(size / CHUNK);
      this.log.appendLine(`[VTP] Streaming model to webview: ${size} bytes in ${count} chunks (from disk).`);
      const fd = await fs.promises.open(this.modelManager.modelPath, 'r');
      try {
        const buf = Buffer.allocUnsafe(CHUNK);
        for (let i = 0; i < count; i++) {
          const { bytesRead } = await fd.read(buf, 0, CHUNK, i * CHUNK);
          const slice = buf.subarray(0, bytesRead);
          this.send({ type: 'voskModelChunk', data: slice.toString('base64'), index: i, count, done: i === count - 1 });
        }
      } finally {
        await fd.close();
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[VTP] Model load failed: ${m}`);
      this.send({ type: 'modelStatus', state: 'error', message: m });
      this.send({ type: 'error', message: `Speech model failed to load: ${m}` });
    }
  }

  private onVoskReady(): void {
    this._voskReady = true;
    this.log.appendLine('[VTP] Vosk model ready — STT online.');
    this.send({ type: 'modelStatus', state: 'ready' });
    // Mic is captured host-side via FFmpeg (no browser permission needed), so
    // the always-on wake monitor can be armed immediately.
    const cfg = vscode.workspace.getConfiguration('vtp');
    const onboarded = this.globalState.get<boolean>('vtp.onboarded', false);
    if (onboarded && this._ffmpegReady && !this.isRecording && !this.isPaused &&
        cfg.get<string>('activationMode', 'wake') === 'wake') {
      this.startWakeMonitor('idle');
    }
  }

  private async checkFFmpeg(): Promise<void> {
    this._ffmpegReady = await MicCapture.isAvailable();
    this.log.appendLine(`[VTP] FFmpeg available: ${this._ffmpegReady}`);
    if (!this._ffmpegReady) {
      this.send({ type: 'error', message: 'FFmpeg not found — voice input needs it on PATH.' });
      const action = await vscode.window.showWarningMessage(
        'VTP: FFmpeg is required for microphone capture but was not found on your PATH.',
        'Download FFmpeg', 'How to Install',
      );
      if (action === 'Download FFmpeg') {
        vscode.env.openExternal(vscode.Uri.parse('https://ffmpeg.org/download.html'));
      } else if (action === 'How to Install') {
        vscode.env.openExternal(vscode.Uri.parse('https://www.wikihow.com/Install-FFmpeg-on-Windows'));
      }
    }
  }

  private onVoskError(message: string): void {
    this.log.appendLine(`[VTP] Vosk error: ${message}`);
    // Reset to a clean idle state BEFORE the error so the panel doesn't get
    // stuck on "Processing…" (recordingStopped → error ordering matters).
    if (this.isRecording || this._wakeActive) {
      this.isRecording = false;
      this.stopWakeMonitor();
      this.micStop();
      this.send({ type: 'recordingStopped' });
    }
    this.send({ type: 'error', message });
  }

  // ── Mic control (delegates to the webview) ─────────────────────────────────

  private async micStart(): Promise<void> {
    if (this._micOn) return;
    this._cancelMicTest();
    this._micOn = true;
    // Fresh recognizer for this session, then start piping FFmpeg PCM to it.
    this.send({ type: 'voskStart' });
    this.mic.onPcmData = (pcm) => {
      if (!this._micOn) return;
      this._gateAndForward(pcm, this._measure(pcm));
    };
    this.mic.onLog = (l) => this.log.appendLine(l);
    this.mic.gainDb = vscode.workspace.getConfiguration('vtp').get<number>('inputGainDb', 0);
    try {
      await this.mic.startStreaming();
      this._startMeter();
    } catch (e) {
      this._micOn = false;
      this.send({ type: 'error', message: `Mic capture failed: ${this.formatError(e)}` });
    }
  }

  private micStop(): void {
    if (!this._micOn) return;
    this._micOn = false;
    this.mic.onPcmData = null;
    void this.mic.stopStreaming();
    this._stopMeter();
    this.send({ type: 'voskStop' });
  }

  // ── Input meter ───────────────────────────────────────────────────────────

  /** Fold one PCM chunk into the current meter window; returns that chunk's RMS. */
  private _measure(pcm: Buffer): number {
    const samples = pcm.length >> 1;
    let sumSq = 0;
    for (let i = 0; i < samples; i++) {
      const s = pcm.readInt16LE(i * 2) / 32768;
      const mag = s < 0 ? -s : s;
      if (mag > this._levelPeak) this._levelPeak = mag;
      sumSq += s * s;
    }
    this._levelSumSq += sumSq;
    this._levelCount += samples;
    this._lastPcmAt = Date.now();
    return samples ? Math.sqrt(sumSq / samples) : 0;
  }

  /** Linear amplitude → dBFS, rounded, for log lines. */
  private db(v: number): number {
    return v > 0.000001 ? Math.round(20 * Math.log10(v)) : -99;
  }

  /** Configured sensitivity threshold, in dBFS. */
  private get gateDb(): number {
    return vscode.workspace.getConfiguration('vtp').get<number>('inputGateDb', -45);
  }

  private get gateRms(): number {
    return Math.pow(10, this.gateDb / 20);
  }

  /**
   * Pass a chunk to Vosk only while the gate is open. The gate opens the moment
   * the level clears the threshold and stays open briefly afterwards, and the
   * last half-second of held-back audio is flushed ahead of it so the first
   * syllable isn't clipped.
   */
  private _gateAndForward(pcm: Buffer, rms: number): void {
    const now = Date.now();
    if (rms >= this.gateRms) this._gateOpenUntil = now + VTPPanel.GATE_HOLD_MS;
    const open = now < this._gateOpenUntil;

    if (open) {
      if (!this._gateWasOpen && this._preroll.length) {
        for (const held of this._preroll) this.send({ type: 'voskPcm', data: held.toString('base64') });
      }
      this._preroll = []; this._prerollBytes = 0;
      this._gateWasOpen = true;
      this.send({ type: 'voskPcm', data: pcm.toString('base64') });
      return;
    }

    if (this._gateWasOpen) {
      // Closing: hand Vosk a beat of true silence so it finalizes the utterance
      // instead of waiting for audio that will never come.
      this._gateWasOpen = false;
      this.send({ type: 'voskPcm', data: Buffer.alloc(16_000).toString('base64') });
    }
    this._preroll.push(pcm);
    this._prerollBytes += pcm.length;
    while (this._prerollBytes > VTPPanel.GATE_PREROLL_BYTES && this._preroll.length > 1) {
      this._prerollBytes -= this._preroll.shift()!.length;
    }
  }

  private _resetGate(): void {
    this._gateOpenUntil = 0;
    this._gateWasOpen = false;
    this._preroll = [];
    this._prerollBytes = 0;
  }

  private _startMeter(test = false): void {
    this._lastPcmAt = Date.now();
    this._lastSttAt = Date.now();
    this._levelSumSq = this._levelCount = this._levelPeak = 0;
    this._resetGate();
    this._meterTicks = 0;
    this._lastPartialLogged = '';
    this.log.appendLine(
      `[VTP] Mic open${test ? ' (test)' : ''} — device="${this.mic.deviceName}" ` +
      `gain=${this.mic.gainDb}dB gate=${this.gateDb}dB`,
    );
    this.send({ type: 'micState', on: true, device: this.mic.deviceName, test, gateDb: this.gateDb });
    if (this._meterTimer) return;
    this._meterTimer = setInterval(() => {
      const rms = this._levelCount ? Math.sqrt(this._levelSumSq / this._levelCount) : 0;
      const peak = this._levelPeak;
      this._levelSumSq = this._levelCount = this._levelPeak = 0;
      const stalled = Date.now() - this._lastPcmAt > VTPPanel.METER_STALL_MS;
      const gateOpen = Date.now() < this._gateOpenUntil;
      this.send({
        type: 'micLevel',
        rms,
        peak,
        stalled,
        msSinceStt: Date.now() - this._lastSttAt,
        gateOpen,
        gateDb: this.gateDb,
      });
      // Once every 2s, drop a one-line snapshot into the log. This is what makes
      // a recorded session diagnosable after the fact.
      if (++this._meterTicks % 20 === 0) {
        this.log.appendLine(
          `[state] rec=${+this.isRecording} paused=${+this.isPaused} ` +
          `wake=${this._wakeActive ? this._wakeMode : 'off'} mic=${+this._micOn} ` +
          `vosk=${+this._voskReady} ffmpeg=${+this._ffmpegReady} ` +
          `gate=${gateOpen ? 'open' : 'shut'}@${this.gateDb}dB ` +
          `lvl=${this.db(rms)}dB peak=${this.db(peak)}dB stalled=${+stalled} ` +
          `sinceStt=${Date.now() - this._lastSttAt}ms ` +
          `buf=${this.promptBuffer.length} interim=${this.interimTranscript.length}`,
        );
      }
    }, VTPPanel.METER_MS);
  }

  private _stopMeter(): void {
    if (this._meterTimer) { clearInterval(this._meterTimer); this._meterTimer = null; }
    this._levelSumSq = this._levelCount = this._levelPeak = 0;
    this._resetGate();
    this.send({ type: 'micState', on: false, gateDb: this.gateDb });
  }

  /**
   * Mic-only check: run FFmpeg and drive the meter for a few seconds WITHOUT
   * Vosk, so the input device can be verified even when the model is still
   * downloading or has failed to load.
   */
  private async runMicTest(): Promise<void> {
    if (this._micOn || this._micTestTimer) return;
    if (!this._ffmpegReady) {
      await this.checkFFmpeg();
      if (!this._ffmpegReady) return;
    }
    this.log.appendLine('[VTP] Mic test — 8s of levels, no transcription.');
    this.mic.onPcmData = (pcm) => this._measure(pcm);
    this.mic.onLog = (l) => this.log.appendLine(l);
    this.mic.gainDb = vscode.workspace.getConfiguration('vtp').get<number>('inputGainDb', 0);
    try {
      await this.mic.startStreaming();
    } catch (e) {
      this.mic.onPcmData = null;
      this.send({ type: 'error', message: `Mic test failed: ${this.formatError(e)}` });
      return;
    }
    this._startMeter(true);
    this._micTestTimer = setTimeout(() => this._cancelMicTest(), 8_000);
  }

  private _cancelMicTest(): void {
    if (!this._micTestTimer) return;
    clearTimeout(this._micTestTimer);
    this._micTestTimer = null;
    this.mic.onPcmData = null;
    void this.mic.stopStreaming();
    this._stopMeter();
    this.log.appendLine('[VTP] Mic test ended.');
  }

  // ── Wake monitor ──────────────────────────────────────────────────────────

  private startWakeMonitor(mode: WakeMode): void {
    if (this.isRecording) return;
    if (!this._voskReady || !this._ffmpegReady) return;
    if (this._wakeActive && this._wakeMode === mode) return;
    this._wakeActive = true;
    this._wakeMode = mode;
    void this.micStart();
    const cfg = vscode.workspace.getConfiguration('vtp');
    if (mode === 'idle') {
      const phrase = cfg.get<string>('wakePhrase', 'hey antigravity');
      this.send({ type: 'wakeReady' });
      this.log.appendLine(`[VTP] Wake monitor (idle) — say "${phrase}".`);
    } else {
      this.send({ type: 'autoPaused' });
      this.log.appendLine('[VTP] Wake monitor (paused) — say "resume" or "I\'m back".');
    }
  }

  private stopWakeMonitor(): void {
    if (!this._wakeActive) return;
    this._wakeActive = false;
    this._wakeMode = null;
    this.micStop();
  }

  /** Normalize + fuzzy-match a heard phrase against the configured wake phrase. */
  private matchesWakePhrase(heard: string, phrase: string): boolean {
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^\w\s]/g, '').replace(/-/g, '').replace(/\s{2,}/g, ' ').trim();
    const h = normalize(heard);
    const p = normalize(phrase);
    if (!p) return false;
    if (h.includes(p)) return true;
    if (h.replace(/\s/g, '').includes(p.replace(/\s/g, ''))) return true;
    let pos = 0;
    for (const word of p.split(/\s+/).filter(Boolean)) {
      const idx = h.indexOf(word, pos);
      if (idx === -1) return false;
      pos = idx + word.length;
    }
    return true;
  }

  // ── Transcript event routing ────────────────────────────────────────────────

  private onVoskPartial(text: string): void {
    if (!this.isRecording || this.isPaused || this._awaitingEnhancementDecision) return;
    const interim = (this.interimTranscript + ' ' + text).trim();
    const display = this.promptBuffer ? this.promptBuffer + ' ' + interim : interim;
    this.send({ type: 'transcriptResult', text: display });
  }

  private onVoskResult(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // 1. Enhancement review — voice approve / reject / try-again.
    if (this._awaitingEnhancementDecision) {
      const lc = trimmed.toLowerCase();
      if (ENHANCE_APPROVE.test(lc)) { void this.handleEnhancementDecision('approve'); return; }
      if (ENHANCE_REJECT.test(lc))  { void this.handleEnhancementDecision('reject'); return; }
      if (ENHANCE_REGEN.test(lc))   { void this.handleEnhancementDecision('regenerate'); return; }
      this.send({ type: 'awaitingDecision' });
      return;
    }

    // 2. Wake monitor (idle → start, paused → resume).
    if (this._wakeActive) {
      const cfg = vscode.workspace.getConfiguration('vtp');
      this.log.appendLine(`[VTP] Wake monitor heard: "${trimmed}"`);
      this.send({ type: 'transcriptResult', text: `🎧 heard: "${trimmed}"` });
      if (this._wakeMode === 'paused') {
        if (WAKE_PHRASE.test(trimmed.toLowerCase())) {
          this.log.appendLine('[VTP] Resume phrase matched.');
          void this._doResume(trimmed);
        }
        return;
      }
      // idle
      const phrase = cfg.get<string>('wakePhrase', 'hey antigravity');
      if (this.matchesWakePhrase(trimmed, phrase)) {
        this.log.appendLine('[VTP] Wake phrase matched — starting recording.');
        // Keep anything the user said AFTER the wake phrase as dictation.
        const tail = this._stripWakePrefix(trimmed, phrase);
        this.stopWakeMonitor();
        void this.startRecording().then(() => {
          if (tail) this.onVoskResult(tail);
        });
      }
      return;
    }

    // 3. Active dictation.
    if (this.isRecording) {
      this.interimTranscript = (this.interimTranscript + ' ' + trimmed).trim();
      const display = this.promptBuffer ? this.promptBuffer + ' ' + this.interimTranscript : this.interimTranscript;
      this.send({ type: 'transcriptResult', text: display });
      this.log.appendLine(`[VTP] Final: "${trimmed}"`);
      this._processTranscriptChunk(trimmed, this._sessionGen);
    }
  }

  private _stripWakePrefix(text: string, phrase: string): string {
    // Remove everything up to and including the wake phrase, return the rest.
    const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
    const last = words[words.length - 1];
    const lower = text.toLowerCase();
    const idx = lower.indexOf(last);
    if (idx === -1) return '';
    return text.slice(idx + last.length).replace(/^[\s,.!?]+/, '').trim();
  }

  // ── Live trigger detection on each final utterance ──────────────────────────

  private _processTranscriptChunk(text: string, sessionGen: number): void {
    if (sessionGen !== this._sessionGen) return;
    const accumulated = this.interimTranscript;

    if (!this._sendTriggerFired && (hasSendTrigger(accumulated) || hasSendTrigger(text))) {
      this._sendTriggerFired = true;
      this._restartAfterSend = true;
      this.micStop();
      this.log.appendLine('[VTP] Send trigger — mic muted.');
      this.send({ type: 'vadAutoStop' });
      void this.stopRecording();
      return;
    }
    if (!this._enhanceTriggerFired && !this._sendTriggerFired && ENHANCE_LIVE.test(accumulated)) {
      this._enhanceTriggerFired = true;
      this.micStop();
      this.log.appendLine('[VTP] Enhance trigger — mic muted.');
      this.send({ type: 'vadAutoStop' });
      void this.stopRecording();
      return;
    }
    if (PAUSE_CMD.test(text)) {
      const pauseSide = extractPauseAndSideCmd(text);
      if (pauseSide) { void this.handleSideCommand(pauseSide); }
      this.interimTranscript = this.interimTranscript.replace(PAUSE_CMD, '').replace(/\s{2,}/g, ' ').trim();
      this.log.appendLine('[VTP] Pause command.');
      this._enterPause();
      return;
    }
    const sideCmd = extractSideCommand(text);
    if (sideCmd) {
      this.log.appendLine(`[VTP] Side command: "${sideCmd}"`);
      void this.handleSideCommand(sideCmd);
      this.interimTranscript = this.interimTranscript.replace(text, '').replace(/\s{2,}/g, ' ').trim();
      return;
    }
    if (CLEAR_CMD.test(text)) {
      this.log.appendLine('[VTP] Clear command.');
      this.interimTranscript = '';
      this.promptBuffer = '';
      this.send({ type: 'transcriptResult', text: '' });
      return;
    }
    if (CLEAN_REVIEW_CMD.test(text) || CLEAN_REVIEW_CMD.test(accumulated)) {
      this.log.appendLine('[VTP] Clean+review command.');
      this.micStop();
      this.isRecording = false;
      this.send({ type: 'recordingStopped' });
      void this.cleanAndReview();
      return;
    }
    if (CLEAN_CMD.test(text) || CLEAN_CMD.test(accumulated)) {
      this.log.appendLine('[VTP] Clean command.');
      this.micStop();
      this.isRecording = false;
      this.send({ type: 'recordingStopped' });
      void this.cleanAndApply();
      return;
    }
  }

  // ── Recording control ───────────────────────────────────────────────────────

  private async startRecording(): Promise<void> {
    if (!this._ffmpegReady) {
      await this.checkFFmpeg();
      if (!this._ffmpegReady) return;
    }
    if (!this._voskReady) {
      this.send({ type: 'error', message: 'Speech model still loading — one moment…' });
      return;
    }
    if (this.isRecording) return;

    this.stopWakeMonitor();
    this.isPaused = false;
    this._stopping = false;
    this.interimTranscript = '';
    this._sendTriggerFired = false;
    this._restartAfterSend = false;
    this._enhanceTriggerFired = false;
    this._sessionGen++;

    this.isRecording = true;
    await this.micStart();
    this.send({ type: 'recordingStarted' });
    this.log.appendLine('[VTP] Recording started (local Vosk).');
  }

  private async stopRecording(): Promise<void> {
    if (this._stopping) {
      this.send({ type: 'recordingStopped' });
      return;
    }
    this._stopping = true;
    this.isRecording = false;
    this.micStop();
    this.send({ type: 'recordingStopped' });

    try {
      const finalText = this.interimTranscript.trim();
      this.interimTranscript = '';
      const hasSpeech = finalText.length > 0;

      if (hasSpeech) {
        this.log.appendLine(`[VTP] Final transcript (${finalText.length} chars): "${finalText}"`);
        await this.onFinalTranscript(finalText);
      }

      // If we ended up idle (no send/enhance in flight) and wake mode is on, listen again.
      if (!this.isRecording && !this.isPaused && !this._awaitingEnhancementDecision && !this._restartAfterSend) {
        const cfg = vscode.workspace.getConfiguration('vtp');
        if (cfg.get<string>('activationMode', 'wake') === 'wake') {
          this.startWakeMonitor('idle');
        } else if (!hasSpeech) {
          this.send({ type: 'transcriptResult', text: this.promptBuffer });
        }
      }
    } catch (err) {
      this.send({ type: 'error', message: `Recording error: ${this.formatError(err)}` });
    } finally {
      this._stopping = false;
    }
  }

  private _enterPause(): void {
    // Save whatever is buffered, then drop into the paused wake monitor.
    const saved = this.interimTranscript.replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();
    if (saved) {
      this.promptBuffer += (this.promptBuffer ? ' ' : '') + saved;
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
    }
    this.interimTranscript = '';
    this.isRecording = false;
    this.isPaused = true;
    this.micStop();
    this.send({ type: 'paused' });
    this.startWakeMonitor('paused');
  }

  private pauseRecording(): void {
    if (this.isPaused) { this.send({ type: 'paused' }); return; }
    this.log.appendLine('[VTP] Manual pause.');
    this._enterPause();
  }

  private async resumeRecording(): Promise<void> {
    this.stopWakeMonitor();
    this.isPaused = false;
    this.log.appendLine('[VTP] Resumed.');
    await this.startRecording();
    this.send({ type: 'resumed' });
    if (this.promptBuffer) {
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
    }
  }

  /** Resume from the paused wake monitor. */
  private async _doResume(wakeText: string): Promise<void> {
    if (!this.isPaused) return;
    const hasSendInWake = hasSendTrigger(wakeText);
    this.stopWakeMonitor();
    this.isPaused = false;
    this.send({ type: 'resumed' });
    await this.startRecording();
    if (this.promptBuffer) {
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
    }
    if (hasSendInWake && this.promptBuffer.trim()) {
      this.log.appendLine('[VTP] Resume+send compound — injecting.');
      await this.injectRaw();
      void this._postSendFlow();
    }
  }

  // ── Post-send flow ──────────────────────────────────────────────────────────

  private async _postSendFlow(): Promise<void> {
    const cfg            = vscode.workspace.getConfiguration('vtp');
    const postSendMode   = cfg.get<'continuous' | 'pause'>('postSendMode', 'pause');
    const activationMode = cfg.get<'wake' | 'manual'>('activationMode', 'wake');

    if (postSendMode === 'continuous') {
      await new Promise<void>((r) => setTimeout(r, 800));
      if (!this.isRecording) {
        this.log.appendLine('[VTP] Post-send continuous — auto-resuming.');
        void this.startRecording();
      }
    } else if (activationMode === 'wake') {
      this.log.appendLine('[VTP] Post-send pause/wake — arming wake monitor.');
      this.startWakeMonitor('idle');
    } else {
      this.log.appendLine('[VTP] Post-send pause/manual — idle.');
    }
  }

  // ── Onboarding + settings ───────────────────────────────────────────────────

  private async handleOnboardingComplete(
    msg: Extract<PanelMessage, { type: 'onboardingComplete' }>,
  ): Promise<void> {
    this.log.appendLine(`[VTP] Onboarding complete. activation=${msg.activationMode}, postSend=${msg.postSendMode}, phrase="${msg.wakePhrase}"`);
    const cfg = vscode.workspace.getConfiguration('vtp');
    await cfg.update('activationMode', msg.activationMode, vscode.ConfigurationTarget.Global);
    await cfg.update('postSendMode',   msg.postSendMode,   vscode.ConfigurationTarget.Global);
    await cfg.update('wakePhrase',     msg.wakePhrase,     vscode.ConfigurationTarget.Global);
    await this.globalState.update('vtp.onboarded', true);
    this._sendSettingsStatus();
    if (msg.activationMode === 'wake' && this._voskReady && !this.isRecording && !this.isPaused) {
      this.startWakeMonitor('idle');
    }
  }

  private async handleApplySettings(
    activationMode: 'wake' | 'manual',
    postSendMode: 'continuous' | 'pause',
    wakePhrase: string,
  ): Promise<void> {
    // Reset to idle.
    this.stopWakeMonitor();
    if (this.isRecording) { this.isRecording = false; this.micStop(); this.send({ type: 'recordingStopped' }); }
    if (this.isPaused) { this.isPaused = false; this.send({ type: 'recordingStopped' }); }
    this.promptBuffer = '';
    this.interimTranscript = '';
    this._stopping = false;
    this._restartAfterSend = false;

    const cfg = vscode.workspace.getConfiguration('vtp');
    await cfg.update('activationMode', activationMode, vscode.ConfigurationTarget.Global);
    await cfg.update('postSendMode',   postSendMode,   vscode.ConfigurationTarget.Global);
    await cfg.update('wakePhrase',     wakePhrase,     vscode.ConfigurationTarget.Global);

    if (activationMode === 'wake' && this._voskReady) {
      this.startWakeMonitor('idle');
    }
    this.send({ type: 'transcriptResult', text: '' });
    this._sendSettingsStatus();
    this.log.appendLine(`[VTP] Settings applied: activation=${activationMode}, postSend=${postSendMode}, phrase="${wakePhrase}".`);
  }

  public async sendTargetState(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('vtp');
    const target = (cfg.get<string>('injectionTarget', 'antigravity') === 'claude-code'
      ? 'claude-code' : 'antigravity') as 'antigravity' | 'claude-code';
    const lockedTitle = cfg.get<string>('claudeCodeLockedTitle', '') || '';
    this.send({ type: 'targetState', target, lockedTitle });
  }

  // ── Context watchers ────────────────────────────────────────────────────────

  private startContextWatchers(): void {
    const brainDir = ConversationMatcher.getBrainDir();
    if (fs.existsSync(brainDir)) {
      try {
        this._brainWatcher = fs.watch(brainDir, { recursive: true, persistent: false }, (_e, filename) => {
          if (!filename) return;
          if (!(filename.includes('overview') || filename.includes('system_generated'))) return;
          const changedConvId = filename.split(/[\\/]/)[0];
          if (this._lockedConversationId && changedConvId && changedConvId !== this._lockedConversationId) return;
          this.scheduleRefresh();
        });
        this._brainWatcher.on('error', (err) => this.log.appendLine(`[VTP] Brain watcher error: ${err.message}`));
        this.log.appendLine('[VTP] Brain directory watcher started.');
      } catch (e: any) {
        this.log.appendLine(`[VTP] Could not watch brain dir: ${e.message}`);
      }
    }
    this._workspaceSub = vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh());
  }

  private scheduleRefresh(): void {
    if (this.isRecording || this.isPaused) return;
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => { this._refreshTimer = null; this.refreshContext(); }, VTPPanel.REFRESH_DEBOUNCE_MS);
  }

  private stopContextWatchers(): void {
    if (this._brainWatcher) { this._brainWatcher.close(); this._brainWatcher = null; }
    if (this._workspaceSub) { this._workspaceSub.dispose(); this._workspaceSub = null; }
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
  }

  // ── Side commands ───────────────────────────────────────────────────────────

  private async handleSideCommand(instruction: string): Promise<void> {
    this.log.appendLine(`[VTP] Side command raw: "${instruction}"`);
    this.send({ type: 'commandFired', description: `🔗 Side cmd: ${instruction}` });
    const normalized = instruction
      .replace(/\s+dot\s+/gi, '.')
      .replace(/\s+slash\s+/gi, '/')
      .replace(/\.\s+([a-z]{2,6})\b/gi, '.$1')
      .replace(/([a-z])\s+\./gi, '$1.')
      .replace(/\.\s*([a-z])\s+([a-z])/gi, '.$1$2');
    const urlMatch = normalized.match(
      /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9\-]+\.(?:com|org|net|io|dev|co|ai|app|gov|edu|uk|ca|au|me|info|tech|us|de|fr|jp|cn|ru|br|in|it|es|nl|se|no|dk|fi|pl|ch|be|at)[^\s]*)/i,
    );
    let injection: string;
    if (urlMatch) {
      const raw = urlMatch[0];
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      injection = `[VTP Side Command] Use your MCP browser tools to open: ${url}`;
    } else {
      injection = `[VTP Side Command] Use your available MCP tools to: ${normalized}`;
    }
    try {
      await this.chatInjector.inject(injection);
    } catch (err) {
      this.log.appendLine(`[VTP] Side command inject error: ${this.formatError(err)}`);
    }
  }

  // ── Cleanup passes ──────────────────────────────────────────────────────────

  private ollama(): OllamaClient {
    const model = vscode.workspace.getConfiguration('vtp').get<string>('enhancementModel', 'llama3.2');
    return new OllamaClient(model);
  }

  private async cleanAndReview(): Promise<void> {
    const text = (this.promptBuffer || this.interimTranscript).trim();
    if (!text) { this.send({ type: 'error', message: 'Nothing to clean — say something first.' }); return; }
    this.send({ type: 'elaborating' });
    this._originalBufferBeforeEnhance = text;
    try {
      const cleaner = new PromptCleaner(this.ollama());
      const { cleaned, usedLLM } = await cleaner.clean(text);
      this.log.appendLine(`[VTP] Clean+review ${usedLLM ? '(regex+Ollama)' : '(regex)'} — ${text.length}→${cleaned.length} chars.`);
      this.promptBuffer = cleaned;
      this._lastCleanedSnapshot = cleaned;
      this.interimTranscript = '';
      this._awaitingEnhancementDecision = true;
      this.send({ type: 'elaborated', prompt: cleaned, original: text });
      void this.startRecording();
    } catch (err) {
      this._awaitingEnhancementDecision = false;
      this.send({ type: 'error', message: `Cleanup failed: ${this.formatError(err)}` });
    }
  }

  private async cleanAndApply(): Promise<void> {
    const text = (this.promptBuffer || this.interimTranscript).trim();
    if (!text) return;
    try {
      const cleaner = new PromptCleaner(this.ollama());
      const { cleaned, usedLLM } = await cleaner.clean(text);
      this.log.appendLine(`[VTP] Clean ${usedLLM ? '(regex+Ollama)' : '(regex)'} — "${cleaned}"`);
      this.promptBuffer = cleaned;
      this._lastCleanedSnapshot = cleaned;
      this.interimTranscript = '';
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
      // Resume listening after a silent clean.
      const cfg = vscode.workspace.getConfiguration('vtp');
      if (cfg.get<string>('activationMode', 'wake') === 'wake') this.startWakeMonitor('idle');
    } catch (err) {
      this.send({ type: 'error', message: 'Cleanup failed — buffer unchanged.' });
    }
  }

  // ── onFinalTranscript — the heavy decision logic ────────────────────────────

  private async onFinalTranscript(segment: string): Promise<void> {
    if (this._awaitingEnhancementDecision) {
      const lc = segment.toLowerCase();
      if (ENHANCE_APPROVE.test(lc)) { await this.handleEnhancementDecision('approve'); return; }
      if (ENHANCE_REJECT.test(lc))  { await this.handleEnhancementDecision('reject'); return; }
      if (ENHANCE_REGEN.test(lc))   { await this.handleEnhancementDecision('regenerate'); return; }
      this.send({ type: 'awaitingDecision' });
      return;
    }

    if (PAUSE_CMD.test(segment)) {
      const prePause = segment.replace(PAUSE_CMD, '').replace(/\s{2,}/g, ' ').trim();
      if (prePause) {
        this.promptBuffer += (this.promptBuffer ? ' ' : '') + prePause;
        this.send({ type: 'transcriptResult', text: this.promptBuffer });
      }
      this._enterPause();
      return;
    }

    if (CLEAR_FINAL_CMD.test(segment)) {
      this.promptBuffer = '';
      this.interimTranscript = '';
      this.send({ type: 'transcriptResult', text: '' });
      return;
    }

    if (CLEAN_REVIEW_CMD.test(segment)) { await this.cleanAndReview(); return; }
    if (CLEAN_CMD.test(segment)) { await this.cleanAndApply(); return; }

    if (this._sendTriggerFired) {
      const content = stripSendTrigger(segment);
      if (content) { this.promptBuffer += (this.promptBuffer ? ' ' : '') + content; }
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
      await this.elaborateAndShow();
      return;
    }

    const segmentCleaned = stripFiller(segment);

    if (!this._sendTriggerFired && hasSendTrigger(segment.slice(-120))) {
      this._sendTriggerFired = true;
      const tailCleaned = stripSendTrigger(segment);
      if (tailCleaned) { this.promptBuffer += (this.promptBuffer ? ' ' : '') + tailCleaned; }
      if (!this.promptBuffer.trim()) {
        this.send({ type: 'error', message: 'Nothing to send — say something first.' });
      } else {
        await this.injectRaw();
        void this._postSendFlow();
      }
      return;
    }

    // Plain dictation — append verbatim.
    if (!SEND_TRIGGER.test(segment) && !SEND_TRIGGER.test(segmentCleaned) && !ACTION_TRIGGER.test(segment)) {
      this.promptBuffer += (this.promptBuffer ? ' ' : '') + segment;
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
      return;
    }

    // Ambiguous — classify locally.
    this.ensurePipeline();
    const context = this.cachedContext ?? await this.contextCollector.collect();
    try {
      const result = await this.intentProcessor!.classify(segment, this.promptBuffer, context);
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
        case 'SEND':
          if (result.content) { this.promptBuffer += (this.promptBuffer ? ' ' : '') + result.content; }
          if (!this.promptBuffer.trim()) {
            this.send({ type: 'error', message: 'Nothing to send — say something first.' });
          } else {
            await this.injectRaw();
            void this._postSendFlow();
          }
          break;
        case 'CANCEL':
          this.promptBuffer = '';
          this.interimTranscript = '';
          this.send({ type: 'transcriptResult', text: '' });
          break;
      }
    } catch (err) {
      if (segment.trim()) {
        this.promptBuffer += (this.promptBuffer ? ' ' : '') + segment.trim();
        this.send({ type: 'transcriptResult', text: this.promptBuffer });
      }
    }
  }

  // ── Injection ───────────────────────────────────────────────────────────────

  private async onSend(prompt: string): Promise<void> {
    const finalPrompt = await this.maybeAutoClean(prompt);
    this.log.appendLine(`[VTP] Manual send — injecting (${finalPrompt.length} chars).`);
    await this.chatInjector.inject(finalPrompt);
    this.promptBuffer = '';
    this._lastCleanedSnapshot = null;
    this.send({ type: 'injected' });
    this._lockedConversationId = null;
  }

  private async injectRaw(): Promise<void> {
    const finalPrompt = await this.maybeAutoClean(this.promptBuffer.trim());
    this.log.appendLine(`[VTP] Injecting buffer (${finalPrompt.length} chars).`);
    await this.chatInjector.inject(finalPrompt);
    this.promptBuffer = '';
    this.interimTranscript = '';
    this._lastCleanedSnapshot = null;
    this.send({ type: 'injected' });
    this._lockedConversationId = null;
  }

  private async maybeAutoClean(prompt: string): Promise<string> {
    if (!prompt) return prompt;
    if (this._lastCleanedSnapshot !== null && this._lastCleanedSnapshot === this.promptBuffer) {
      return prompt;
    }
    const cleaner = new PromptCleaner(this.ollama());
    const { cleaned, usedLLM } = await cleaner.clean(prompt);
    if (cleaned !== prompt) {
      this.log.appendLine(`[VTP] Auto-clean ${usedLLM ? '(regex+Ollama)' : '(regex)'} — ${prompt.length}→${cleaned.length} chars.`);
    }
    return cleaned;
  }

  // ── Enhancement ─────────────────────────────────────────────────────────────

  private async elaborateAndShow(): Promise<void> {
    if (!this.promptBuffer.trim()) {
      this.send({ type: 'error', message: 'Nothing to enhance — say something first.' });
      return;
    }
    this.ensurePipeline();
    this.send({ type: 'elaborating' });
    this._originalBufferBeforeEnhance = this.promptBuffer;
    try {
      const context = await this.contextCollector.collect();
      const conversation = this.getEffectiveConversation();
      const elaborated = await this.promptElaborator!.elaborate(this.promptBuffer, context, conversation);
      this.promptBuffer = elaborated;
      this._lastCleanedSnapshot = elaborated;
      this._awaitingEnhancementDecision = true;
      this.send({ type: 'elaborated', prompt: elaborated, original: this._originalBufferBeforeEnhance });
      void this.startRecording();
    } catch (err) {
      this._awaitingEnhancementDecision = false;
      if (err instanceof NoLocalModelError) {
        // Graceful local fallback: keep the (regex-cleaned) buffer, tell the user.
        this.send({ type: 'error', message: err.message });
        this.send({ type: 'transcriptResult', text: this.promptBuffer });
      } else {
        this.send({ type: 'error', message: this.formatError(err) });
      }
    }
  }

  private async handleEnhancementDecision(action: 'approve' | 'reject' | 'regenerate'): Promise<void> {
    this._awaitingEnhancementDecision = false;
    this.interimTranscript = '';
    if (action === 'approve') {
      this.send({ type: 'enhancedApproved' });
      void this.startRecording();
    } else if (action === 'reject') {
      this.promptBuffer = this._originalBufferBeforeEnhance;
      this.send({ type: 'enhancedRejected', original: this._originalBufferBeforeEnhance });
      void this.startRecording();
    } else {
      this.promptBuffer = this._originalBufferBeforeEnhance;
      await this.elaborateAndShow();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private refreshContext(): void {
    if (this.isRecording || this.isPaused) return;
    Promise.all([
      this.contextCollector.collect(),
      this.conversationMatcher.findBestMatch(),
    ]).then(([context, conversation]) => {
      const newTitle = conversation?.title ?? 'none';
      const prevTitle = this.cachedConversation?.title ?? 'none';
      const prevWorkspace = this.cachedContext?.workspaceName ?? '';
      const changed = newTitle !== prevTitle || context.workspaceName !== prevWorkspace;
      this.cachedContext = context;
      this.cachedConversation = conversation;
      if (conversation?.id && !this._lockedConversationId) {
        this._lockedConversationId = conversation.id;
      }
      if (changed) {
        const shortTitle = newTitle.length > 60 ? newTitle.slice(0, 57) + '...' : newTitle;
        this.send({
          type: 'contextUpdate',
          workspaceName: context.workspaceName,
          conversationTitle: shortTitle,
          pinned: this._extraConversations.length > 0,
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
    const primaryTitle = this.cachedConversation?.title ?? 'none';
    const shortTitle = primaryTitle.length > 60 ? primaryTitle.slice(0, 57) + '...' : primaryTitle;
    this.send({
      type: 'contextUpdate',
      workspaceName: this.cachedContext?.workspaceName ?? '',
      conversationTitle: shortTitle,
      pinned: newExtras.length > 0,
      extrasCount: newExtras.length,
    });
  }

  private ensurePipeline(): void {
    const model = vscode.workspace.getConfiguration('vtp').get<string>('enhancementModel', 'llama3.2');
    if (!this.intentProcessor) this.intentProcessor = new IntentProcessor();
    if (!this.commandExecutor) this.commandExecutor = new CommandExecutor(this.commandRegistry.getCommands());
    if (!this.promptElaborator) this.promptElaborator = new PromptElaborator(model);
  }

  private send(msg: ExtensionMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    const hookUri   = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'workerHook.js'));
    const voskUri   = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vendor', 'vosk.js'));
    const captureUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'voskCapture.js'));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'));
    const nonce = this.nonce();
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'panel.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');
    return html
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{cspNonce\}\}/g, nonce)
      .replace('{{styleUri}}', styleUri.toString())
      .replace('{{hookUri}}', hookUri.toString())
      .replace('{{voskUri}}', voskUri.toString())
      .replace('{{captureUri}}', captureUri.toString())
      .replace('{{scriptUri}}', scriptUri.toString());
  }

  private nonce(): string {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => c[Math.floor(Math.random() * c.length)]).join('');
  }

  public toggleRecording(): void {
    if (this.isRecording) {
      void this.stopRecording();
    } else if (this.isPaused) {
      void this.resumeRecording();
    } else {
      void this.startRecording();
    }
  }

  dispose(): void {
    this._cancelMicTest();
    this.micStop();
    this._stopMeter();
    this.mic.kill();
    this.stopWakeMonitor();
    this.commandRegistry.dispose();
  }
}
