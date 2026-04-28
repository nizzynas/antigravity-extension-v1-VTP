import * as http from 'http';
import * as net from 'net';

type AudioCallback = (audioBuffer: Buffer, mimeType: string) => void;

const CAPTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>VTP — Record</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #12131a; color: #c0caf5;
         display: flex; flex-direction: column; align-items: center; justify-content: center;
         height: 100vh; gap: 16px; }
  h2  { margin: 0; font-size: 18px; }
  p   { margin: 0; font-size: 13px; color: #565f89; }
  button { border: none; border-radius: 8px; font-size: 14px; font-weight: 600;
           padding: 12px 28px; cursor: pointer; transition: opacity .15s; }
  button:hover { opacity: .85; }
  #btn-record { background: linear-gradient(135deg,#7c6af7,#6366f1); color:#fff; }
  #btn-stop   { background: #f7768e; color:#fff; display:none; }
  #status     { font-size: 12px; color: #9ece6a; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%;
         background:#f7768e; margin-right:6px; animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
</style>
</head>
<body>
<h2>🎙 VTP — Voice Capture</h2>
<p>Click Record, speak, then click Stop to send to Antigravity.</p>
<button id="btn-record">Start Recording</button>
<button id="btn-stop">Stop &amp; Send</button>
<p id="status"></p>
<script>
let recorder, chunks = [];
const btnRec  = document.getElementById('btn-record');
const btnStop = document.getElementById('btn-stop');
const status  = document.getElementById('status');

btnRec.onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const types = ['audio/webm;codecs=opus','audio/webm','audio/ogg','audio/mp4'];
    const mime  = types.find(t => MediaRecorder.isTypeSupported(t)) || '';
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    chunks   = [];
    recorder.ondataavailable = e => { if(e.data.size > 0) chunks.push(e.data); };
    recorder.start();
    btnRec.style.display  = 'none';
    btnStop.style.display = 'block';
    status.innerHTML = '<span class="dot"></span>Recording…';
  } catch(e) {
    status.textContent = 'Mic error: ' + e.message;
  }
};

btnStop.onclick = () => {
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    status.textContent = 'Sending…';
    try {
      await fetch('/audio', { method:'POST', headers:{'Content-Type': blob.type}, body: blob });
      status.textContent = '✓ Sent! You can close this tab.';
      btnStop.style.display = 'none';
    } catch(e) {
      status.textContent = 'Send error: ' + e.message;
    }
  };
  recorder.stop();
};
</script>
</body>
</html>`;

/**
 * Lightweight HTTP server that:
 *  GET  /capture → serves the mic-capture page (in system browser, which has real mic access)
 *  POST /audio   → receives the recorded audio blob and calls onAudio
 */
export class LocalAudioServer {
  private server: http.Server | null = null;
  private port = 0;
  private onAudio: AudioCallback | null = null;

  async start(onAudio: AudioCallback): Promise<number> {
    this.onAudio = onAudio;
    this.port    = await this.findFreePort();

    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/capture') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(CAPTURE_HTML);
        return;
      }

      if (req.method === 'POST' && req.url === '/audio') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const mimeType = req.headers['content-type'] || 'audio/webm';
          const buf      = Buffer.concat(chunks);
          this.onAudio?.(buf, mimeType);
          res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
          res.end('ok');
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) =>
      this.server!.listen(this.port, '127.0.0.1', resolve),
    );

    return this.port;
  }

  get captureUrl(): string {
    return `http://127.0.0.1:${this.port}/capture`;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
      srv.on('error', reject);
    });
  }
}
