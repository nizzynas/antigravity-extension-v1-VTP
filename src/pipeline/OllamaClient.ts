/**
 * OllamaClient — optional local LLM used for prompt enhancement / heavy cleanup.
 *
 * Ollama is a fully-local model runner (https://ollama.com). It exposes an HTTP
 * API on 127.0.0.1:11434 and requires NO API key. VTP uses it ONLY when it is
 * already running on the machine; if it is absent, every caller falls back to a
 * pure-regex local pass. Nothing is ever sent off the machine.
 */

import * as http from 'http';

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;

export interface OllamaGenerateOptions {
  /** System instruction prepended to the model context. */
  system?: string;
  /** Sampling temperature. Defaults to 0 for deterministic rewrites. */
  temperature?: number;
  /** Hard timeout in ms. Defaults to 20s. */
  timeoutMs?: number;
}

export class OllamaClient {
  constructor(
    /** Model tag to use, e.g. "llama3.2", "qwen2.5:3b". */
    private readonly model: string,
    private readonly host: string = OLLAMA_HOST,
    private readonly port: number = OLLAMA_PORT,
  ) {}

  /** Low-level POST helper against the local Ollama daemon. */
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

  /** GET helper (used for availability / model list). */
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

  /**
   * True if a local Ollama daemon is reachable AND has at least one model.
   * Fast (2s timeout) so callers can gate cheaply on every use.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const tags = await this.get('/api/tags');
      return Array.isArray(tags?.models) && tags.models.length > 0;
    } catch {
      return false;
    }
  }

  /** Returns installed model tags, or [] if the daemon is unreachable. */
  async listModels(): Promise<string[]> {
    try {
      const tags = await this.get('/api/tags');
      return (tags?.models ?? []).map((m: any) => m.name).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Single-shot generation. Returns the trimmed completion text.
   * Throws if the daemon is unreachable or the model is missing — callers
   * are expected to catch and fall back to a local regex pass.
   */
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
