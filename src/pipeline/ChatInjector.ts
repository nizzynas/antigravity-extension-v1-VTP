import * as vscode from 'vscode';

/**
 * Injects the final prompt into Antigravity chat.
 *
 * Strategy (in order of preference):
 *  1. Try `antigravity.sendPromptToAgentPanel` with the prompt string as arg
 *     — this command IS able to write to the chat input (we've seen it write text).
 *     We call it WITHOUT pre-focusing the panel to avoid the auto-attach
 *     behavior that prepended `@terminal:powershell` last time.
 *  2. Fallback: clipboard + show "Ctrl+V" notification with panel focus
 */
export class ChatInjector {
  private didLogCommands = false;

  async inject(prompt: string): Promise<void> {
    if (!this.didLogCommands) {
      this.didLogCommands = true;
      await this.logAntigravityCommands();
    }

    // ── Attempt 1: sendPromptToAgentPanel with our text as argument ──────────
    // The @terminal:powershell that appeared before was caused by focusing the
    // panel FIRST (which triggered Antigravity's auto-attach). Calling the
    // command directly with text — no pre-focus — should send clean text.
    const sent = await this.trySendPromptCommand(prompt);
    if (sent) return;

    // ── Attempt 2: Clipboard + focus + Ctrl+V notification ───────────────────
    await vscode.env.clipboard.writeText(prompt);
    await this.focusAntigravityPanel();

    const action = await vscode.window.showInformationMessage(
      '⚡ VTP: Prompt copied — press Ctrl+V to paste into Antigravity.',
      'Copy Again',
    );
    if (action === 'Copy Again') {
      await vscode.env.clipboard.writeText(prompt);
    }
  }

  /**
   * Attempts to call antigravity.sendPromptToAgentPanel with the prompt text.
   * Returns true if the command executed without throwing.
   */
  private async trySendPromptCommand(prompt: string): Promise<boolean> {
    try {
      // Pass the prompt string directly as the command argument.
      // Do NOT call agentSidePanel.focus first — that triggers the
      // auto-attach of terminal context (@terminal:powershell).
      await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', prompt);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Focuses the Antigravity agent side panel without triggering context attach.
   * Only used in the clipboard fallback path.
   */
  private async focusAntigravityPanel(): Promise<void> {
    const candidates = [
      'antigravity.agentSidePanel.focus',
      'antigravity.openAgent',
    ];
    for (const cmd of candidates) {
      try { await vscode.commands.executeCommand(cmd); return; } catch { /* next */ }
    }
  }

  private async logAntigravityCommands(): Promise<void> {
    try {
      const all = await vscode.commands.getCommands(true);
      const agCmds = all.filter((c) => c.toLowerCase().startsWith('antigravity'));
      if (agCmds.length > 0) {
        const channel = vscode.window.createOutputChannel('VTP Debug');
        channel.appendLine('[VTP ChatInjector] Antigravity commands found:');
        agCmds.forEach((c) => channel.appendLine('  ' + c));
      }
    } catch { /* non-critical */ }
  }
}
