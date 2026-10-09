import * as vscode from 'vscode';
import type { InjectionTarget } from '../types';
import { getLockedTitle } from '../integrations/claudeCode/conversations';

export class ChatInjector {
  private readonly antigravity = new AntigravityStrategy();
  private readonly claudeCode  = new ClaudeCodeStrategy();

  static currentTarget(): InjectionTarget {
    const t = vscode.workspace.getConfiguration('vtp').get<string>('injectionTarget', 'antigravity');
    return t === 'claude-code' ? 'claude-code' : 'antigravity';
  }

  async inject(prompt: string, submit = true): Promise<void> {
    const target = ChatInjector.currentTarget();
    if (target === 'claude-code') {
      await this.claudeCode.inject(prompt, submit);
    } else {
      await this.antigravity.inject(prompt, submit);
    }
  }

  async submitOnly(): Promise<void> {
    const target = ChatInjector.currentTarget();
    if (target === 'claude-code') {
      await this.claudeCode.submitOnly();
    } else {
    }
  }
}

class AntigravityStrategy {
  private didLogCommands = false;

  async inject(prompt: string, submit = true): Promise<void> {
    if (!this.didLogCommands) {
      this.didLogCommands = true;
      await this.logAntigravityCommands();
    }

    const sent = await this.trySendPromptCommand(prompt);
    if (sent) return;

    await vscode.env.clipboard.writeText(prompt);
    await this.focusAntigravityPanel();

    const action = await vscode.window.showInformationMessage(
      '⚡ VTP: Prompt copied — press Ctrl+V to paste into Antigravity.',
      'Copy Again',
    );
    if (action === 'Copy Again') {
      await vscode.env.clipboard.writeText(prompt);
    }
    void submit;
  }

  private async trySendPromptCommand(prompt: string): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', prompt);
      return true;
    } catch {
      return false;
    }
  }

  private async focusAntigravityPanel(): Promise<void> {
    const candidates = ['antigravity.agentSidePanel.focus', 'antigravity.openAgent'];
    for (const cmd of candidates) {
      try { await vscode.commands.executeCommand(cmd); return; } catch {}
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
    } catch {}
  }
}

class ClaudeCodeStrategy {
  async inject(prompt: string, submit = true): Promise<void> {
    const targetTitle = getLockedTitle();
    const ok = await this.tryInjectCommand(prompt, submit, targetTitle);
    if (ok) return;

    vscode.window.showErrorMessage(
      'VTP: Claude Code injection command not found. Run "VTP: Re-apply Claude Code Patch" or switch target to Antigravity.',
      'Re-apply Patch',
      'Switch to Antigravity',
    ).then(async (action) => {
      if (action === 'Re-apply Patch') {
        await vscode.commands.executeCommand('vtp.patchClaudeCode');
      } else if (action === 'Switch to Antigravity') {
        await vscode.workspace.getConfiguration('vtp')
          .update('injectionTarget', 'antigravity', vscode.ConfigurationTarget.Global);
      }
    });
  }

  async submitOnly(): Promise<void> {
    const targetTitle = getLockedTitle();
    try {
      await vscode.commands.executeCommand('claude-code.submitVTP', targetTitle);
    } catch (e: any) {
      vscode.window.showErrorMessage('VTP: claude-code.submitVTP failed: ' + (e?.message ?? e));
    }
  }

  private async tryInjectCommand(prompt: string, submit: boolean, targetTitle: string): Promise<boolean> {
    try {
      await vscode.commands.executeCommand('claude-code.injectPromptVTP', prompt, submit, targetTitle);
      return true;
    } catch {
      return false;
    }
  }
}
