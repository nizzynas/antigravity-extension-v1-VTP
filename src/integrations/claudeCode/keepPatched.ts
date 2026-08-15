/**
 * Staying patched across Claude Code updating itself.
 *
 * The IDE loads an extension once, at window start. Claude Code updates by
 * unpacking a whole new folder next to the old one and pointing at it, and the
 * update lands while a window is already open — so the sequence every time is:
 * new version appears, VTP patches it, and the window carries on running the
 * copy it loaded before any of that. The files are perfect and nothing works.
 *
 * Watched twice within one minute here: 2.1.232 arrived, was patched, and
 * 2.1.233 replaced it before the next reload. Reloading to pick up the patch
 * is what installs the next unpatched version, so it never catches up on its
 * own — you are permanently one reload behind, and every reload looks like it
 * should have been the one that worked.
 *
 * Two halves, and it needs both:
 *
 *   watch  — patch a new version the moment it appears on disk, rather than at
 *            the next activation. The window that eventually loads it then
 *            loads something already patched.
 *   ask    — when a patch is applied under a window that has already loaded
 *            the old copy, say so and offer the reload. Silence there is the
 *            whole failure: the log says applied, the marker looks right, and
 *            the only symptom is that nothing happens.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { EXT_ROOTS } from './patches';
import { ensurePatched } from './patcher';
import { checkHealth } from './health';

/** Debounce: an unpack touches the folder many times on its way in. */
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
      } catch { /* a root we cannot watch is one we simply do not */ }
    }
    if (this.watchers.length) this.log(`[VTP] watching ${this.watchers.length} extension folder(s) for Claude Code updates`);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers) { try { w.close(); } catch { /* going away anyway */ } }
    this.watchers.length = 0;
  }

  /**
   * Check once the dust settles.
   *
   * An update writes hundreds of files; patching partway through would read a
   * half-unpacked extension.js and find no anchors, which reports as a build
   * we cannot patch when in fact we looked too early.
   */
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

  /**
   * The patch is on disk but not in this window. Offer the reload once.
   *
   * Once, because a prompt that comes back every time something touches the
   * extensions folder is a prompt that gets dismissed on reflex, including the
   * time it mattered.
   */
  async offerReload(message: string): Promise<void> {
    if (this.asked) return;
    const health = await checkHealth();
    if (health.working) return;
    this.asked = true;
    const answer = await vscode.window.showWarningMessage(message, 'Reload window', 'Not now');
    if (answer === 'Reload window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
