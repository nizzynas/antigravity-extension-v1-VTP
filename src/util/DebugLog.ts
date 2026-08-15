import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * TeeChannel — the VTP Output channel, mirrored to a file on disk.
 *
 * The Output panel can only be read inside the IDE, which makes "what happened
 * while you were trying it" impossible to answer after the fact. Everything
 * written here also lands, timestamped, in ~/.vtp/vtp-debug.log, so a session
 * can be read (or tailed live) from a terminal.
 *
 * Writes are synchronous on purpose: a hang or a force-quit must not swallow
 * the last few lines, which are usually the interesting ones.
 */
export class TeeChannel implements vscode.OutputChannel {
  static readonly logPath = path.join(os.homedir(), '.vtp', 'vtp-debug.log');

  /** Cleared once the file turns out to be unwritable, so we stop retrying. */
  private mirroring = true;

  constructor(private readonly inner: vscode.OutputChannel) {
    try {
      fs.mkdirSync(path.dirname(TeeChannel.logPath), { recursive: true });
      // Start each session clean — stale runs only make the trail harder to read.
      fs.writeFileSync(TeeChannel.logPath, '');
    } catch {
      this.mirroring = false;
    }
  }

  get name(): string {
    return this.inner.name;
  }

  private static stamp(): string {
    const t = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}.${p(t.getMilliseconds(), 3)}`;
  }

  private mirror(text: string): void {
    if (!this.mirroring) return;
    try {
      fs.appendFileSync(TeeChannel.logPath, `${TeeChannel.stamp()} ${text}\n`);
    } catch {
      this.mirroring = false;
    }
  }

  append(value: string): void {
    this.inner.append(value);
    this.mirror(value);
  }

  appendLine(value: string): void {
    this.inner.appendLine(value);
    this.mirror(value);
  }

  replace(value: string): void {
    this.inner.replace(value);
    this.mirror(value);
  }

  clear(): void {
    this.inner.clear();
  }

  show(...args: unknown[]): void {
    (this.inner.show as (...a: unknown[]) => void)(...args);
  }

  hide(): void {
    this.inner.hide();
  }

  dispose(): void {
    this.inner.dispose();
  }
}
