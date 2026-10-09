import * as cp from 'child_process';

export class MicCapture {
  private proc: cp.ChildProcess | null = null;
  private _dyingProc: Promise<void> | null = null;
  private _rem: Buffer = Buffer.alloc(0);
  private static _cachedDevice: string | null = null;

  onPcmData: ((data: Buffer) => void) | null = null;
  onLog: ((line: string) => void) | null = null;
  deviceName = '';
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
      const buf = this._rem.length ? Buffer.concat([this._rem, chunk]) : chunk;
      const evenLen = buf.length - (buf.length % 2);
      this._rem = evenLen < buf.length ? buf.subarray(evenLen) : Buffer.alloc(0);
      if (evenLen > 0) this.onPcmData?.(buf.subarray(0, evenLen));
    });
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
    this.proc.on('close', () => {});
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
