import * as vscode from 'vscode';
import { VTPPanel } from './panel/VTPPanel';
import { SecretManager } from './config/SecretManager';
import { ensurePatched, restoreOriginal, getStatus } from './integrations/claudeCode/patcher';
import { pickAndLockConversation, getLockedTitle, setLockedTitle, listClaudeConversations } from './integrations/claudeCode/conversations';

let panel: VTPPanel | undefined;
export let logger: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  // Output channel — visible via View → Output → "VTP"
  logger = vscode.window.createOutputChannel('VTP');
  context.subscriptions.push(logger);
  logger.appendLine('[VTP] Extension activating...');

  const secretManager = new SecretManager(context.secrets);
  // Pass globalState so VTPPanel can persist the onboarding-complete flag
  panel = new VTPPanel(context.extensionUri, secretManager, logger, context.globalState);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VTPPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.openPanel', () => {
      vscode.commands.executeCommand('workbench.view.extension.vtp-sidebar');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.setApiKey', async () => {
      const key = await secretManager.promptForApiKey();
      if (key) {
        logger.appendLine('[VTP] API key saved.');
        vscode.window.showInformationMessage('VTP: Gemini API key saved.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.stopRecording', () => {
      logger.appendLine('[VTP] Stop recording command invoked.');
    }),
  );

  // ── vtp.toggleRecording — bound to Ctrl+Shift+Space via contributes.keybindings ──
  // Users can remap via: Keyboard Shortcuts editor → search "VTP: Toggle Recording"
  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.toggleRecording', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.vtp-sidebar');
      panel?.toggleRecording();
    }),
  );

  // ── Claude Code integration commands ────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.switchTarget', async () => {
      const cfg = vscode.workspace.getConfiguration('vtp');
      const current = cfg.get<string>('injectionTarget', 'antigravity');
      const pick = await vscode.window.showQuickPick([
        { label: 'Antigravity', description: 'Native Antigravity chat (default)', value: 'antigravity', picked: current === 'antigravity' },
        { label: 'Claude Code', description: 'Anthropic Claude Code extension (requires patch + Deepgram)', value: 'claude-code', picked: current === 'claude-code' },
      ], { title: 'VTP — Where do prompts go?', placeHolder: 'Select injection target' });
      if (!pick) return;
      await cfg.update('injectionTarget', pick.value, vscode.ConfigurationTarget.Global);
      logger.appendLine(`[VTP] injection target → ${pick.value}`);
      if (pick.value === 'claude-code') {
        await ensureDeepgramForClaudeCode(secretManager, logger);
      }
      vscode.window.showInformationMessage(`VTP: target switched to ${pick.label}.`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.patchClaudeCode', async () => {
      try {
        const applied = await ensurePatched((m) => logger.appendLine(m));
        const status = getStatus();
        if (!status.installed) {
          vscode.window.showWarningMessage('VTP: Claude Code extension not installed.');
          return;
        }
        if (applied) {
          vscode.window.showInformationMessage(
            `VTP: Claude Code v${status.version} patched. Reload Window to activate.`,
            'Reload Window',
          ).then((a) => { if (a === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow'); });
        } else {
          vscode.window.showInformationMessage(`VTP: Claude Code v${status.version} already patched ✓`);
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`VTP: patch failed — ${e?.message ?? e}`);
        logger.appendLine(`[VTP] patch failed: ${e?.stack ?? e}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.restoreClaudeCode', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Restore Claude Code to its pre-VTP state? This rolls back to the most recent backup.',
        { modal: true },
        'Restore',
      );
      if (confirm !== 'Restore') return;
      try {
        const ok = await restoreOriginal((m) => logger.appendLine(m));
        if (ok) {
          vscode.window.showInformationMessage('VTP: Claude Code restored. Reload Window to apply.', 'Reload Window')
            .then((a) => { if (a === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow'); });
        } else {
          vscode.window.showWarningMessage('VTP: nothing to restore (no backups found or extension not installed).');
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`VTP: restore failed — ${e?.message ?? e}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.claudeCodeStatus', async () => {
      const s = getStatus();
      if (!s.installed) {
        vscode.window.showInformationMessage('VTP: Claude Code extension not installed.');
        return;
      }
      const locked = getLockedTitle();
      const line1 = `Claude Code v${s.version} — ${s.patched ? 'patched ✓' : 'unpatched'}`;
      const line2 = s.marker?.appliedAt ? `Patched at ${s.marker.appliedAt}` : '';
      const line3 = locked ? `Locked to: "${locked}"` : 'Lock: none (fans to all chats)';
      vscode.window.showInformationMessage(`VTP: ${line1}\n${line2}\n${line3}`.trim());
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.lockClaudeConversation', async () => {
      await pickAndLockConversation();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.unlockClaudeConversation', async () => {
      const current = getLockedTitle();
      if (!current) {
        vscode.window.showInformationMessage('VTP: No conversation is currently locked.');
        return;
      }
      await setLockedTitle('');
      vscode.window.showInformationMessage(`VTP: unlocked (was "${current}").`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.listClaudeConversations', async () => {
      const convs = await listClaudeConversations();
      if (convs.length === 0) {
        vscode.window.showInformationMessage('VTP: No Claude Code conversation tabs are open.');
        return;
      }
      const locked = getLockedTitle();
      const lines = convs.map((c) =>
        `${c.title === locked ? '🔒 ' : '   '}${c.isActive ? '★ ' : '  '}${c.title}`,
      );
      vscode.window.showInformationMessage('VTP: Open Claude conversations:\n' + lines.join('\n'));
    }),
  );

  // Auto-patch on startup (idempotent, throws only on anchor mismatch)
  ensurePatched((m) => logger.appendLine(m)).catch((e) => {
    logger.appendLine(`[VTP] auto-patch error: ${e?.message ?? e}`);
  });

  // Watch for target setting changes — enforce Deepgram for claude-code + refresh panel UI
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((evt) => {
      const targetChanged = evt.affectsConfiguration('vtp.injectionTarget');
      const lockChanged   = evt.affectsConfiguration('vtp.claudeCodeLockedTitle');
      if (targetChanged) {
        const target = vscode.workspace.getConfiguration('vtp').get<string>('injectionTarget', 'antigravity');
        if (target === 'claude-code') {
          ensureDeepgramForClaudeCode(secretManager, logger).catch(() => {});
        }
      }
      if (targetChanged || lockChanged) {
        panel?.sendTargetState().catch(() => {});
      }
    }),
  );

  logger.appendLine('[VTP] Extension activated successfully.');
}

/**
 * When the user routes prompts to Claude Code, force the Deepgram engine.
 * If the Deepgram key isn't configured, trigger the existing onboarding via
 * VTP: Set Deepgram Key flow. If they decline, revert the target.
 */
async function ensureDeepgramForClaudeCode(
  secretManager: SecretManager,
  log: vscode.OutputChannel,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('vtp');
  const dgKey = await secretManager.getSecret('vtp.deepgramApiKey');
  if (!dgKey) {
    const action = await vscode.window.showWarningMessage(
      'Claude Code target requires Deepgram for low-latency voice commands. Set up your Deepgram key now?',
      'Set Up Deepgram',
      'Revert to Antigravity',
    );
    if (action === 'Revert to Antigravity') {
      await cfg.update('injectionTarget', 'antigravity', vscode.ConfigurationTarget.Global);
      log.appendLine('[VTP] reverted target → antigravity (no Deepgram key)');
      return;
    }
    if (action === 'Set Up Deepgram') {
      // Open the existing Deepgram key entry flow via the panel command.
      // The user goes through SettingsManager.handleDeepgramKey() which both
      // stores the key and switches transcriptionEngine to deepgram.
      await vscode.commands.executeCommand('workbench.view.extension.vtp-sidebar');
      vscode.window.showInformationMessage('VTP: Click DG in the panel to enter your Deepgram key.');
    }
    return;
  }
  const engine = cfg.get<string>('transcriptionEngine', 'gemini');
  if (engine !== 'deepgram') {
    await cfg.update('transcriptionEngine', 'deepgram', vscode.ConfigurationTarget.Global);
    log.appendLine('[VTP] forced transcriptionEngine → deepgram (Claude Code target)');
    vscode.window.showInformationMessage('VTP: switched to Deepgram engine for Claude Code target.');
  }
}

export function deactivate(): void {
  panel?.dispose();
  logger?.appendLine('[VTP] Extension deactivated.');
}
