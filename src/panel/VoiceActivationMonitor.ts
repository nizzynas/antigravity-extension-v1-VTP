/**
 * VoiceActivationMonitor — background wake-phrase listener.
 *
 * Architecture (engine-aware):
 *   - Deepgram mode: stream PCM from FFmpeg → Deepgram WebSocket → match phrase
 *     on every interim/final result.  ~100ms reaction latency.
 *   - Gemini mode:  capture 1.5s chunks → Gemini batch transcribe → match phrase.
 *     ~2-3s per cycle.  Used as fallback when no Deepgram key is present.
 *
 * Usage:
 *   const monitor = new VoiceActivationMonitor(secretManager, logger);
 *   monitor.start('hey antigravity', 'deepgram', () => panel.startRecording());
 *   // ...later:
 *   monitor.stop();
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { AudioCapture } from '../audio/AudioCapture';
import { DeepgramTranscriber } from '../audio/DeepgramTranscriber';
import { hasVoiceEnergy, sanitizeTranscription } from './CommandDetector';
import { SecretManager } from '../config/SecretManager';

export class VoiceActivationMonitor {
  private _running   = false;
  private _capture   = new AudioCapture();
  private _loopAbort = false;
  private _dg: DeepgramTranscriber | null = null;

  constructor(
    private readonly secretManager: SecretManager,
    private readonly log: (msg: string) => void,
  ) {}

  /** Returns true if the monitor loop is currently active. */
  isActive(): boolean { return this._running; }

  /**
   * Start listening for the given wake phrase.
   * Safe to call multiple times — subsequent calls are no-ops if already running.
   */
  start(wakePhrase: string, engine: 'deepgram' | 'gemini', onWake: () => void): void {
    if (this._running) return;
    this._running   = true;
    this._loopAbort = false;
    this.log(`[VAM] Voice activation started. Listening for: "${wakePhrase}"`);
    if (engine === 'deepgram') {
      void this._loopDeepgram(wakePhrase.toLowerCase().trim(), onWake);
    } else {
      void this._loopGemini(wakePhrase.toLowerCase().trim(), onWake);
    }
  }

  /** Stop the monitor. The current capture window will finish before the loop exits. */
  stop(): void {
    if (!this._running) return;
    this._loopAbort = true;
    this._running   = false;
    this._dg?.disconnect();
    this._dg = null;
    this._capture.kill();
    this.log('[VAM] Voice activation stopped.');
  }

  // ─── Deepgram streaming loop ────────────────────────────────────────────────

  private async _loopDeepgram(phrase: string, onWake: () => void): Promise<void> {
    const ffmpegOk = await AudioCapture.isAvailable();
    if (!ffmpegOk) {
      this.log('[VAM] FFmpeg not found — voice activation disabled.');
      this._running = false;
      return;
    }

    const dgKey = await this.secretManager.getSecret('vtp.deepgramApiKey');
    if (!dgKey) {
      this.log('[VAM] No Deepgram key — falling back to Gemini for wake detection.');
      this._running = false;
      // Restart with Gemini as fallback
      const geminiKey = await this.secretManager.getApiKey();
      if (!geminiKey) return;
      this._running   = true;
      this._loopAbort = false;
      void this._loopGemini(phrase, onWake);
      return;
    }

    const onTranscript = (text: string) => {
      if (this._loopAbort) return;
      if (!text.trim()) return;
      this.log(`[VAM] Heard: "${text}"`);
      if (this._phraseMatches(text, phrase)) {
        this.log('[VAM] Wake phrase matched — triggering recording.');
        this._loopAbort = true;
        this._running   = false;
        this._dg?.disconnect();
        this._dg = null;
        this._capture.kill();
        onWake();
      }
    };

    this._dg = new DeepgramTranscriber(dgKey, { mipOptOut: true });
    this._dg.onInterim = onTranscript;
    this._dg.onFinal   = onTranscript;
    this._dg.onError   = (err) => this.log(`[VAM] Deepgram error: ${err.message}`);
    this._dg.onReady   = () => this.log('[VAM] Deepgram wake stream connected.');
    this._dg.connect();

    // Start FFmpeg streaming → feed PCM to Deepgram
    this._capture.onPcmData = (chunk: Buffer) => this._dg?.send(chunk);
    try {
      await this._capture.startStreaming();
    } catch (err) {
      this.log(`[VAM] Deepgram wake capture failed: ${err instanceof Error ? err.message : String(err)}`);
      this.stop();
      return;
    }

    // Keep running until stopped — Deepgram callbacks drive everything
    while (!this._loopAbort) {
      await new Promise<void>((r) => setTimeout(r, 200));
    }

    this._running = false;
    this.log('[VAM] Loop exited.');
  }

  // ─── Gemini batch loop ──────────────────────────────────────────────────────

  private async _loopGemini(phrase: string, onWake: () => void): Promise<void> {
    const ffmpegOk = await AudioCapture.isAvailable();
    if (!ffmpegOk) {
      this.log('[VAM] FFmpeg not found — voice activation disabled.');
      this._running = false;
      return;
    }

    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) {
      this.log('[VAM] No Gemini API key — voice activation disabled.');
      this._running = false;
      return;
    }

    while (!this._loopAbort) {
      try {
        await this._capture.start();
        // 1.5s window: sufficient for most wake phrases + FFmpeg init overhead
        await new Promise<void>((r) => setTimeout(r, 1_500));
        if (this._loopAbort) { this._capture.kill(); break; }

        const result = await this._capture.stop();
        if (!result) continue;

        // Reject silence / ambient noise before hitting the API
        if (!hasVoiceEnergy(result.buffer, 1500)) continue;

        const text = await this._transcribeGemini(result.buffer, result.mimeType, apiKey);
        if (!text) continue;

        this.log(`[VAM] Heard: "${text}"`);

        if (this._phraseMatches(text, phrase)) {
          this.log('[VAM] Wake phrase matched — triggering recording.');
          this._running   = false;
          this._loopAbort = true;
          onWake();
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[VAM] Loop error (non-fatal): ${msg}`);
        this._capture.kill();
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    this._running = false;
    this.log('[VAM] Loop exited.');
  }

  // ─── Transcription ──────────────────────────────────────────────────────────

  private async _transcribeGemini(buffer: Buffer, mimeType: string, apiKey: string): Promise<string> {
    const base64 = buffer.toString('base64');
    const genai  = new GoogleGenerativeAI(apiKey);
    const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];

    for (const modelName of MODELS) {
      try {
        const model = genai.getGenerativeModel({
          model: modelName,
          systemInstruction:
            'Transcribe the audio exactly as spoken. Output ONLY the spoken words. ' +
            'If there is no speech or only background noise, output exactly: [SILENCE]',
          generationConfig: { temperature: 0 },
        });
        const res = await model.generateContent([
          { inlineData: { mimeType, data: base64 } },
          'Transcribe the audio.',
        ]);
        const raw = res.response.text().trim();
        return sanitizeTranscription(raw);
      } catch (e) {
        const s = String(e);
        const isRetriable =
          s.includes('503') || s.includes('500') || s.includes('404') ||
          s.includes('overloaded') || s.includes('high demand') ||
          s.includes('Internal error') || s.includes('Service Unavailable') ||
          s.includes('no longer available');
        if (isRetriable) continue;
        throw e;
      }
    }
    return '';
  }

  // ─── Phrase matching ────────────────────────────────────────────────────────

  /**
   * Fuzzy match: normalises punctuation, hyphens, and filler before comparing.
   *
   * Handles real-world ASR variations:
   *   "Hey anti-gravity,"           → matches "hey antigravity"
   *   "hey anti gravity"            → matches "hey antigravity"  (space-collapse path)
   *   "hey jar vis"                 → matches "hey jarvis"       (works for any phrase)
   *   "hey antigravity please start"→ matches (extra words allowed after)
   */
  private _phraseMatches(heard: string, phrase: string): boolean {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/-/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    const normHeard  = normalize(heard);
    const normPhrase = normalize(phrase);

    // 1. Fast exact substring check
    if (normHeard.includes(normPhrase)) return true;

    // 2. Space-collapsed check — catches ASR compound-word splits.
    //    Deepgram often splits words it doesn't recognise into parts:
    //    "antigravity" → "anti gravity", "jarvis" → "jar vis", etc.
    //    Stripping all spaces from both sides makes them compare equal
    //    regardless of where the split happened.
    const collapsedHeard  = normHeard.replace(/\s/g, '');
    const collapsedPhrase = normPhrase.replace(/\s/g, '');
    if (collapsedHeard.includes(collapsedPhrase)) return true;

    // 3. Word-order check (tolerant of minor ASR insertions between words)
    const words = normPhrase.split(/\s+/).filter(Boolean);
    let pos = 0;
    for (const word of words) {
      const idx = normHeard.indexOf(word, pos);
      if (idx === -1) return false;
      pos = idx + word.length;
    }
    return true;
  }
}
