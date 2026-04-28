import * as vscode from 'vscode';

/**
 * Injects the final elaborated prompt into the Antigravity chat.
 *
 * Tries Antigravity's native command first, then clipboard + focus fallback.
 */
export class ChatInjector {
  /** Cached Antigravity command, discovered once per session */
  private antigravityCommand: string | null | undefined = undefined;

  async inject(prompt: string): Promise<void> {
    const cmd = await this.findAntigravityCommand();

    if (cmd) {
      try {
        await vscode.commands.executeCommand(cmd, prompt);
        return;
      } catch {
        // Command found but failed — fall through to clipboard
      }
    }

    await this.clipboardFallback(prompt);
  }

  private async findAntigravityCommand(): Promise<string | null> {
    if (this.antigravityCommand !== undefined) {
      return this.antigravityCommand;
    }

    const all = await vscode.commands.getCommands(true);
    const candidate = all.find(
      (c) =>
        c.toLowerCase().includes('antigravity') &&
        (c.toLowerCase().includes('insert') ||
          c.toLowerCase().includes('chat') ||
          c.toLowerCase().includes('send') ||
          c.toLowerCase().includes('prompt')),
    );

    this.antigravityCommand = candidate ?? null;
    return this.antigravityCommand;
  }

  private async clipboardFallback(prompt: string): Promise<void> {
    await vscode.env.clipboard.writeText(prompt);

    const action = await vscode.window.showInformationMessage(
      'VTP: Prompt copied to clipboard — paste it into Antigravity chat.',
      'Open Chat Panel',
    );

    if (action === 'Open Chat Panel') {
      // Try to focus the Antigravity sidebar
      const all = await vscode.commands.getCommands(true);
      const focusCmd = all.find(
        (c) =>
          c.toLowerCase().includes('antigravity') &&
          c.toLowerCase().includes('focus'),
      );
      if (focusCmd) {
        await vscode.commands.executeCommand(focusCmd);
      }
    }
  }
}
