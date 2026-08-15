import * as cp from 'child_process';

/**
 * MicCapture — captures the microphone via FFmpeg and streams raw PCM.
 *
 * Output: 16-bit little-endian, mono, 16 kHz — exactly what Vosk wants. Each
 * stdout data event calls `onPcmData(buffer)`. The host forwards these buffers
 * to the webview, where Vosk (WASM) transcribes them.
 *
 * FFmpeg is used (instead of the webview's getUserMedia) because the
 * Antigravity/VS Code webview denies mic access; FFmpeg needs no browser
 * permission and works headless.
 */
export class MicCapture {
  private proc: cp.ChildProcess | null = null;
  private _dyingProc: Promise<void> | null = null;
  /** Carries a trailing odd byte between stdout chunks to keep s16 samples aligned. */
  private _rem: Buffer = Buffer.alloc(0);
  private static _cachedDevice: string | null = null;

  /** Called with each raw PCM buffer (s16le mono 16 kHz) from FFmpeg stdout. */
  onPcmData: ((data: Buffer) => void) | null = null;
  /** Diagnostic log line callback. */
  onLog: ((line: string) => void) | null = null;
  /** The OS input device FFmpeg is currently reading from (shown in the meter). */
  deviceName = '';
  /** Extra input gain in dB, applied before anything else sees the audio. */
  gainDb = 0;

  static isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = cp.spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (c) => resolve(c === 0));
    });
  }

  private static getWindowsAudioDevice(): Promise<string> {
    if (MicCapture._cachedDevice) return Promise.resolve(MicCapture._cachedDevice);
    return new Promise((resolve) => {
      const p = cp.spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      p.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      p.on('error', () => { MicCapture._cachedDevice = 'Microphone'; resolve('Microphone'); });
      p.on('close', () => {
        const matches = [...stderr.matchAll(/"([^"]+)"\s+\(audio\)/g)];
        MicCapture._cachedDevice = matches.length > 0 ? matches[0][1] : 'Microphone';
        resolve(MicCapture._cachedDevice);
      });
    });
  }

  isRecording(): boolean { return this.proc !== null; }

  /** Start streaming PCM. Serializes against any in-flight kill. */
  async startStreaming(): Promise<void> {
    if (this._dyingProc) { await this._dyingProc; }
    if (this.proc) { this.kill(); await this._dyingProc; }

    let inputArgs: string[];
    if (process.platform === 'win32') {
      const device = await MicCapture.getWindowsAudioDevice();
      this.deviceName = device;
      inputArgs = ['-f', 'dshow', '-rtbufsize', '100M', '-i', `audio=${device}`];
    } else if (process.platform === 'darwin') {
      this.deviceName = 'System default input';
      inputArgs = ['-f', 'avfoundation', '-i', ':0'];
    } else {
      this.deviceName = 'System default input';
      inputArgs = ['-f', 'alsa', '-i', 'default'];
    }

    // Gentle high-pass to drop DC/rumble only. We deliberately DON'T run an
    // aggressive denoiser (afftdn) here — it eats soft consonants and hurts
    // Vosk's recognition. Vosk's acoustic model tolerates normal mic noise.
    // Optional make-up gain comes last, for inputs that arrive too quiet for
    // the recogniser to work with.
    const audioFilter = this.gainDb
      ? `highpass=f=70,volume=${this.gainDb}dB`
      : 'highpass=f=70';
    const args = [
      ...inputArgs,
      '-af', audioFilter,
      '-ar', '16000', '-ac', '1',
      '-f', 's16le',
      'pipe:1',
    ];

    this._rem = Buffer.alloc(0);
    this.proc = cp.spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      // Keep 16-bit samples aligned: carry any trailing odd byte to next chunk.
      const buf = this._rem.length ? Buffer.concat([this._rem, chunk]) : chunk;
      const evenLen = buf.length - (buf.length % 2);
      this._rem = evenLen < buf.length ? buf.subarray(evenLen) : Buffer.alloc(0);
      if (evenLen > 0) this.onPcmData?.(buf.subarray(0, evenLen));
    });
    // Log what FFmpeg says the device actually gave us (rate/channels/format)
    // once per session, then only genuine errors. Capture-format surprises are
    // a common cause of "it hears nothing".
    let formatLines = 0;
    this.proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      if (/device (is )?not found|unable to open|dshow.*error|could not open|in use|permission/i.test(text)) {
        this.onLog?.('[MicCapture] ' + text.split('\n')[0]);
        return;
      }
      if (formatLines >= 4) return;
      for (const line of text.split('\n')) {
        if (!/Stream #0:0|Input #0|Output #0/.test(line)) continue;
        this.onLog?.('[MicCapture] ' + line.trim());
        if (++formatLines >= 4) break;
      }
    });
    this.proc.on('error', (e) => this.onLog?.(`[MicCapture] spawn error: ${e.message}`));
    this.proc.on('close', () => { /* handled by kill/stop */ });
  }

  async stopStreaming(): Promise<void> {
    this.kill();
    if (this._dyingProc) await this._dyingProc;
  }

  kill(): void {
    if (!this.proc) return;
    const dying = this.proc;
    this.proc = null;
    this._dyingProc = new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { dying.kill('SIGKILL'); } catch {} resolve(); }, 800);
      dying.once('close', () => { clearTimeout(t); resolve(); });
    }).finally(() => { this._dyingProc = null; });
    try { dying.stdin?.write('q'); } catch {}
  }
}
