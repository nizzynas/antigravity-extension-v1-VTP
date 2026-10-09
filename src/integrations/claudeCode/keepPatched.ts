import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { EXT_ROOTS } from './patches';
import { ensurePatched } from './patcher';
import { checkHealth } from './health';

const SETTLE_MS = 4000;

export class KeepPatched {
  private readonly watchers: fs.FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private asked = false;

  constructor(private readonly log: (m: string) => void) {}

  start(): void {
    for (const root of EXT_ROOTS) {
      if (!fs.existsSync(root)) continue;
      try {
        this.watchers.push(fs.watch(root, (_e, name) => {
          if (name && /^anthropic\.claude-code-/i.test(String(name))) this.soon(String(name));
        }));
      } catch {}
    }
    if (this.watchers.length) this.log(`[VTP] watching ${this.watchers.length} extension folder(s) for Claude Code updates`);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers) { try { w.close(); } catch {} }
    this.watchers.length = 0;
  }

  private soon(name: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.catchUp(name);
    }, SETTLE_MS);
  }

  private async catchUp(name: string): Promise<void> {
    try {
      const applied = await ensurePatched(this.log);
      if (!applied) return;
      this.log(`[VTP] ${name} appeared and has been patched`);
      await this.offerReload(`Claude Code updated to a new version. VTP has patched it — reload the window to use it.`);
    } catch (e: any) {
      this.log(`[VTP] could not patch ${name}: ${e?.message ?? e}`);
      vscode.window.showWarningMessage(`VTP: Claude Code updated and the patch no longer fits — ${e?.message ?? e}`);
    }
  }

  async offerReload(message: string): Promise<void> {
    if (this.asked) return;
    const health = await checkHealth();
    if (health.working) return;
    this.asked = true;
    const answer = await vscode.window.showWarningMessage(message, 'Reload window', 'Not now');
    if (answer === 'Reload window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
