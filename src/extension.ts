import * as vscode from 'vscode';
import { VTPPanel } from './panel/VTPPanel';
import { SecretManager } from './config/SecretManager';

let panel: VTPPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const secretManager = new SecretManager(context.secrets);
  panel = new VTPPanel(context.extensionUri, secretManager);

  // Register the Webview sidebar provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VTPPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Command: open the VTP sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.openPanel', () => {
      vscode.commands.executeCommand('workbench.view.extension.vtp-sidebar');
    }),
  );

  // Command: update API key
  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.setApiKey', async () => {
      await secretManager.promptForApiKey();
      vscode.window.showInformationMessage('VTP: Gemini API key saved.');
    }),
  );

  // Command: stop recording (can be invoked by voice command or UI)
  context.subscriptions.push(
    vscode.commands.registerCommand('vtp.stopRecording', () => {
      // Panel handles this internally via its webview
    }),
  );

  console.log('[VTP] Extension activated.');
}

export function deactivate(): void {
  panel?.dispose();
}
