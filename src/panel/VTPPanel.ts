import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  PanelMessage,
  ExtensionMessage,
  WorkspaceContext,
  MatchedConversation,
} from '../types';
import { SecretManager } from '../config/SecretManager';
import { WorkspaceContextCollector } from '../context/WorkspaceContextCollector';
import { ConversationMatcher } from '../context/ConversationMatcher';
import { IntentProcessor } from '../pipeline/IntentProcessor';
import { CommandExecutor } from '../pipeline/CommandExecutor';
import { PromptElaborator } from '../pipeline/PromptElaborator';
import { ChatInjector } from '../pipeline/ChatInjector';
import { CommandRegistry } from '../commands/CommandRegistry';
import { VoiceCapture } from '../audio/VoiceCapture';

export class VTPPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'vtp.panel';

  private view?: vscode.WebviewView;
  private promptBuffer = '';
  private cachedContext: WorkspaceContext | null = null;
  private cachedConversation: MatchedConversation | null = null;

  private intentProcessor: IntentProcessor | null = null;
  private commandExecutor: CommandExecutor | null = null;
  private promptElaborator: PromptElaborator | null = null;

  private readonly contextCollector = new WorkspaceContextCollector();
  private readonly conversationMatcher: ConversationMatcher;
  private readonly commandRegistry: CommandRegistry;
  private readonly chatInjector = new ChatInjector();
  private readonly voice = new VoiceCapture();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secretManager: SecretManager,
    private readonly log: vscode.OutputChannel,
  ) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const contextDepth  = vscode.workspace.getConfiguration('vtp').get<number>('contextDepth', 20);

    this.conversationMatcher = new ConversationMatcher(contextDepth);
    this.commandRegistry     = new CommandRegistry(workspaceRoot);
    this.commandRegistry.initialize();

    this.log.appendLine(`[VTP] Panel created. Workspace root: ${workspaceRoot ?? 'none'}`);
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    this.log.appendLine('[VTP] Webview resolved — panel opening.');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: PanelMessage) => this.handleMessage(msg));
  }

  // ─── Message handler ──────────────────────────────────────────────────────

  private async handleMessage(msg: PanelMessage): Promise<void> {
    if (msg.type !== 'log') {
      this.log.appendLine(`[VTP] Message received: ${msg.type}`);
    }

    switch (msg.type) {
      case 'ready':          await this.onPanelReady(); break;
      case 'startRecording': await this.startListening(); break;
      case 'stopRecording':  this.stopListening(); break;
      case 'send':           await this.onSend(msg.prompt); break;
      case 'cancel':
        this.log.appendLine('[VTP] Buffer cleared.');
        this.promptBuffer = '';
        break;
      case 'openSettings':        await this.handleOpenSettings(); break;
      case 'showInfo':            await this.showApiKeyInfo(); break;
      case 'micPermissionDenied': await this.handleMicDenied(); break;
      case 'log':
        this.log.appendLine(msg.message);
        break;
    }
  }

  // ─── Panel init ───────────────────────────────────────────────────────────

  private async onPanelReady(): Promise<void> {
    this.log.appendLine('[VTP] Panel ready — sending settings and refreshing context.');
    const config = vscode.workspace.getConfiguration('vtp');
    this.send({
      type: 'settings',
      vadMode: config.get<boolean>('vadMode', false),
      language: config.get<string>('language', 'en-US'),
    });

    await this.sendApiKeyStatus();

    // Tell the panel whether local speech is available
    const speechReady = VoiceCapture.isAvailable();
    this.log.appendLine(`[VTP] VS Code Speech available: ${speechReady}`);
    if (!speechReady) {
      this.send({ type: 'error', message: 'Install "VS Code Speech" (ms-vscode.vscode-speech) to enable voice input.' });
    }

    this.refreshContext();
  }

  // ─── Voice capture ────────────────────────────────────────────────────────

  private async startListening(): Promise<void> {
    if (this.voice.isRunning()) {
      this.log.appendLine('[VTP] Already listening — ignoring startRecording.');
      return;
    }

    if (!VoiceCapture.isAvailable()) {
      this.log.appendLine('[VTP] Speech extension not installed.');
      const action = await vscode.window.showWarningMessage(
        'VTP requires the "VS Code Speech" extension for voice input.',
        'Install Now',
      );
      if (action === 'Install Now') {
        vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-vscode.vscode-speech');
      }
      return;
    }

    this.log.appendLine('[VTP] Starting voice capture...');
    this.send({ type: 'recordingStarted' });

    await this.voice.start(
      async (text, isFinal) => {
        this.log.appendLine(`[VTP] Speech ${isFinal ? 'final' : 'interim'}: "${text}"`);
        this.send({ type: 'transcriptResult', text });
        if (isFinal) {
          await this.onFinalTranscript(text);
        }
      },
      (errMsg) => {
        this.log.appendLine(`[VTP] Speech error: ${errMsg}`);
        this.send({ type: 'error', message: errMsg });
        this.send({ type: 'recordingStopped' });
      },
    );
  }

  private stopListening(): void {
    this.voice.stop();
    this.send({ type: 'recordingStopped' });
    this.log.appendLine('[VTP] Voice capture stopped.');
  }

  // ─── API Key handling ─────────────────────────────────────────────────────

  private async sendApiKeyStatus(): Promise<void> {
    const key = await this.secretManager.getApiKey();
    this.send({ type: 'apiKeyStatus', hasKey: !!key });
    this.log.appendLine(`[VTP] API key status: ${key ? 'set' : 'not set'}`);
  }

  private async handleOpenSettings(): Promise<void> {
    const existing = await this.secretManager.getApiKey();
    if (existing) {
      const action = await vscode.window.showInformationMessage(
        'VTP: Gemini API key is active ✓', 'Update Key',
      );
      if (action === 'Update Key') {
        const newKey = await this.secretManager.promptForApiKey();
        if (newKey) {
          this.log.appendLine('[VTP] API key updated.');
          await this.sendApiKeyStatus();
        }
      }
    } else {
      const key = await this.secretManager.promptForApiKey();
      if (key) {
        this.log.appendLine('[VTP] API key saved.');
        await this.sendApiKeyStatus();
      }
    }
  }

  private async showApiKeyInfo(): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      'VTP uses the Gemini API for intent + elaboration. Get a free key at Google AI Studio.',
      'Open Google AI Studio',
      'Enter My Key Now',
    );
    if (action === 'Open Google AI Studio') {
      vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com/apikey'));
    } else if (action === 'Enter My Key Now') {
      await this.handleOpenSettings();
    }
  }

  private async handleMicDenied(): Promise<void> {
    // Mic denied in webview — guide user to install VS Code Speech instead
    this.log.appendLine('[VTP] Webview mic denied — guiding to VS Code Speech install.');
    const action = await vscode.window.showWarningMessage(
      'Microphone access is restricted in VS Code webviews. Install "VS Code Speech" for native voice input.',
      'Install VS Code Speech',
    );
    if (action === 'Install VS Code Speech') {
      vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-vscode.vscode-speech');
    }
  }

  // ─── Transcript processing ────────────────────────────────────────────────

  private async onFinalTranscript(segment: string): Promise<void> {
    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) {
      this.send({ type: 'error', message: 'No API key set. Click KEY to add one.' });
      return;
    }

    this.ensurePipeline(apiKey);
    const context = this.cachedContext ?? await this.contextCollector.collect();
    this.log.appendLine('[VTP] Classifying intent...');

    try {
      const result = await this.withRetry(() =>
        this.intentProcessor!.classify(segment, this.promptBuffer, context),
      );

      this.log.appendLine(`[VTP] Intent: ${result.type} — "${result.content || result.commandIntent || ''}"`);
      this.send({ type: 'intentResult', intent: result, buffer: this.promptBuffer });

      switch (result.type) {
        case 'PROMPT_CONTENT':
          this.promptBuffer += (this.promptBuffer ? ' ' : '') + result.content;
          break;
        case 'COMMAND': {
          const description = await this.commandExecutor!.execute(result.commandIntent ?? segment);
          this.send({ type: 'commandFired', description });
          break;
        }
        case 'SEND':  await this.elaborateAndInject(); break;
        case 'CANCEL': this.promptBuffer = ''; break;
      }
    } catch (err) {
      const msg = this.formatError(err);
      this.log.appendLine(`[VTP] Intent error: ${msg}`);
      this.send({ type: 'error', message: msg });
    }
  }

  private async onSend(prompt: string): Promise<void> {
    this.log.appendLine(`[VTP] Manual send — injecting (${prompt.length} chars).`);
    await this.chatInjector.inject(prompt);
    this.promptBuffer = '';
    this.send({ type: 'injected' });
  }

  private async elaborateAndInject(): Promise<void> {
    if (!this.promptBuffer.trim()) return;

    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) return;

    this.ensurePipeline(apiKey);
    this.send({ type: 'elaborating' });

    try {
      const [context, conversation] = await Promise.all([
        this.contextCollector.collect(),
        this.cachedConversation ?? this.conversationMatcher.findBestMatch(),
      ]);

      const elaborated = await this.withRetry(() =>
        this.promptElaborator!.elaborate(this.promptBuffer, context, conversation),
      );

      this.promptBuffer = '';
      this.send({ type: 'elaborated', prompt: elaborated });
    } catch (err) {
      const msg = this.formatError(err);
      this.log.appendLine(`[VTP] Elaboration error: ${msg}`);
      this.send({ type: 'error', message: msg });
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Retries on Gemini 429 rate-limit, up to 2 times with the server-specified delay.
   */
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err: unknown) {
        const msg = String(err);
        const is429 = msg.includes('429') || msg.includes('Too Many Requests');
        if (is429 && attempt < maxRetries) {
          attempt++;
          // Extract suggested delay from error body, fall back to 30s
          const delayMatch = msg.match(/retryDelay['":\s]+(\d+)s/);
          const delaySec = delayMatch ? parseInt(delayMatch[1], 10) : 30;
          this.log.appendLine(`[VTP] Rate limited (429) — retrying in ${delaySec}s (attempt ${attempt}/${maxRetries})...`);
          this.send({ type: 'error', message: `Gemini rate limit hit — retrying in ${delaySec}s…` });
          await new Promise((r) => setTimeout(r, delaySec * 1000));
        } else {
          throw err;
        }
      }
    }
  }

  private formatError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('429') || msg.includes('Too Many Requests')) {
      return 'Gemini rate limit reached. Try again in a minute, or upgrade your API plan.';
    }
    return msg;
  }

  private refreshContext(): void {
    Promise.all([
      this.contextCollector.collect(),
      this.conversationMatcher.findBestMatch(),
    ]).then(([context, conversation]) => {
      this.cachedContext      = context;
      this.cachedConversation = conversation;
      const conversationTitle = conversation?.title ?? 'No matched conversation';
      this.log.appendLine(`[VTP] Context refreshed — workspace: "${context.workspaceName}", conversation: "${conversationTitle}"`);
      this.send({ type: 'contextUpdate', workspaceName: context.workspaceName, conversationTitle });
    }).catch((err) => this.log.appendLine(`[VTP] Context refresh error: ${err}`));
  }

  private ensurePipeline(apiKey: string): void {
    const model = vscode.workspace.getConfiguration('vtp').get<string>('elaborationModel', 'gemini-2.0-flash');
    if (!this.intentProcessor)  this.intentProcessor  = new IntentProcessor(apiKey);
    if (!this.commandExecutor)  this.commandExecutor  = new CommandExecutor(this.commandRegistry.getCommands());
    if (!this.promptElaborator) this.promptElaborator = new PromptElaborator(apiKey, model);
  }

  private send(msg: ExtensionMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'));
    const nonce     = this.nonce();
    const htmlPath  = path.join(this.extensionUri.fsPath, 'media', 'panel.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');
    return html
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{cspNonce\}\}/g, nonce)
      .replace('{{styleUri}}', styleUri.toString())
      .replace('{{scriptUri}}', scriptUri.toString());
  }

  private nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  dispose(): void {
    this.voice.stop();
    this.commandRegistry.dispose();
  }
}
