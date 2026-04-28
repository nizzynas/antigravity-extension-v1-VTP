import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export interface AudioResult {
  buffer: Buffer;
  mimeType: 'audio/wav';
}

/**
 * Records audio from the system microphone using FFmpeg.
 *
 * Windows:  ffmpeg -f dshow  (DirectShow)
 * macOS:    ffmpeg -f avfoundation
 * Linux:    ffmpeg -f alsa
 *
 * Silence detection (two tiers via FFmpeg silencedetect):
 *
 *   silence_end  (after d=1.5s) → onSilenceDetected  → short pause, auto-stop
 *   silence_start + 8s timer   → onExtendedSilence   → walked away, auto-pause
 *
 * Both callbacks are cleared when stop() or kill() is called.
 */
export class AudioCapture {
  private proc: cp.ChildProcess | null = null;
  private tempFile: string | null = null;
  private _error: string | null = null;
  private _hadSpeech = false;
  private _extendedSilenceTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Callbacks ───────────────────────────────────────────────────────────────

  /** Fired after 1.5s of silence following speech. Consumer should call stop(). */
  onSilenceDetected: (() => void) | null = null;

  /**
   * Fired after 8s of continuous silence following speech.
   * Consumer should PAUSE (kill mic, keep buffer) rather than process.
   * NOTE: if onSilenceDetected already triggered stop(), this won't fire
   * because the process will be dead and the timer cleared.
   */
  onExtendedSilence: (() => void) | null = null;

  // ─── Static ─────────────────────────────────────────────────────────────────

  static async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = cp.spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close',  (c) => resolve(c === 0));
    });
  }

  static async getWindowsAudioDevice(): Promise<string> {
    return new Promise((resolve) => {
      const p = cp.spawn(
        'ffmpeg',
        ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      p.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      p.on('error', () => resolve('Microphone'));
      p.on('close', () => {
        const matches = [...stderr.matchAll(/"([^"]+)"\s+\(audio\)/g)];
        resolve(matches.length > 0 ? matches[0][1] : 'Microphone');
      });
    });
  }

  // ─── Instance API ───────────────────────────────────────────────────────────

  async start(maxSeconds = 120): Promise<void> {
    if (this.proc) return;
    this._error = null;
    this._hadSpeech = false;
    this._clearExtendedTimer();

    this.tempFile = path.join(os.tmpdir(), `vtp-${Date.now()}.wav`);
    const args = await this.buildArgs(maxSeconds);

    this.proc = cp.spawn('ffmpeg', args, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    this.proc.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;

      // ── silence_start: user stopped speaking ──────────────────────────────
      // Start the extended silence timer (auto-pause if idle for 8s).
      if (/silence_start/i.test(chunk)) {
        this._hadSpeech = true;
        if (!this._extendedSilenceTimer) {
          this._extendedSilenceTimer = setTimeout(() => {
            this._extendedSilenceTimer = null;
            if (this.onExtendedSilence) {
              this.onExtendedSilence();
            }
          }, 8000); // 8 seconds of continuous silence → auto-pause
        }
      }

      // ── silence_end: user resumed speaking ────────────────────────────────
      // Cancel the extended silence timer (they came back).
      // Also fire short-silence auto-stop (finished an utterance).
      if (/silence_end/i.test(chunk)) {
        this._clearExtendedTimer(); // speech resumed — no auto-pause
        if (this._hadSpeech && this.onSilenceDetected) {
          this.onSilenceDetected();
        }
      }
    });

    this.proc.on('error', (e) => { this._error = e.message; });
    this.proc.on('close', (code) => {
      this._clearExtendedTimer();
      if (code !== 0 && code !== null && !this._error) {
        const short = stderr.split('\n').slice(-3).join(' ');
        this._error = `FFmpeg exited (${code}): ${short}`;
      }
    });
  }

  async stop(): Promise<AudioResult | null> {
    this._clearExtendedTimer();
    if (!this.proc || !this.tempFile) return null;

    try { this.proc.stdin?.write('q'); } catch {}

    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { this.proc?.kill('SIGKILL'); resolve(); }, 3000);
      this.proc!.on('close', () => { clearTimeout(t); resolve(); });
    });

    this.proc = null;

    const file = this.tempFile;
    this.tempFile = null;

    if (!fs.existsSync(file)) {
      if (this._error) throw new Error(this._error);
      return null;
    }

    const buffer = fs.readFileSync(file);
    try { fs.unlinkSync(file); } catch {}

    if (buffer.length < 100) return null;

    return { buffer, mimeType: 'audio/wav' };
  }

  /** Kills FFmpeg immediately without returning audio data. Buffer is NOT processed. */
  pause(): void {
    this._clearExtendedTimer();
    try { this.proc?.kill('SIGKILL'); } catch {}
    this.proc = null;
    if (this.tempFile) {
      try { fs.unlinkSync(this.tempFile); } catch {}
      this.tempFile = null;
    }
  }

  isRecording(): boolean {
    return this.proc !== null;
  }

  kill(): void {
    this._clearExtendedTimer();
    try { this.proc?.kill('SIGKILL'); } catch {}
    this.proc = null;
    if (this.tempFile) {
      try { fs.unlinkSync(this.tempFile); } catch {}
      this.tempFile = null;
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private _clearExtendedTimer(): void {
    if (this._extendedSilenceTimer) {
      clearTimeout(this._extendedSilenceTimer);
      this._extendedSilenceTimer = null;
    }
  }

  private async buildArgs(maxSeconds: number): Promise<string[]> {
    const out = this.tempFile!;
    // silencedetect: d=1.5 → fire after 1.5s of silence at -30dB noise floor
    const silenceFilter = 'silencedetect=noise=-30dB:d=1.5';
    const common = ['-ar', '16000', '-ac', '1', '-af', silenceFilter, '-y'];

    if (process.platform === 'win32') {
      const device = await AudioCapture.getWindowsAudioDevice();
      return ['-f', 'dshow', '-i', `audio=${device}`, ...common, out];
    }
    if (process.platform === 'darwin') {
      return ['-f', 'avfoundation', '-i', ':0', ...common, out];
    }
    return ['-f', 'alsa', '-i', 'default', ...common, out];
  }
}
