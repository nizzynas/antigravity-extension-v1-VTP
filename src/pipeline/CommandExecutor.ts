import * as vscode from 'vscode';
import * as path from 'path';
import { CustomCommand } from '../types';

export class CommandExecutor {
  constructor(private readonly customCommands: CustomCommand[]) {}

  async execute(intent: string): Promise<string> {
    const lower = intent.toLowerCase();

    const custom = this.matchCustomCommand(lower);
    if (custom) {
      return this.runCustomCommand(custom, intent);
    }

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
    return this.sendToAntigravity(intent);
  }

  private async openFile(intent: string): Promise<string> {
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
    await vscode.commands.executeCommand('workbench.action.quickOpen');
    return 'Opened file picker.';
  }

  private inferDevUrl(): string | null {
    const ports = [3000, 3001, 5173, 8080, 4200, 8000];
    return `http://localhost:${ports[0]}`;
  }

  private async sendToAntigravity(prompt: string): Promise<string> {
    await vscode.env.clipboard.writeText(prompt);
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

    vscode.window.showInformationMessage(
      `VTP copied a command to clipboard — paste it into Antigravity chat.`,
    );
    return `Copied to clipboard: "${prompt.slice(0, 60)}..."`;
  }

  private matches(lower: string, phrases: string[]): boolean {
    return phrases.some((p) => lower.includes(p));
  }
}
