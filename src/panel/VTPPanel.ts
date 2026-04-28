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

  private ffmpegReady       = false;
  private isPaused           = false;
  private justResumed        = false;
  private interimTranscript  = '';
  private _chunkQueue: Promise<void> = Promise.resolve();
  private _sendTriggerFired  = false;
  private _restartAfterSend  = false;
  private _vadStop           = false;  // true when stop was triggered by VAD silence
  private _stopping          = false;  // guard against concurrent stopRecording calls
  /** Set when a send/pause command is detected mid-stream — skips remaining in-flight chunks. */
  private _cancelChunks      = false;

  /** True while waiting for the user to approve / reject / regenerate an enhancement. */
  private _awaitingEnhancementDecision = false;
  /** The original promptBuffer content saved before elaboration runs. */
  private _originalBufferBeforeEnhance = '';

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
      case 'speechInterim':
        // Webview renders its own interim display in real-time.
        // Extension host does not need to act — ignore to avoid promptBuffer interference.
        break;
      case 'speechFinal': {
        // One completed utterance from Web Speech API.
        // Pass the segment to onFinalTranscript which will append it to promptBuffer
        // and handle commands (pause, send, cancel, etc.).
        const seg = msg.segment?.trim();
        if (seg) {
          this.log.appendLine(`[VTP] WSA final: "${seg}"`);
          await this.onFinalTranscript(seg);
        }
        break;
      }
      case 'cancel':
        this._awaitingEnhancementDecision = false;
        this.promptBuffer      = '';
        this.interimTranscript = '';
        this.send({ type: 'transcriptResult', text: '' });
        this.log.appendLine('[VTP] Buffer cleared.');
        break;
      case 'enhancementDecision':
        await this.handleEnhancementDecision(msg.action);
        break;
      case 'openSettings':        await this.handleOpenSettings(); break;
      case 'showInfo':            await this.showApiKeyInfo(); break;
      case 'micPermissionDenied': this.handleMicDenied(); break;
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

      // ── Reset state for new session ─────────────────────────────────────────
      this.isPaused           = false;
      this._stopping          = false;
      this.interimTranscript  = '';
      this._chunkQueue        = Promise.resolve();
      this._sendTriggerFired  = false;
      this._restartAfterSend  = false;
      this._vadStop           = false;
      this._cancelChunks      = false;

      // ── Wire chunk callbacks ────────────────────────────────────────────────
      this.capture.onChunkReady = (chunk) => {
        if (this._cancelChunks) return;
        this._chunkQueue = this._chunkQueue.then(
          () => this.processLiveChunk(chunk.buffer, chunk.mimeType),
        );
      };

      this.capture.onChunkSkipped = () => {
        this.log.appendLine('[VTP] Chunk skipped — audio too quiet (check mic volume).');
      };

      // ── VAD: auto-stop when user has been silent for d=5s ──────────────────
      // onSilenceStart fires when FFmpeg detects silence_start (user stopped talking).
      this.capture.onSilenceStart = () => {
        if (this.isPaused || this._stopping || !this.capture.isRecording()) return;
        this.log.appendLine('[VTP] VAD: silence detected — auto-stopping.');
        this._vadStop = true;
        void this.stopRecording();
      };

      // onSilenceDetected fires on silence_END (user starts talking) — not used here.
      this.capture.onSilenceDetected = null;

      this.capture.onExtendedSilence = null; // _extendedSilenceTimer still arms internally

      this.capture.onFfmpegLog = (line) => {
        if (/error|warning|cannot|failed|invalid|no such|unable|permission/i.test(line) &&
            !/^\s*(frame|fps|size|time|bitrate|speed|Stream|encoder|Press)/.test(line)) {
          this.log.appendLine(`[VTP] FFmpeg: ${line}`);
        }
      };

      await this.capture.startChunked();
      this.send({ type: 'recordingStarted' });
      this.log.appendLine('[VTP] Recording started (chunked mode — live transcript active).');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[VTP] Failed to start recording: ${msg}`);
      this.send({ type: 'error', message: `Mic error: ${msg}` });
    }
  }

  private async stopRecording(): Promise<void> {
    if (this._stopping || !this.capture.isRecording()) {
      this.send({ type: 'recordingStopped' });
      return;
    }
    this._stopping = true;
    this.log.appendLine('[VTP] Stopping recording...');
    this.send({ type: 'recordingStopped' });

    try {
      // Stop chunked FFmpeg and flush remaining segment files.
      await this.capture.stopChunked();
      // Wait for all queued Gemini transcription calls to finish.
      await this._chunkQueue;

      const finalText = this.interimTranscript.trim();
      this.interimTranscript = '';
      const hasSpeech = finalText.length > 0;

      if (hasSpeech) {
        this.log.appendLine(`[VTP] Final transcript (${finalText.length} chars): "${finalText}"`);
        await this.onFinalTranscript(finalText);
      }

      // ── VAD restart / auto-pause logic ─────────────────────────────────────
      if (this._vadStop && !this._restartAfterSend) {
        this._vadStop = false;
        if (!hasSpeech) {
          this.log.appendLine('[VTP] No speech detected.');
          this.log.appendLine('[VTP] VAD stop with no speech — entering auto-pause.');
          this.isPaused = true;
          this.send({ type: 'autoPaused' });
          this.log.appendLine('[VTP] Wake monitor: say "resume", "continue", or "I\'m back"...');
          void this.checkForWakePhrase();
        } else if (!this.isPaused) {
          this.log.appendLine('[VTP] VAD stop — restarting for continuous listening.');
          void this.startRecording();
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
    this.log.appendLine('[VTP] Resumed — restarting to re-wire VAD callbacks.');
    if (this.capture.isRecording()) {
      await this.capture.stopChunked();
    }
    await this.startRecording();
    this.send({ type: 'resumed' });
  }

  /**
   * Wake-phrase monitor loop (runs when isPaused=true).
   *
   * WHY fixed 5s window instead of silence detection:
   * DirectShow on Windows takes 1–2s to initialise. With silence-detection,
   * the user says "resume" during FFmpeg's init window → we capture silence.
   * 5s window gives FFmpeg ~1.5s to init and still leaves ~3.5s of real capture.
   */
  private async checkForWakePhrase(): Promise<void> {
    // ── Preserve transcript before stopping ──────────────────────────────────
    const savedTranscript = this.interimTranscript
      .replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();
    if (savedTranscript) {
      this.promptBuffer += (this.promptBuffer ? ' ' : '') + savedTranscript;
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
      this.log.appendLine(`[VTP] Saved to buffer before pause: "${savedTranscript}"`);
    }
    this.interimTranscript = '';

    // ── Stop chunked recording before entering single-file wake monitor ───────
    this.capture.onChunkReady = null;
    await this._chunkQueue;
    await this.capture.stopChunked();

    if (!this.isPaused) return;

    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) return;

    // Detach VAD callbacks — the wake monitor wires its own below.
    this.capture.onSilenceDetected = null;
    this.capture.onExtendedSilence = null;

    this.log.appendLine('[VTP] Wake monitor: say "resume", "continue", or "I\'m back"...');

    while (this.isPaused) {
      try {
        // ── Wait for speech using FFmpeg silencedetect ─────────────────────────
        // onSilenceDetected fires on silence_END = the moment the user starts
        // speaking.  We never call Gemini if the mic stays silent/muted.
        let speechDetectedResolve!: () => void;
        const speechDetected = new Promise<void>((r) => { speechDetectedResolve = r; });

        await this.capture.start();           // single-file mode with silencedetect
        await new Promise<void>((r) => setTimeout(r, 300)); // DirectShow init
        if (!this.isPaused) { await this.capture.stop(); break; }

        this.capture.onSilenceDetected = () => speechDetectedResolve();
        this.log.appendLine('[VTP] Wake monitor: waiting for speech...');
        this.send({ type: 'wakeReady' });

        // Block until speech OR 30s timeout (then cycle FFmpeg to avoid staleness)
        await Promise.race([
          speechDetected,
          new Promise<void>((r) => setTimeout(r, 30_000)),
        ]);

        if (!this.isPaused) { await this.capture.stop(); break; }

        // Give the user 1.5s to finish the full phrase before stopping.
        await new Promise<void>((r) => setTimeout(r, 1500));
        const result = await this.capture.stop();
        this.capture.onSilenceDetected = null;

        if (!result) continue;

        // ── Energy gate ────────────────────────────────────────────────────────
        if (!this._hasVoiceEnergy(result.buffer)) continue;

        // ── Transcribe with Gemini ──────────────────────────────────────────────
        const base64 = result.buffer.toString('base64');
        const genai  = new GoogleGenerativeAI(apiKey);

        const WAKE_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
        let wakeRaw = '';
        for (const modelName of WAKE_MODELS) {
          try {
            const model = genai.getGenerativeModel({
              model: modelName,
              systemInstruction:
                'Transcribe the audio exactly as spoken. Output ONLY the spoken words. If there is no speech at all, output exactly: [SILENCE]',
              generationConfig: { temperature: 0 },
            });
            const res = await model.generateContent([
              { inlineData: { mimeType: result.mimeType, data: base64 } },
              'Transcribe the audio.',
            ]);
            wakeRaw = res.response.text().trim();
            break;
          } catch (e) {
            const s = String(e);
            if (s.includes('503') || s.includes('500') || s.includes('404') ||
                s.includes('overloaded') || s.includes('high demand') ||
                s.includes('Internal error') || s.includes('Service Unavailable') ||
                s.includes('no longer available')) {
              continue;
            }
            throw e;
          }
        }
        const clean = this.sanitizeTranscription(wakeRaw);
        if (!clean) continue;
        const text = clean.toLowerCase();
        this.log.appendLine(`[VTP] Wake monitor heard: "${text}"`);

        if (/\b(resume|continue|start|wake up|keep going|i'?m back|listen|go|activate|hey vtp)\b/.test(text)) {
          this.log.appendLine('[VTP] Wake phrase matched — resuming.');
          this.isPaused    = false;
          this.justResumed = true;
          this.send({ type: 'resumed' });

          // ── Compound command: "resume and send the prompt" ──────────────────
          // If the same utterance also contains a send trigger, inject the
          // buffer immediately without waiting for new dictation.
          const hasSendInWake = this._hasSendTrigger(text);
          await this.startRecording();
          if (hasSendInWake && this.promptBuffer.trim()) {
            this.log.appendLine('[VTP] Wake+send compound — injecting buffer immediately.');
            await this.injectRaw();
          }
          return;
        }
      } catch (err) {
        this.log.appendLine(`[VTP] Wake monitor error: ${this.formatError(err)}`);
        this.capture.kill(); // ensure no orphaned proc before next loop iteration
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }


  // ─── Transcription ────────────────────────────────────────────────────────

  /**
   * Returns true only if the WAV buffer contains audio energy above the voice threshold.
   * Prevents sending silent/noisy chunks to Gemini, which would cause hallucination.
   * WAV PCM is 16-bit LE starting at byte 44. Threshold ~800 on a 0–32767 scale.
   */
  private _hasVoiceEnergy(buf: Buffer, threshold = 800): boolean {
    const PCM_OFFSET = 44; // standard WAV header size
    if (buf.length <= PCM_OFFSET + 2) return false;
    let sumSq = 0;
    let count = 0;
    for (let i = PCM_OFFSET; i + 1 < buf.length; i += 2) {
      const sample = buf.readInt16LE(i);
      sumSq += sample * sample;
      count++;
    }
    if (count === 0) return false;
    const rms = Math.sqrt(sumSq / count);
    return rms >= threshold;
  }

  /**
   * Transcribes a single 3-second audio chunk and appends it to interimTranscript.
   * Called serially via _chunkQueue so ordering is preserved.
   */
  private async processLiveChunk(buffer: Buffer, mimeType: string): Promise<void> {
    // ── Early-exit guards ────────────────────────────────────────────────────
    // _cancelChunks is set when a send/pause command fires mid-stream so that
    // already-queued Gemini calls return immediately without touching state.
    if (this._cancelChunks) return;
    if (buffer.length < 4096) return; // too small — partial/empty segment

    // ── Local energy gate ─────────────────────────────────────────────────────
    // Check PCM RMS BEFORE calling Gemini. If the chunk is quiet (background
    // noise, silence, fan, etc.) Gemini will hallucinate developer content
    // instead of outputting [SILENCE]. Gating locally is instant and free.
    if (!this._hasVoiceEnergy(buffer)) {
      return; // silent chunk — discard without API call
    }
    // ──────────────────────────────────────────────────────────────────────────

    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) return;

    try {
      const base64 = buffer.toString('base64');
      const genai  = new GoogleGenerativeAI(apiKey);
      const sysInstruction =
        'You are transcribing audio from a software developer dictating code requirements. ' +
        'Transcribe ONLY clearly audible spoken words exactly as heard. ' +
        'Preserve technical terms, framework names, and developer jargon verbatim. ' +
        'IMPORTANT: If the audio is quiet, noisy, unclear, or you cannot make out distinct words, ' +
        'you MUST output exactly: [SILENCE] — never guess or generate plausible content.';

      // Cascade: 2 active stable models as of April 2026.
      // 2.0-flash + 1.5-flash are deprecated/removed. 2.5-flash → 2.5-flash-lite.
      const CHUNK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
      let raw: string | null = null;
      for (const modelName of CHUNK_MODELS) {
        try {
          const model = genai.getGenerativeModel({
            model: modelName,
            systemInstruction: sysInstruction,
            generationConfig: { temperature: 0 }, // suppress hallucination on quiet/background audio
          });
          const res = await model.generateContent([
            { inlineData: { mimeType, data: base64 } },
            'Transcribe the audio.',
          ]);
          raw = res.response.text().trim();
          break;
        } catch (e) {
          const s = String(e);
          if (s.includes('503') || s.includes('500') || s.includes('404') ||
              s.includes('overloaded') || s.includes('high demand') ||
              s.includes('Internal error') || s.includes('Service Unavailable') ||
              s.includes('no longer available')) {
            continue; // try next model immediately
          }
          throw e;
        }
      }

      // Re-check after async Gemini call — a send/pause may have fired while we waited.
      if (this._cancelChunks) return;

      if (raw === null) {
        this.log.appendLine('[VTP] All models busy — chunk skipped.');
        return;
      }

      const text = this.sanitizeTranscription(raw);
      if (!text || /^\[\s*SILENCE\s*\]$/i.test(text)) return;

      // ── Real-time pause detection ────────────────────────────────────────────
      // Only fire if the entire chunk IS a pause command.
      // IMPORTANT: do NOT set _cancelChunks on pause — let all already-queued
      // chunks finish transcribing so the user's full 5 sentences are captured
      // before the pause takes effect.
      const PAUSE_CMD = /^[\s.,!?]*(pause(\s+(vtp|recording|listening))?|stop\s+listening)[\s.,!?]*$/i;
      if (PAUSE_CMD.test(text)) {
        this.log.appendLine('[VTP] Live chunk: "pause" detected — pausing after queue drains.');
        // Do NOT set _cancelChunks. Let all previously-queued chunks finish.
        // Queue the pause itself at the END so it runs after every earlier chunk.
        this._chunkQueue = this._chunkQueue.then(() => {
          this.interimTranscript = ''; // discard only the "pause" word
          this.send({ type: 'transcriptResult', text: this.promptBuffer });
          this.isPaused = true;
          this.send({ type: 'paused' });
          void this.checkForWakePhrase();
        });
        return;
      }
      // ────────────────────────────────────────────────────────────────────────

      this.interimTranscript = this.interimTranscript
        ? this.interimTranscript + ' ' + text
        : text;

      // Show rolling live text — always prepend the accumulated buffer so the
      // display doesn't reset when VAD stops and restarts mid-dictation.
      const displayText = this.promptBuffer
        ? this.promptBuffer + ' ' + this.interimTranscript
        : this.interimTranscript;
      this.send({ type: 'transcriptResult', text: displayText });
      this.log.appendLine(`[VTP] Live chunk: "${text}"`);

      // Detect send trigger in accumulated text — auto-stop without user clicking
      if (!this._sendTriggerFired && this._hasSendTrigger(this.interimTranscript)) {
        this._sendTriggerFired = true;
        this._restartAfterSend = true;
        // Cancel remaining queued chunks immediately — stopRecording's await
        // _chunkQueue will resolve instantly instead of waiting for stale API calls.
        this._cancelChunks = true;
        this.log.appendLine('[VTP] Send trigger detected — auto-stopping for send.');
        this.send({ type: 'vadAutoStop' });
        void this.stopRecording();
      }
    } catch (err) {
      this.log.appendLine(`[VTP] Chunk transcription error: ${this.formatError(err)}`);
    }
  }

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
   * Strips sound annotations and leaked system prompt text from a Gemini
   * transcription response.
   *
   * Gemini uses [brackets] ONLY for non-speech content:
   *   [ chewing ]  [ RATTLE ]  [SOUND]  [SILENCE]  [ 0m0s ]  [NO SPEECH]
   * Real spoken words are NEVER inside brackets, so we strip ALL [...] tokens.
   */
  private sanitizeTranscription(raw: string): string {
    const LEAK_MARKERS = [
      'Transcribe this audio exactly as spoken',
      'Output only the transcription',
      'If no speech, output an empty string',
      'You are a transcription service',
      'Transcribe the audio.',
      'transcribe the audio',  // lowercase variant Gemini sometimes returns
    ];
    let text = raw.trim();
    // Strip ALL [bracketed] non-speech annotations in one pass
    text = text.replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();
    // Strip leaked system-prompt text (case-insensitive search)
    for (const marker of LEAK_MARKERS) {
      const lower = text.toLowerCase();
      const idx = lower.indexOf(marker.toLowerCase());
      if (idx > -1) {
        text = text.substring(0, idx).trim().replace(/[.,!?]+$/, '').trim();
      }
    }
    return text;
  }

  // ─── Intent processing ────────────────────────────────────────────────────

  private async onFinalTranscript(segment: string): Promise<void> {
    // ── Enhancement review intercept — voice approve / reject / regenerate ──
    if (this._awaitingEnhancementDecision) {
      const lc = segment.toLowerCase();
      if (/\b(approve|accept|looks? good|yes|use it|perfect|great|send it|keep it|apply)\b/.test(lc)) {
        this.log.appendLine('[VTP] Voice command: approve enhancement.');
        await this.handleEnhancementDecision('approve');
        return;
      }
      if (/\b(reject|revert|no|go back|undo|restore|cancel|discard|original)\b/.test(lc)) {
        this.log.appendLine('[VTP] Voice command: reject enhancement.');
        await this.handleEnhancementDecision('reject');
        return;
      }
      if (/\b(regenerate|try again|redo|new version|another|different|again)\b/.test(lc)) {
        this.log.appendLine('[VTP] Voice command: regenerate enhancement.');
        await this.handleEnhancementDecision('regenerate');
        return;
      }
      // Fall through — user said something unrelated, append to buffer
    }

    // ── Local voice commands (no Gemini needed) ────────────────────────────
    // Pause is only triggered when the utterance IS the command — not when the
    // word "pause" appears inside a longer dictation sentence.
    const PAUSE_CMD = /^[\s.,!?]*(pause(\s+(recording|vtp|listening))?|stop\s+listening)[\s.,!?]*$/i;
    if (PAUSE_CMD.test(segment)) {
      this.log.appendLine('[VTP] Voice command: pause.');
      this._vadStop = false; // prevent stopRecording() from auto-restarting after this return
      this.pauseRecording();
      void this.checkForWakePhrase();
      return;
    }

    // "Clear transcript", "clear the buffer", "clear that", "reset transcript", "start over"
    if (/\b(clear(\s+the)?\s+(transcript|buffer|prompt)|clear\s+that|reset(\s+the)?\s+(transcript|buffer|prompt)|start\s+over)\b/i.test(segment)) {
      this.promptBuffer   = '';
      this.interimTranscript = '';
      this.send({ type: 'transcriptResult', text: '' });
      this.log.appendLine('[VTP] Voice command: clear transcript.');
      return;
    }

    // ── Fast-path: send trigger already confirmed by local regex ─────────────
    // _sendTriggerFired was set during live-chunk processing.  We already know
    // the intent — no need to ask Gemini (avoids 30s of 503 retries).
    if (this._sendTriggerFired) {
      const content = this.stripSendTrigger(segment);
      if (content) {
        this.promptBuffer += (this.promptBuffer ? ' ' : '') + content;
      }
      this.log.appendLine('[VTP] SEND (local trigger — Gemini bypassed).');
      if (!this.promptBuffer.trim()) {
        this.send({ type: 'error', message: 'Nothing to send — say something first.' });
      } else {
        await this.injectRaw();
      }
      // Always restart for continuous listening after a triggered send.
      this.log.appendLine('[VTP] Restarting mic after send.');
      void this.startRecording();
      return;
    }

    // ── Fast path: plain dictation (no action keywords) ─────────────────────
    // Only call Gemini when text contains an explicit VTP action trigger.
    const SEND_TRIGGER   = /\b(send it|send this|send the prompt|send this prompt|send my prompt|send now|submit this|submit the prompt)\b[.,!?\s]*$/i;
    const ACTION_TRIGGER = /\b(enhance (this|my|the) prompt|rewrite (this|my|the) prompt|improve (this|my|the) prompt|cancel( that)?|clear( that)?|open the terminal|run (the )?tests|hey vtp)\b/i;

    if (!SEND_TRIGGER.test(segment) && !ACTION_TRIGGER.test(segment)) {
      this.promptBuffer += (this.promptBuffer ? ' ' : '') + segment;
      this.send({ type: 'transcriptResult', text: this.promptBuffer });
      this.log.appendLine('[VTP] Plain dictation — added to buffer verbatim (no classification).');
      return;
    }

    // ── Gemini classification for action-trigger utterances ──────────────────
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
          // Always use the raw segment verbatim — classifier must not rewrite the user's words.
          // result.content is intentionally ignored here.
          this.promptBuffer += (this.promptBuffer ? ' ' : '') + segment;
          this.send({ type: 'transcriptResult', text: this.promptBuffer });
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
            // If auto-triggered by voice send-command in continuous mode, restart immediately
            if (this._restartAfterSend) {
              this._restartAfterSend = false;
              this.log.appendLine('[VTP] Continuous mode — restarting for next prompt.');
              void this.startRecording();
            }
          }
          break;
        }

        case 'CANCEL':
          this.promptBuffer      = '';
          this.interimTranscript = '';
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
    this.promptBuffer      = '';
    this.interimTranscript = ''; // prevent old transcript ghosting back into UI after send
    this.send({ type: 'injected' });
  }

  /**
   * Returns true if the text contains a voice "send" command.
   * Used for real-time detection during live chunk transcription.
   */
  private _hasSendTrigger(text: string): boolean {
    // Anchored to end-of-utterance: prevents mid-sentence matches like
    // "we'll send the prompt from here" (has words after the trigger phrase).
    return /\b(send it|send the prompt|send this prompt|send my prompt|send this|send that|submit this|go ahead and send|ok send|okay send|go send|please send|just send|send message|send now|submit now)\b[.,!?\s]*$/i.test(text);
  }

  /**
   * Strips common "send" trigger phrases from a segment so the remaining
   * content can be used as the prompt when buffer is empty.
   * e.g. "This is a test. Send the prompt." → "This is a test."
   */
  private stripSendTrigger(segment: string): string {
    const triggers = [
      'send the prompt', 'send this prompt', 'send my prompt',
      'send it', 'ok send', 'okay send',
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

    // Save original BEFORE elaboration so reject/regenerate can restore it.
    this._originalBufferBeforeEnhance = this.promptBuffer;

    try {
      const [context, conversation] = await Promise.all([
        this.contextCollector.collect(),
        this.cachedConversation ?? this.conversationMatcher.findBestMatch(),
      ]);

      const elaborated = await this.withRetry(() =>
        this.promptElaborator!.elaborate(this.promptBuffer, context, conversation),
      );

      this.promptBuffer = elaborated;
      this._awaitingEnhancementDecision = true;
      this.send({ type: 'elaborated', prompt: elaborated, original: this._originalBufferBeforeEnhance });
    } catch (err) {
      this._awaitingEnhancementDecision = false;
      const msg = this.formatError(err);
      this.send({ type: 'error', message: msg });
    }
  }

  /** Handle approve / reject / regenerate from panel buttons or voice */
  private async handleEnhancementDecision(action: 'approve' | 'reject' | 'regenerate'): Promise<void> {
    this._awaitingEnhancementDecision = false;

    if (action === 'approve') {
      // promptBuffer already has enhanced text — nothing to do on host side.
      this.log.appendLine('[VTP] Enhancement approved.');
      this.send({ type: 'enhancedApproved' });

    } else if (action === 'reject') {
      // Restore the original buffer.
      this.promptBuffer = this._originalBufferBeforeEnhance;
      this.log.appendLine('[VTP] Enhancement rejected — original restored.');
      this.send({ type: 'enhancedRejected', original: this._originalBufferBeforeEnhance });

    } else if (action === 'regenerate') {
      // Restore original, then re-run elaboration from scratch.
      this.promptBuffer = this._originalBufferBeforeEnhance;
      this.log.appendLine('[VTP] Enhancement regenerate — re-elaborating original.');
      await this.elaborateAndShow();
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

  private handleMicDenied(): void {
    // In chunked mode, FFmpeg is already the primary mic source.
    // micPermissionDenied from the webview is expected and harmless — ignore.
    this.log.appendLine('[VTP] Webview mic denied — FFmpeg is active (expected).');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

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
            const m = msg.match(/retryDelay['":\s]+(\d+)s/);
            wait = m ? parseInt(m[1], 10) : 30;
            this.log.appendLine(`[VTP] Rate limited — retrying in ${wait}s (${attempt}/${maxRetries})`);
            this.send({ type: 'error', message: `Rate limited — retrying in ${wait}s…` });
          } else {
            wait = attempt * 5; // 5s, 10s, 15s — short ramp for transient overload
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
