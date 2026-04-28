import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CustomCommand } from '../types';

/**
 * Loads and provides access to user-defined voice commands from commands.json.
 * The file lives at the workspace root and is hot-reloaded on change.
 */
export class CommandRegistry {
  private commands: CustomCommand[] = [];
  private watcher: vscode.FileSystemWatcher | null = null;

  constructor(private readonly workspaceRoot: string | null) {}

  /** Load commands and set up a file watcher for hot-reload */
  initialize(): void {
    this.load();

    if (!this.workspaceRoot) return;

    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, 'commands.json'),
    );
    this.watcher.onDidChange(() => this.load());
    this.watcher.onDidCreate(() => this.load());
  }

  getCommands(): CustomCommand[] {
    return this.commands;
  }

  dispose(): void {
    this.watcher?.dispose();
  }

  private load(): void {
    const filePath = this.workspaceRoot
      ? path.join(this.workspaceRoot, 'commands.json')
      : null;

    if (!filePath || !fs.existsSync(filePath)) {
      this.commands = [];
      return;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      this.commands = JSON.parse(raw) as CustomCommand[];
    } catch (err) {
      console.error('[VTP] Failed to parse commands.json:', err);
      this.commands = [];
    }
  }
}
