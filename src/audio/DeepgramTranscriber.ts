/**
 * DeepgramTranscriber — real-time WebSocket STT client.
 *
 * Deepgram is an OPTIONAL 3rd-party transcription service.
 * It is never activated unless the user explicitly opts in and provides
 * their own API key. The key is stored locally in VS Code SecretStorage
 * and is sent ONLY to api.deepgram.com — never anywhere else.
 *
 * Deepgram free tier: 12,000 minutes/month (console.deepgram.com)
 */

import * as https from 'https';

// ─── Privacy / behaviour options ─────────────────────────────────────────────
export interface DeepgramOptions {
  /** Opt out of Deepgram Model Improvement Program (mip_opt_out=true). */
  mipOptOut?: boolean;
  /**
   * Redact sensitive information from the transcript.
   * Accepted values: 'pci' | 'pii' | 'numbers' | 'ssn'
   * Multiple values are allowed and each gets its own query param.
   */
  redact?: Array<'pci' | 'pii' | 'numbers' | 'ssn'>;
  /** Replace recognised profanity with [censored]. */
  profanityFilter?: boolean;
}

// ─── Deepgram WebSocket URL ───────────────────────────────────────────────────
const DG_HOST = 'api.deepgram.com';

function buildDgPath(opts: DeepgramOptions = {}): string {
  const parts = [
    '/v1/listen',
    '?encoding=linear16',
    '&sample_rate=16000',
    '&channels=1',
    '&model=nova-2',
    '&language=en',
    '&interim_results=true',
    '&endpointing=300',      // 300ms silence = end of utterance
    '&smart_format=true',    // punctuation + capitalization
    '&no_delay=true',        // lowest latency mode
  ];
  if (opts.mipOptOut)        { parts.push('&mip_opt_out=true'); }
  if (opts.profanityFilter)  { parts.push('&profanity_filter=true'); }
  for (const r of (opts.redact ?? [])) {
    parts.push(`&redact=${encodeURIComponent(r)}`);
  }
  return parts.join('');
}

export class DeepgramTranscriber {
  private ws: import('net').Socket | null = null;
  private _connected = false;
  private _buffer: Buffer[] = [];
  private readonly _dgPath: string;

  /** Called with partial (interim) transcript as user speaks — for live display */
  onInterim: ((text: string) => void) | null = null;
  /** Called with a confirmed final transcript — feed into intent pipeline */
  onFinal:   ((text: string) => void) | null = null;
  /** Called on WebSocket error */
  onError:   ((err: Error) => void) | null = null;
  /** Called when connection is open and ready to receive audio */
  onReady:   (() => void) | null = null;

  constructor(private readonly apiKey: string, opts: DeepgramOptions = {}) {
    this._dgPath = buildDgPath(opts);
  }

  /**
   * Opens a WebSocket to Deepgram.
   * Uses Node's built-in `net` + manual HTTP Upgrade — no ws package needed.
   */
  connect(): void {
    if (this._connected) return;

    // ── Build the HTTP Upgrade request ────────────────────────────────────────
    const key = Buffer.from(`vtp-${Date.now()}`).toString('base64');
    const requestHeaders = [
      `GET ${this._dgPath} HTTP/1.1`,
      `Host: ${DG_HOST}`,
      `Authorization: Token ${this.apiKey}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: 13`,
      `\r\n`,
    ].join('\r\n');

    // ── TLS connect ────────────────────────────────────────────────────────────
    const tlsSocket = require('tls').connect({ host: DG_HOST, port: 443 }, () => {
      tlsSocket.write(requestHeaders);
    });

    let upgraded = false;
    let rawBuf = Buffer.alloc(0);

    tlsSocket.on('data', (chunk: Buffer) => {
      if (!upgraded) {
        // Look for end of HTTP headers
        rawBuf = Buffer.concat([rawBuf, chunk]);
        const sep = rawBuf.indexOf('\r\n\r\n');
        if (sep === -1) return;

        const headerText = rawBuf.slice(0, sep).toString();
        if (!headerText.includes('101')) {
          this.onError?.(new Error(`Deepgram upgrade failed: ${headerText.split('\r\n')[0]}`));
          tlsSocket.destroy();
          return;
        }
        upgraded = true;
        this._connected = true;
        this.ws = tlsSocket;

        // Flush any audio buffered before connection was ready
        for (const buf of this._buffer) { this._sendFrame(buf); }
        this._buffer = [];

        this.onReady?.();

        // Any remaining bytes after headers are WebSocket frames
        let remaining = rawBuf.slice(sep + 4);
        if (remaining.length) { this._handleFrames(remaining); }
        rawBuf = Buffer.alloc(0);
      } else {
        this._handleFrames(chunk);
      }
    });

    tlsSocket.on('error', (err: Error) => {
      this._connected = false;
      this.ws = null;
      this.onError?.(err);
    });

    tlsSocket.on('close', () => {
      this._connected = false;
      this.ws = null;
    });
  }

  /**
   * Send raw PCM audio data (16-bit LE, 16kHz mono) to Deepgram.
   * Buffers internally if the connection isn't ready yet.
   */
  send(pcm: Buffer): void {
    if (!this._connected) {
      this._buffer.push(pcm);
      return;
    }
    this._sendFrame(pcm);
  }

  /** Gracefully close — sends Deepgram's CloseStream signal then destroys socket. */
  disconnect(): void {
    if (!this._connected || !this.ws) return;
    // Deepgram CloseStream: send JSON text frame
    try {
      const msg = JSON.stringify({ type: 'CloseStream' });
      this._sendTextFrame(msg);
    } catch {}
    setTimeout(() => {
      try { (this.ws as any)?.destroy(); } catch {}
      this._connected = false;
      this.ws = null;
    }, 200);
  }

  get isConnected(): boolean { return this._connected; }

  // ─── WebSocket frame helpers (RFC 6455) ────────────────────────────────────

  /** Send a binary WebSocket frame (opcode 0x2). */
  private _sendFrame(data: Buffer): void {
    if (!this.ws) return;
    const frame = this._buildFrame(data, 0x2);
    try { (this.ws as any).write(frame); } catch {}
  }

  /** Send a UTF-8 text WebSocket frame (opcode 0x1). */
  private _sendTextFrame(text: string): void {
    if (!this.ws) return;
    const frame = this._buildFrame(Buffer.from(text, 'utf8'), 0x1);
    try { (this.ws as any).write(frame); } catch {}
  }

  private _buildFrame(payload: Buffer, opcode: number): Buffer {
    const len = payload.length;
    // Client must mask frames (RFC 6455 §5.3)
    const mask = Buffer.from([
      Math.random() * 256 | 0,
      Math.random() * 256 | 0,
      Math.random() * 256 | 0,
      Math.random() * 256 | 0,
    ]);
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len, ...mask]);
    } else if (len < 65536) {
      header = Buffer.from([0x80 | opcode, 0x80 | 126, (len >> 8) & 0xff, len & 0xff, ...mask]);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) { masked[i] = payload[i] ^ mask[i % 4]; }
    return Buffer.concat([header, masked]);
  }

  // ─── Incoming frame parser ─────────────────────────────────────────────────

  private _frameAccum = Buffer.alloc(0);

  private _handleFrames(data: Buffer): void {
    this._frameAccum = Buffer.concat([this._frameAccum, data]);

    while (this._frameAccum.length >= 2) {
      // const fin  = (this._frameAccum[0] & 0x80) !== 0;
      const opcode = this._frameAccum[0] & 0x0f;
      const masked  = (this._frameAccum[1] & 0x80) !== 0;
      let payloadLen = this._frameAccum[1] & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._frameAccum.length < 4) return;
        payloadLen = this._frameAccum.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._frameAccum.length < 10) return;
        payloadLen = Number(this._frameAccum.readBigUInt64BE(2));
        offset = 10;
      }

      if (masked) { offset += 4; }
      if (this._frameAccum.length < offset + payloadLen) return;

      const payload = this._frameAccum.slice(offset, offset + payloadLen);
      this._frameAccum = this._frameAccum.slice(offset + payloadLen);

      if (opcode === 0x8) { /* close */ this.disconnect(); return; }
      if (opcode === 0x1 || opcode === 0x0) {
        // Text frame — parse Deepgram JSON
        try { this._handleMessage(payload.toString('utf8')); } catch {}
      }
    }
  }

  private _handleMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    // Deepgram response schema: { type, channel, is_final, speech_final }
    if (msg.type !== 'Results') return;
    const transcript: string = msg?.channel?.alternatives?.[0]?.transcript ?? '';
    if (!transcript.trim()) {
      // [DBG] surface empty results so we can tell DG IS receiving audio
      if (this.onFinal && msg.is_final !== undefined) {
        // No-op: empty result is normal (silence). Surfaced via PCM log instead.
      }
      return;
    }

    if (msg.is_final) {
      this.onFinal?.(transcript);
    } else {
      this.onInterim?.(transcript);
    }
  }
}
