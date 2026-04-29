/**
 * WakeMonitor — listens for wake phrases ("resume", "continue", "I'm back")
 * while VTP is paused.  Uses FFmpeg single-file recording → Gemini transcription.
 *
 * Bug-fix: Reduced fallback timeout from 30s to 5s.  FFmpeg's silencedetect
 * filter only catches silence→speech TRANSITIONS.  If the user starts speaking
 * before FFmpeg finishes its ~300ms DirectShow init, there's no transition to
 * detect and the loop spins forever.  The 5s fallback ensures we always
 * capture and transcribe within a reasonable window.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { AudioCapture } from '../audio/AudioCapture';
import { WAKE_PHRASE, sanitizeTranscription, hasVoiceEnergy, hasSendTrigger } from './CommandDetector';
import type { ExtensionMessage } from '../types';

export interface WakeMonitorDeps {
  capture: AudioCapture;
  getApiKey: () => Promise<string | undefined>;
  log: (msg: string) => void;
  send: (msg: ExtensionMessage) => void;
  /** Read current pause state. */
  getIsPaused: () => boolean;
  /** Called when wake phrase is matched — the caller resumes recording. */
  onWake: (hasSendTrigger: boolean) => void;
}

export class WakeMonitor {
  private deps: WakeMonitorDeps;

  constructor(deps: WakeMonitorDeps) {
    this.deps = deps;
  }

  /**
   * Main wake-phrase monitor loop.
   * Runs while isPaused=true, cycling FFmpeg capture → Gemini transcribe.
   *
   * WHY fixed 5s window instead of silence detection:
   * DirectShow on Windows takes 1–2s to initialise. With silence-detection,
   * the user says "resume" during FFmpeg's init window — we capture silence.
   * 5s window gives FFmpeg ~1.5s to init and still leaves ~3.5s of real capture.
   */
  async run(
    interimTranscript: string,
    promptBuffer: string,
    sendToBuffer: (saved: string) => void,
    mode: 'gemini' | 'deepgram' = 'gemini',
  ): Promise<void> {
    // ── Preserve transcript before stopping ──
    const savedTranscript = interimTranscript
      .replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();
    if (savedTranscript) {
      sendToBuffer(savedTranscript);
      this.deps.log(`[VTP] Saved to buffer before pause: "${savedTranscript}"`);
    }

    // ── Stop the active capture before entering single-file wake monitor ──
    // IMPORTANT: In Deepgram mode the capture is in streaming mode, not chunked.
    // stopChunked() is a no-op on a streaming process and leaves the DirectShow
    // mic device locked — causing `capture.start()` below to conflict, which
    // forces the user to repeat "resume" many times until the old process dies.
    this.deps.capture.onChunkReady = null;
    if (mode === 'deepgram') {
      await this.deps.capture.stopStreaming();
    } else {
      await this.deps.capture.stopChunked();
    }

    if (!this.deps.getIsPaused()) return;

    const apiKey = await this.deps.getApiKey();
    if (!apiKey) return;

    // Detach VAD callbacks — the wake monitor wires its own below.
    this.deps.capture.onSilenceDetected = null;
    this.deps.capture.onExtendedSilence = null;

    this.deps.log('[VTP] Wake monitor: say "resume", "continue", or "I\'m back"...');

    while (this.deps.getIsPaused()) {
      try {
        // ── Wait for speech using FFmpeg silencedetect ──
        let speechDetectedResolve!: () => void;
        const speechDetected = new Promise<void>((r) => { speechDetectedResolve = r; });

        await this.deps.capture.start();           // single-file mode with silencedetect
        await new Promise<void>((r) => setTimeout(r, 300)); // DirectShow init
        if (!this.deps.getIsPaused()) { await this.deps.capture.stop(); break; }

        // Wire both silence callbacks so we don't miss speech
        this.deps.capture.onSilenceDetected = () => speechDetectedResolve();
        this.deps.capture.onSilenceStart = () => speechDetectedResolve();
        this.deps.log('[VTP] Wake monitor: waiting for speech...');
        this.deps.send({ type: 'wakeReady' });

        // Block until speech OR 5s timeout (was 30s — reduced to catch speech
        // that started before FFmpeg was ready)
        await Promise.race([
          speechDetected,
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);

        if (!this.deps.getIsPaused()) { await this.deps.capture.stop(); break; }

        // 2.5s: long enough for "Hey Antigravity" (~1.2s speech + FFmpeg init overhead)
        await new Promise<void>((r) => setTimeout(r, 2_500));
        const result = await this.deps.capture.stop();
        this.deps.capture.onSilenceDetected = null;
        this.deps.capture.onSilenceStart = null;

        if (!result) continue;

        // ── Energy gate ──
        if (!hasVoiceEnergy(result.buffer)) continue;

        // ── Transcribe with Gemini ──
        const base64 = result.buffer.toString('base64');
        const genai = new GoogleGenerativeAI(apiKey);

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
        const clean = sanitizeTranscription(wakeRaw);
        if (!clean) continue;
        const text = clean.toLowerCase();
        this.deps.log(`[VTP] Wake monitor heard: "${text}"`);

        if (WAKE_PHRASE.test(text)) {
          this.deps.log('[VTP] Wake phrase matched \u2014 resuming.');
          // Check if wake utterance also contains a send trigger
          const hasSend = hasSendTrigger(text);
          this.deps.onWake(hasSend);
          return;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.deps.log(`[VTP] Wake monitor error: ${errMsg}`);
        this.deps.capture.kill(); // ensure no orphaned proc before next loop iteration
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
}
