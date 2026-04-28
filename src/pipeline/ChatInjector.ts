import * as vscode from 'vscode';

/**
 * Injects the final prompt into Antigravity chat.
 *
 * Strategy:
 *  1. Focus the Antigravity agent side panel (non-destructive — never opens a new chat)
 *  2. Write prompt to clipboard
 *  3. Show a brief toast: "Prompt copied — Ctrl+V to paste"
 *
 * NOTE: VS Code sandboxing prevents any extension from writing directly into
 * another extension's webview input. Clipboard is the only reliable bridge.
 *
 * The command `antigravity.sendPromptToAgentPanel` is intentionally skipped —
 * it does NOT accept a plain string argument and sends terminal/context
 * references instead of the prompt text.
 */
export class ChatInjector {
  private didLogCommands = false;

  async inject(prompt: string): Promise<void> {
    // Log Antigravity commands once per session (for debugging/future wiring)
    if (!this.didLogCommands) {
      this.didLogCommands = true;
      await this.logAntigravityCommands();
    }

    await this.focusAntigravityPanel();
    await vscode.env.clipboard.writeText(prompt);

    const action = await vscode.window.showInformationMessage(
      '⚡ VTP: Prompt copied — press Ctrl+V to paste into Antigravity.',
      'Copy Again',
    );

    if (action === 'Copy Again') {
      await vscode.env.clipboard.writeText(prompt);
    }
  }

  /**
   * Focuses the Antigravity agent side panel without opening a new chat.
   * Uses the dedicated focus command if available.
   */
  private async focusAntigravityPanel(): Promise<void> {
    // These commands focus the existing panel — they do NOT create a new chat
    const FOCUS_COMMANDS = [
      'antigravity.agentSidePanel.focus',
      'antigravity.toggleChatFocus',
      'antigravity.openAgent',
    ];

    for (const cmd of FOCUS_COMMANDS) {
      try {
        await vscode.commands.executeCommand(cmd);
        return;
      } catch {
        // Try next
      }
    }
  }

  /**
   * Logs all registered Antigravity commands to the VTP Debug output channel.
   * Useful for discovering new commands to wire in future versions.
   */
  private async logAntigravityCommands(): Promise<void> {
    try {
      const all = await vscode.commands.getCommands(true);
      const agCmds = all.filter((c) => c.toLowerCase().startsWith('antigravity'));
      if (agCmds.length > 0) {
        const channel = vscode.window.createOutputChannel('VTP Debug');
        channel.appendLine('[VTP ChatInjector] Antigravity commands found:');
        agCmds.forEach((c) => channel.appendLine('  ' + c));
      }
    } catch {
      // Non-critical
    }
  }
}
