import * as vscode from 'vscode';
import * as path from 'path';
import { CustomCommand } from '../types';

/**
 * Resolves a free-form command intent (e.g. "pull up the landing page")
 * and executes the best matching VS Code action.
 *
 * Priority:
 *   1. User-defined custom commands (commands.json)
 *   2. Inferred VS Code / browser actions
 *   3. Fallback: send intent as a standalone prompt to Antigravity
 */
export class CommandExecutor {
  constructor(private readonly customCommands: CustomCommand[]) {}

  async execute(intent: string): Promise<string> {
    const lower = intent.toLowerCase();

    // 1. Check user-defined custom commands
    const custom = this.matchCustomCommand(lower);
    if (custom) {
      return this.runCustomCommand(custom, intent);
    }

    // 2. Infer built-in actions
    if (this.matches(lower, ['open in browser', 'pull up', 'show me the app', 'show me the page', 'open the app', 'open the site', 'show me the site'])) {
      return this.openInBrowser(intent);
    }

    if (this.matches(lower, ['open file', 'open the file', 'show me the file', 'go to file'])) {
      return this.openFile(intent);
    }

    if (this.matches(lower, ['open terminal', 'open the terminal', 'new terminal'])) {
      await vscode.commands.executeCommand('workbench.action.terminal.new');
      return 'Opened a new terminal.';
    }

    if (this.matches(lower, ['pause', 'stop listening', 'pause vtp', 'stop vtp'])) {
      await vscode.commands.executeCommand('vtp.stopRecording');
      return 'VTP paused.';
    }

    // 3. Fallback — send intent directly to Antigravity as a quick standalone prompt
    return this.sendToAntigravity(intent);
  }

  private matchCustomCommand(lower: string): CustomCommand | null {
    for (const cmd of this.customCommands) {
      if (cmd.triggers.some((t) => lower.includes(t.toLowerCase()))) {
        return cmd;
      }
    }
    return null;
  }

  private async runCustomCommand(cmd: CustomCommand, _intent: string): Promise<string> {
    switch (cmd.action) {
      case 'terminal': {
        const terminal = vscode.window.createTerminal('VTP');
        terminal.show();
        terminal.sendText(cmd.run ?? '');
        return `Running: ${cmd.run}`;
      }
      case 'browser': {
        if (cmd.url) {
          await vscode.commands.executeCommand('simpleBrowser.show', cmd.url);
          return `Opened browser: ${cmd.url}`;
        }
        return 'No URL specified for this command.';
      }
      case 'antigravity':
        return this.sendToAntigravity(cmd.prompt ?? _intent);
    }
  }

  private async openInBrowser(intent: string): Promise<string> {
    const url = this.inferDevUrl();
    if (url) {
      await vscode.commands.executeCommand('simpleBrowser.show', url);
      return `Opened ${url} in the Simple Browser.`;
    }
    // Fallback: let Antigravity handle it
    return this.sendToAntigravity(intent);
  }

  private async openFile(intent: string): Promise<string> {
    // Try to extract a filename from the intent
    const knownExtensions = ['.tsx', '.ts', '.js', '.jsx', '.css', '.json', '.md'];
    for (const ext of knownExtensions) {
      const match = intent.match(new RegExp(`([\\w-]+${ext.replace('.', '\\.')})`, 'i'));
      if (match) {
        const files = await vscode.workspace.findFiles(`**/${match[1]}`, '**/node_modules/**', 1);
        if (files.length) {
          await vscode.window.showTextDocument(files[0]);
          return `Opened ${path.basename(files[0].fsPath)}.`;
        }
      }
    }
    // Quick open picker as fallback
    await vscode.commands.executeCommand('workbench.action.quickOpen');
    return 'Opened file picker.';
  }

  private inferDevUrl(): string | null {
    // Try common dev server ports
    const ports = [3000, 3001, 5173, 8080, 4200, 8000];
    // In a more advanced version, parse package.json scripts for port hints
    return `http://localhost:${ports[0]}`;
  }

  private async sendToAntigravity(prompt: string): Promise<string> {
    await vscode.env.clipboard.writeText(prompt);
    // Try to find and focus Antigravity's chat panel
    const allCommands = await vscode.commands.getCommands(true);
    const agCmd = allCommands.find(
      (c) =>
        c.includes('antigravity') &&
        (c.includes('chat') || c.includes('insert') || c.includes('focus')),
    );

    if (agCmd) {
      await vscode.commands.executeCommand(agCmd, prompt);
      return `Sent to Antigravity: "${prompt.slice(0, 60)}..."`;
    }

    // Clipboard fallback
    vscode.window.showInformationMessage(
      `VTP copied a command to clipboard — paste it into Antigravity chat.`,
    );
    return `Copied to clipboard: "${prompt.slice(0, 60)}..."`;
  }

  private matches(lower: string, phrases: string[]): boolean {
    return phrases.some((p) => lower.includes(p));
  }
}
