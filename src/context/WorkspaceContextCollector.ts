import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContext } from '../types';

const MAX_FILE_CHARS = 8_000;
const MAX_EDITOR_CHARS = 3_000;
const MAX_DIFF_CHARS = 3_000;
const MAX_OPEN_EDITORS = 5;

/**
 * Collects workspace context to inject into Gemini prompts.
 * Includes: active file, open editors, git diff, and package.json metadata.
 */
export class WorkspaceContextCollector {
  async collect(): Promise<WorkspaceContext> {
    const [activeFile, openEditors, gitDiff, projectMeta] = await Promise.all([
      this.getActiveFile(),
      this.getOpenEditors(),
      this.getGitDiff(),
      this.getProjectMeta(),
    ]);

    return {
      workspaceName: this.getWorkspaceName(),
      activeFile,
      openEditors,
      gitDiff,
      projectMeta,
    };
  }

  private getWorkspaceName(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? path.basename(folder.uri.fsPath) : 'Unknown Workspace';
  }

  private async getActiveFile(): Promise<WorkspaceContext['activeFile']> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    return {
      path: editor.document.uri.fsPath,
      content: editor.document.getText().slice(0, MAX_FILE_CHARS),
      language: editor.document.languageId,
    };
  }

  private async getOpenEditors(): Promise<{ path: string; content: string }[]> {
    return vscode.workspace.textDocuments
      .filter((doc) => !doc.isClosed && doc.uri.scheme === 'file')
      .slice(0, MAX_OPEN_EDITORS)
      .map((doc) => ({
        path: doc.uri.fsPath,
        content: doc.getText().slice(0, MAX_EDITOR_CHARS),
      }));
  }

  private getGitDiff(): Promise<string> {
    return new Promise((resolve) => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) {
        resolve('');
        return;
      }
      cp.exec('git diff HEAD', { cwd }, (err, stdout) => {
        resolve(err ? '' : stdout.slice(0, MAX_DIFF_CHARS));
      });
    });
  }

  private getProjectMeta(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return '';
    const pkgPath = path.join(folder, 'package.json');
    try {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw);
      return JSON.stringify(
        {
          name: pkg.name,
          scripts: pkg.scripts,
          dependencies: Object.keys(pkg.dependencies ?? {}).slice(0, 20),
        },
        null,
        2,
      );
    } catch {
      return '';
    }
  }
}
