import * as vscode from 'vscode';
import { VTPPanel } from './panel/VTPPanel';
import { VoskModelManager } from './audio/VoskModelManager';
import { ensurePatched, restoreOriginal, getStatus } from './integrations/claudeCode/patcher';
import { pickAndLockConversation, getLockedTitle, setLockedTitle, listClaudeConversations } from './integrations/claudeCode/conversations';
import { TeeChannel } from './util/DebugLog';
import { checkHealth, describeHealth, healthFile } from './integrations/claudeCode/health';
import { Inbox } from './integrations/inbox';
import { KeepPatched } from './integrations/claudeCode/keepPatched';

let panel: VTPPanel | undefined;
export let logger: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  logger = new TeeChannel(vscode.window.createOutputChannel('VTP'));
  context.subscriptions.push(logger);
  logger.appendLine('[VTP] Extension activating (fully-local build)...');
  logger.appendLine(
    `[VTP] env: ${vscode.env.appName} ${vscode.version} · node ${process.version} · ` +
    `${process.platform}/${process.arch} · ext ${context.extension.packageJSON.version}`,
  );
  logger.appendLine(`[VTP] debug log mirrored to ${TeeChannel.logPath}`);

  const modelManager = new VoskModelManager(context.globalStorageUri, (m) => logger.appendLine(m));
  panel = new VTPPanel(context.extensionUri, logger, context.globalState, modelManager);

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
    vscode.commands.registerCommand('vtp.toggleRecording', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.vtp-sidebar');
      panel?.toggleRecording();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.openDebugLog', async () => {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(TeeChannel.logPath));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        vscode.window.showWarningMessage(`VTP: no debug log yet at ${TeeChannel.logPath}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.redownloadModel', async () => {
      await modelManager.clearCache();
      vscode.window.showInformationMessage('VTP: Speech model cache cleared. Reload the window to re-download.', 'Reload Window')
        .then((a) => { if (a === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow'); });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.switchTarget', async () => {
      const cfg = vscode.workspace.getConfiguration('vtp');
      const current = cfg.get<string>('injectionTarget', 'antigravity');
      const pick = await vscode.window.showQuickPick([
        { label: 'Antigravity', description: 'Native Antigravity chat (default)', value: 'antigravity', picked: current === 'antigravity' },
        { label: 'Claude Code', description: 'Anthropic Claude Code extension (requires patch)', value: 'claude-code', picked: current === 'claude-code' },
      ], { title: 'VTP — Where do prompts go?', placeHolder: 'Select injection target' });
      if (!pick) return;
      await cfg.update('injectionTarget', pick.value, vscode.ConfigurationTarget.Global);
      logger.appendLine(`[VTP] injection target → ${pick.value}`);
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

  const keep = new KeepPatched((m) => logger.appendLine(m));

  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.checkClaudeCode', async () => {
      const h = await checkHealth();
      logger.appendLine(`[VTP] ${describeHealth(h)}`);
      for (const w of h.wrong) logger.appendLine(`[VTP]   ${w}`);
      logger.appendLine(`[VTP] written to ${healthFile()}`);
      if (h.working) {
        vscode.window.showInformationMessage(describeHealth(h));
      } else {
        vscode.window.showErrorMessage(describeHealth(h), 'Re-apply patch', 'Show log').then(async (a) => {
          if (a === 'Re-apply patch') await vscode.commands.executeCommand('vtp.patchClaudeCode');
          if (a === 'Show log') logger.show(true);
        });
      }
    }),
  );

  ensurePatched((m) => logger.appendLine(m))
    .catch((e) => {
      logger.appendLine(`[VTP] auto-patch error: ${e?.message ?? e}`);
    })
    .then(() => checkHealth())
    .then((h) => {
      logger.appendLine(`[VTP] ${describeHealth(h)}`);
      for (const w of h.wrong) logger.appendLine(`[VTP]   ${w}`);
      if (!h.working && h.claudeCode.dir) {
        const filesFine = Object.values(h.patches).every((s) => s === 'applied');
        if (filesFine && !h.commands.inject) {
          void keep.offerReload('VTP has patched Claude Code, but this window started before the patch. Reload to use it.');
        } else {
          vscode.window.showWarningMessage(describeHealth(h), 'Re-apply patch').then(async (a) => {
            if (a === 'Re-apply patch') await vscode.commands.executeCommand('vtp.patchClaudeCode');
          });
        }
      }
    })
    .catch(() => {});

  const inbox = new Inbox((m) => logger.appendLine(m));
  inbox.start();
  context.subscriptions.push({ dispose: () => inbox.dispose() });

  keep.start();
  context.subscriptions.push({ dispose: () => keep.dispose() });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((evt) => {
      if (evt.affectsConfiguration('vtp.injectionTarget') || evt.affectsConfiguration('vtp.claudeCodeLockedTitle')) {
        panel?.sendTargetState().catch(() => {});
      }
    }),
  );

  logger.appendLine('[VTP] Extension activated successfully.');
}

export function deactivate(): void {
  panel?.dispose();
  logger?.appendLine('[VTP] Extension deactivated.');
}
