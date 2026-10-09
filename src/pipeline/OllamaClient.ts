import * as http from 'http';

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;

export interface OllamaGenerateOptions {
  system?: string;
  temperature?: number;
  timeoutMs?: number;
}

export class OllamaClient {
  constructor(
    private readonly model: string,
    private readonly host: string = OLLAMA_HOST,
    private readonly port: number = OLLAMA_PORT,
  ) {}

  private request(path: string, body: unknown, timeoutMs = 20_000): Promise<any> {
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`Ollama HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
              return;
            }
            try {
              resolve(JSON.parse(raw));
            } catch (e) {
              reject(new Error(`Ollama returned non-JSON: ${raw.slice(0, 200)}`));
            }
          });
        },
      );
      req.on('timeout', () => { req.destroy(new Error('Ollama request timed out')); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  private get(path: string, timeoutMs = 2_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: this.host, port: this.port, path, method: 'GET', timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try { resolve(JSON.parse(raw)); } catch { resolve({}); }
          });
        },
      );
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
      req.end();
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const tags = await this.get('/api/tags');
      return Array.isArray(tags?.models) && tags.models.length > 0;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const tags = await this.get('/api/tags');
      return (tags?.models ?? []).map((m: any) => m.name).filter(Boolean);
    } catch {
      return [];
    }
  }

  async generate(prompt: string, opts: OllamaGenerateOptions = {}): Promise<string> {
    const res = await this.request(
      '/api/generate',
      {
        model: this.model,
        prompt,
        system: opts.system,
        stream: false,
        options: { temperature: opts.temperature ?? 0 },
      },
      opts.timeoutMs ?? 20_000,
    );
    return String(res?.response ?? '').trim();
  }
}
