import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tar = require('tar');

const DEFAULT_MODEL_URL =
  'https://alphacephei.com/vosk/models/vosk-model-en-us-0.22-lgraph.zip';

export type StatusFn = (msg: string) => void;
export type ProgressFn = (received: number, total: number | undefined) => void;

export class VoskModelManager {
  constructor(
    public readonly storageUri: vscode.Uri,
    private readonly log: (msg: string) => void,
  ) {}

  private get modelUrl(): string {
    return vscode.workspace
      .getConfiguration('vtp')
      .get<string>('voskModelUrl', DEFAULT_MODEL_URL) || DEFAULT_MODEL_URL;
  }

  private get modelName(): string {
    const base = this.modelUrl.split('/').pop() || 'vosk-model';
    return base.replace(/\.(zip|tar\.gz|tgz)$/i, '');
  }

  get modelPath(): string {
    return path.join(this.storageUri.fsPath, this.modelName + '.tar.gz');
  }

  isCached(): boolean {
    try {
      return fs.existsSync(this.modelPath) && fs.statSync(this.modelPath).size > 5_000_000;
    } catch {
      return false;
    }
  }

  async clearCache(): Promise<void> {
    try { await fs.promises.unlink(this.modelPath); } catch {}
  }

  async ensureModel(onProgress?: ProgressFn, onStatus?: StatusFn): Promise<void> {
    if (this.isCached()) {
      this.log(`[Vosk] Using cached model at ${this.modelPath}`);
      return;
    }
    fs.mkdirSync(this.storageUri.fsPath, { recursive: true });
    const url = this.modelUrl;
    this.log(`[Vosk] Fetching model from ${url}`);
    const buf = await this.download(url, onProgress);

    if (/\.zip$/i.test(url)) {
      onStatus?.('Extracting model…');
      await this.convertZipToTarGz(buf);
    } else {
      const tmp = this.modelPath + '.part';
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, this.modelPath);
    }
    this.log(`[Vosk] Model ready at ${this.modelPath} (${fs.statSync(this.modelPath).size} bytes)`);
  }

  private async convertZipToTarGz(zipBytes: Buffer): Promise<void> {
    const workDir = path.join(os.tmpdir(), `vtp-vosk-${this.modelName}`);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(workDir, { recursive: true });

    this.log('[Vosk] Extracting zip…');
    const zip = new AdmZip(zipBytes);
    zip.extractAllTo(workDir, true);

    const entries = fs.readdirSync(workDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const root = dirs.includes(this.modelName) ? this.modelName : dirs[0];
    if (!root) throw new Error('Extracted zip contained no model directory');
    this.log(`[Vosk] Repacking "${root}" as tar.gz…`);

    const tmpTar = this.modelPath + '.part';
    await tar.create({ gzip: true, cwd: workDir, file: tmpTar, portable: true }, [root]);
    await fs.promises.rename(tmpTar, this.modelPath);

    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }

  private download(url: string, onProgress?: ProgressFn, redirects = 0): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return; }
      https.get(url, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          this.download(next, onProgress, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`Model download failed: HTTP ${status}`));
          return;
        }
        const total = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : undefined;
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (c: Buffer) => { chunks.push(c); received += c.length; onProgress?.(received, total); });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }
}
