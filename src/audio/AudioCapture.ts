import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export interface AudioResult {
  buffer: Buffer;
  mimeType: 'audio/wav';
}

export interface ChunkResult {
  buffer: Buffer;
  mimeType: 'audio/wav';
  index: number;
}

export class AudioCapture {
  private proc: cp.ChildProcess | null = null;
  private tempFile: string | null = null;
  private _error: string | null = null;
  private _hadSpeech = false;
  private _extendedSilenceTimer: ReturnType<typeof setTimeout> | null = null;

  // Chunked-mode state
  private _chunkDir: string | null = null;
  private _chunkPollTimer: ReturnType<typeof setInterval> | null = null;
  private _processedChunks = new Set<string>();
  private _chunkIndex = 0;
  private _chunkedMode = false;

  /** Resolves when the current stopChunked() call completes. */
  private _stopInProgress: Promise<void> | null = null;

  /** Cached device name — enumerated once per extension lifetime to avoid 5-15s delay. */
  private static _cachedDevice: string | null = null;

  onSilenceDetected: (() => void) | null = null;
  onSilenceStart:    (() => void) | null = null;   // fires when user STOPS talking (silence_start)
  onExtendedSilence: (() => void) | null = null;
  onChunkReady: ((chunk: ChunkResult) => void) | null = null;
  onChunkSkipped: (() => void) | null = null;
  onFfmpegLog: ((line: string) => void) | null = null;

  static async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = cp.spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (c) => resolve(c === 0));
    });
  }

  static async getWindowsAudioDevice(): Promise<string> {
    if (AudioCapture._cachedDevice) return AudioCapture._cachedDevice;
    return new Promise((resolve) => {
      const p = cp.spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      p.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      p.on('error', () => { AudioCapture._cachedDevice = 'Microphone'; resolve('Microphone'); });
      p.on('close', () => {
        const matches = [...stderr.matchAll(/"([^"]+)"\s+\(audio\)/g)];
        AudioCapture._cachedDevice = matches.length > 0 ? matches[0][1] : 'Microphone';
        resolve(AudioCapture._cachedDevice);
      });
    });
  }

  // ─── Single-file mode (wake monitor) ────────────────────────────────────────

  async start(maxSeconds = 120): Promise<void> {
    // Kill any leftover process before starting fresh (never silently return).
    if (this.proc) { this.kill(); }
    this._error = null;
    this._hadSpeech = false;
    this._chunkedMode = false;
    this._clearExtendedTimer();

    this.tempFile = path.join(os.tmpdir(), `vtp-${Date.now()}.wav`);
    const args = await this._buildArgs(this.tempFile, maxSeconds);
    this._spawnFFmpeg(args);
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
    if (!fs.existsSync(file)) return null;

    const buffer = fs.readFileSync(file);
    try { fs.unlinkSync(file); } catch {}
    if (buffer.length < 100) return null;
    return { buffer, mimeType: 'audio/wav' };
  }

  // ─── Chunked mode (live transcript) ─────────────────────────────────────────

  async startChunked(chunkSeconds = 2, maxSeconds = 300): Promise<void> {
    // ── Serialize: wait for any in-progress stop before spawning ──────────────
    // Without this, fire-and-forget callers (void stopRecording()) race with
    // startRecording(), creating multiple FFmpeg processes holding the same
    // DirectShow mic device, which causes audio corruption and zombie buildup.
    if (this._stopInProgress) {
      await this._stopInProgress;
    }

    // Kill any still-alive leftover (safety net)
    if (this.proc) { this.kill(); }
    this._error = null;
    this._hadSpeech = false;
    this._chunkedMode = true;
    this._processedChunks.clear();
    this._chunkIndex = 0;
    this._clearExtendedTimer();

    this._chunkDir = path.join(os.tmpdir(), `vtp-chunks-${Date.now()}`);
    fs.mkdirSync(this._chunkDir, { recursive: true });

    const chunkPattern = path.join(this._chunkDir, 'chunk%03d.wav');
    const silenceFilter = 'silencedetect=noise=-40dB:d=5.0';

    let inputArgs: string[];
    if (process.platform === 'win32') {
      const device = await AudioCapture.getWindowsAudioDevice();
      // -rtbufsize 100M: large DirectShow buffer prevents audio glitches when
      // the system is under load or when previous process just released the device.
      inputArgs = ['-f', 'dshow', '-rtbufsize', '100M', '-i', `audio=${device}`];
    } else if (process.platform === 'darwin') {
      inputArgs = ['-f', 'avfoundation', '-i', ':0'];
    } else {
      inputArgs = ['-f', 'alsa', '-i', 'default'];
    }

    const args = [
      ...inputArgs,
      '-ar', '16000', '-ac', '1',
      '-af', silenceFilter,
      '-f', 'segment',
      '-segment_time', String(chunkSeconds),
      '-segment_format', 'wav',
      '-y', chunkPattern,
    ];

    this._spawnFFmpeg(args);

    // Poll for completed segment files every 500ms
    this._chunkPollTimer = setInterval(() => this._pollChunks(), 500);
  }

  async stopChunked(): Promise<void> {
    // Expose this stop as a promise so startChunked() can await it.
    // This serializes stop→start even when the caller uses void (fire-and-forget).
    this._stopInProgress = this._doStopChunked();
    await this._stopInProgress;
    this._stopInProgress = null;
  }

  private async _doStopChunked(): Promise<void> {
    if (this._chunkPollTimer) {
      clearInterval(this._chunkPollTimer);
      this._chunkPollTimer = null;
    }
    this._clearExtendedTimer();

    if (this.proc) {
      // Null proc FIRST so isRecording() returns false immediately.
      // This prevents any VAD callback firing during the kill window from
      // seeing an active recording and spawning a second FFmpeg.
      const dying = this.proc;
      this.proc = null;
      try { dying.stdin?.write('q'); } catch {}
      await new Promise<void>((resolve) => {
        // 1s timeout — DirectShow on Windows ignores stdin 'q', so we
        // follow up with a hard kill rather than waiting 3s.
        const t = setTimeout(() => { try { dying.kill('SIGKILL'); } catch {} resolve(); }, 1000);
        dying.once('close', () => { clearTimeout(t); resolve(); });
      });
    }

    // Process remaining files (final partial segment)
    if (this._chunkDir && fs.existsSync(this._chunkDir)) {
      const remaining = fs.readdirSync(this._chunkDir)
        .filter(f => /chunk\d+\.wav/.test(f))
        .map(f => path.join(this._chunkDir!, f))
        .sort()
        .filter(f => !this._processedChunks.has(f));

      for (const file of remaining) {
        this._processedChunks.add(file);
        try {
          const buffer = fs.readFileSync(file);
          if (buffer.length > 2000) {
            this.onChunkReady?.({ buffer, mimeType: 'audio/wav', index: this._chunkIndex++ });
          } else {
            this.onChunkSkipped?.();
          }
        } catch {}
      }

      this._cleanupChunkDir();
    }
  }

  private _pollChunks(): void {
    if (!this._chunkDir || !fs.existsSync(this._chunkDir)) return;
    try {
      const files = fs.readdirSync(this._chunkDir)
        .filter(f => /chunk\d+\.wav/.test(f))
        .map(f => path.join(this._chunkDir!, f))
        .sort();

      // All except the last file are complete (FFmpeg is writing to the last one)
      const completed = files.slice(0, -1);
      for (const file of completed) {
        if (!this._processedChunks.has(file)) {
          this._processedChunks.add(file);
          try {
            const buffer = fs.readFileSync(file);
            if (buffer.length > 2000) {
              this.onChunkReady?.({ buffer, mimeType: 'audio/wav', index: this._chunkIndex++ });
            }
            try { fs.unlinkSync(file); } catch {}
          } catch {}
        }
      }
    } catch {}
  }

  private _cleanupChunkDir(): void {
    if (this._chunkDir) {
      try { fs.rmSync(this._chunkDir, { recursive: true, force: true }); } catch {}
      this._chunkDir = null;
      this._processedChunks.clear();
    }
  }

  // ─── Shared ──────────────────────────────────────────────────────────────────

  isRecording(): boolean { return this.proc !== null; }

  kill(): void {
    this._clearExtendedTimer();
    if (this._chunkPollTimer) { clearInterval(this._chunkPollTimer); this._chunkPollTimer = null; }
    try { this.proc?.kill('SIGKILL'); } catch {}
    this.proc = null;
    if (this.tempFile) { try { fs.unlinkSync(this.tempFile); } catch {} this.tempFile = null; }
    this._cleanupChunkDir();
  }

  pause(): void { this.kill(); }

  private _clearExtendedTimer(): void {
    if (this._extendedSilenceTimer) { clearTimeout(this._extendedSilenceTimer); this._extendedSilenceTimer = null; }
  }

  private _spawnFFmpeg(args: string[]): void {
    this.proc = cp.spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });

    this.proc.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString();

      // Forward errors/warnings to log for diagnostics
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) this.onFfmpegLog?.(trimmed);
      }

      // silence_start = user stopped talking (after the silence duration d=5s).
      // Fire onSilenceStart (VAD auto-stop) if we've had real speech.
      if (/silence_start/i.test(chunk)) {
        if (this._hadSpeech) {
          this.onSilenceStart?.(); // primary VAD stop signal
          if (!this._extendedSilenceTimer) {
            this._extendedSilenceTimer = setTimeout(() => {
              this._extendedSilenceTimer = null;
              this.onExtendedSilence?.();
            }, 15000);
          }
        }
      }

      // silence_end = user started talking again.
      if (/silence_end/i.test(chunk)) {
        this._hadSpeech = true;
        this._clearExtendedTimer();
        this.onSilenceDetected?.();
      }
    });

    this.proc.on('error', (e) => { this._error = e.message; this.onFfmpegLog?.(`FFmpeg process error: ${e.message}`); });
    this.proc.on('close', (code) => { this._clearExtendedTimer(); if (code && code !== 255) this.onFfmpegLog?.(`FFmpeg exited with code ${code}`); });
  }

  private async _buildArgs(outFile: string, maxSeconds: number): Promise<string[]> {
    const silenceFilter = 'silencedetect=noise=-40dB:d=3.0';
    const common = ['-ar', '16000', '-ac', '1', '-af', silenceFilter, '-y'];
    if (process.platform === 'win32') {
      const device = await AudioCapture.getWindowsAudioDevice();
      return ['-f', 'dshow', '-i', `audio=${device}`, ...common, outFile];
    }
    if (process.platform === 'darwin') {
      return ['-f', 'avfoundation', '-i', ':0', ...common, outFile];
    }
    return ['-f', 'alsa', '-i', 'default', ...common, outFile];
  }
}
