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
 * Runs entirely in the Node.js extension host — no webview, no browser.
 *
 * Windows:  ffmpeg -f dshow  (DirectShow)
 * macOS:    ffmpeg -f avfoundation
 * Linux:    ffmpeg -f alsa
 */
export class AudioCapture {
  private proc: cp.ChildProcess | null = null;
  private tempFile: string | null = null;
  private _error: string | null = null;

  // ─── Static availability check ───────────────────────────────────────────

  static async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = cp.spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close',  (c) => resolve(c === 0));
    });
  }

  /**
   * Enumerate Windows DirectShow audio devices and return the first one.
   * Falls back to the literal string "Microphone" which works on most systems.
   */
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
        // FFmpeg outputs:  "Device Name" (audio)
        const matches = [...stderr.matchAll(/"([^"]+)"\s+\(audio\)/g)];
        resolve(matches.length > 0 ? matches[0][1] : 'Microphone');
      });
    });
  }

  // ─── Instance API ─────────────────────────────────────────────────────────

  /** Starts recording. Throws if FFmpeg is not found or the mic is unavailable. */
  async start(maxSeconds = 60): Promise<void> {
    if (this.proc) return;
    this._error = null;

    this.tempFile = path.join(os.tmpdir(), `vtp-${Date.now()}.wav`);

    const args = await this.buildArgs(maxSeconds);
    this.proc = cp.spawn('ffmpeg', args, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    // Capture stderr for error reporting
    let stderr = '';
    this.proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    this.proc.on('error', (e) => { this._error = e.message; });
    this.proc.on('close',  (code) => {
      if (code !== 0 && code !== null && !this._error) {
        // Only treat as error if we didn't stop it deliberately
        const short = stderr.split('\n').slice(-3).join(' ');
        this._error = `FFmpeg exited (${code}): ${short}`;
      }
    });
  }

  /**
   * Stops the recording and returns the captured WAV data.
   * Returns null if nothing was recorded.
   */
  async stop(): Promise<AudioResult | null> {
    if (!this.proc || !this.tempFile) return null;

    // Send 'q' to gracefully stop FFmpeg
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

    if (buffer.length < 100) return null; // Essentially empty

    return { buffer, mimeType: 'audio/wav' };
  }

  isRecording(): boolean {
    return this.proc !== null;
  }

  kill(): void {
    try { this.proc?.kill('SIGKILL'); } catch {}
    this.proc = null;
    if (this.tempFile) {
      try { fs.unlinkSync(this.tempFile); } catch {}
      this.tempFile = null;
    }
  }

  // ─── Platform args ────────────────────────────────────────────────────────

  private async buildArgs(maxSeconds: number): Promise<string[]> {
    const out = this.tempFile!;
    const common = ['-ar', '16000', '-ac', '1', '-y'];

    if (process.platform === 'win32') {
      const device = await AudioCapture.getWindowsAudioDevice();
      return ['-f', 'dshow', '-i', `audio=${device}`, ...common, out];
    }

    if (process.platform === 'darwin') {
      // avfoundation: ":0" = default audio input
      return ['-f', 'avfoundation', '-i', ':0', ...common, out];
    }

    // Linux
    return ['-f', 'alsa', '-i', 'default', ...common, out];
  }
}
