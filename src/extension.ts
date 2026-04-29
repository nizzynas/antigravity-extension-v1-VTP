import * as vscode from 'vscode';
import { VTPPanel } from './panel/VTPPanel';
import { SecretManager } from './config/SecretManager';

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

  logger.appendLine('[VTP] Extension activated successfully.');
}

export function deactivate(): void {
  panel?.dispose();
  logger?.appendLine('[VTP] Extension deactivated.');
}
