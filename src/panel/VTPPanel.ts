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
import { GoogleGenerativeAI } from '@google/generative-ai';

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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secretManager: SecretManager,
    private readonly log: vscode.OutputChannel,
  ) {
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const contextDepth = vscode.workspace
      .getConfiguration('vtp')
      .get<number>('contextDepth', 20);

    this.conversationMatcher = new ConversationMatcher(contextDepth);
    this.commandRegistry = new CommandRegistry(workspaceRoot);
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
    webviewView.webview.onDidReceiveMessage((msg: PanelMessage) =>
      this.handleMessage(msg),
    );
  }

  // ─── Message handler ──────────────────────────────────────────────────────

  private async handleMessage(msg: PanelMessage): Promise<void> {
    if (msg.type !== 'log') {
      this.log.appendLine(`[VTP] Message received: ${msg.type}`);
    }

    switch (msg.type) {
      case 'ready':
        await this.onPanelReady();
        break;
      case 'audioChunk':
        await this.onAudioChunk(msg.base64, msg.mimeType);
        break;
      case 'send':
        await this.onSend(msg.prompt);
        break;
      case 'cancel':
        this.log.appendLine('[VTP] Buffer cleared by user.');
        this.promptBuffer = '';
        break;
      case 'openSettings':
        await this.handleOpenSettings();
        break;
      case 'showInfo':
        await this.showApiKeyInfo();
        break;
      case 'log':
        this.log.appendLine(msg.message);
        break;
    }
  }

  private async onPanelReady(): Promise<void> {
    this.log.appendLine('[VTP] Panel ready — sending settings and refreshing context.');
    const config = vscode.workspace.getConfiguration('vtp');
    this.send({
      type: 'settings',
      vadMode: config.get<boolean>('vadMode', false),
      language: config.get<string>('language', 'en-US'),
    });

    // Send current API key status
    await this.sendApiKeyStatus();
    this.refreshContext();
  }

  // ─── API Key handling ─────────────────────────────────────────────────────

  private async sendApiKeyStatus(): Promise<void> {
    const key = await this.secretManager.getApiKey();
    this.send({ type: 'apiKeyStatus', hasKey: !!key });
    this.log.appendLine(`[VTP] API key status: ${key ? 'set' : 'not set'}`);
  }

  private async handleOpenSettings(): Promise<void> {
    const existingKey = await this.secretManager.getApiKey();
    if (existingKey) {
      // Key already set — ask if they want to update, don't just re-prompt
      const action = await vscode.window.showInformationMessage(
        'VTP: Gemini API key is active ✓',
        'Update Key',
      );
      if (action === 'Update Key') {
        const newKey = await this.secretManager.promptForApiKey();
        if (newKey) {
          this.log.appendLine('[VTP] API key updated.');
          await this.sendApiKeyStatus();
          vscode.window.showInformationMessage('VTP: API key updated.');
        }
      }
    } else {
      const key = await this.secretManager.promptForApiKey();
      if (key) {
        this.log.appendLine('[VTP] API key saved.');
        await this.sendApiKeyStatus();
        vscode.window.showInformationMessage('VTP: Gemini API key saved.');
      }
    }
  }

  private async showApiKeyInfo(): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      'VTP uses the Gemini API. Get a free key at Google AI Studio — it takes 30 seconds.',
      'Open Google AI Studio',
      'Enter My Key Now',
    );
    if (action === 'Open Google AI Studio') {
      vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com/apikey'));
    } else if (action === 'Enter My Key Now') {
      await this.handleOpenSettings();
    }
  }

  // ─── Audio transcription ──────────────────────────────────────────────────

  private async onAudioChunk(base64: string, mimeType: string): Promise<void> {
    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) {
      this.log.appendLine('[VTP] No API key — cannot transcribe audio.');
      this.send({ type: 'error', message: 'No API key set. Click the KEY button to add one.' });
      return;
    }

    this.log.appendLine(`[VTP] Transcribing audio chunk (${Math.round(base64.length * 0.75 / 1024)} KB)...`);

    try {
      const genai = new GoogleGenerativeAI(apiKey);
      const model = genai.getGenerativeModel({ model: 'gemini-2.0-flash' });

      const result = await model.generateContent([
        {
          inlineData: {
            mimeType: mimeType,
            data: base64,
          },
        },
        'Transcribe this audio exactly as spoken. Output only the transcription text, nothing else. If you cannot hear any speech, output an empty string.',
      ]);

      const text = result.response.text().trim();
      this.log.appendLine(`[VTP] Transcription: "${text}"`);

      if (!text) {
        this.log.appendLine('[VTP] Empty transcription — no speech detected.');
        this.send({ type: 'transcriptResult', text: '' });
        return;
      }

      this.send({ type: 'transcriptResult', text });
      await this.onFinalTranscript(text);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[VTP] Transcription error: ${message}`);
      this.send({ type: 'error', message: `Transcription failed: ${message}` });
    }
  }

  private async onFinalTranscript(segment: string): Promise<void> {
    this.log.appendLine(`[VTP] Processing transcript: "${segment}"`);

    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) return;

    this.ensurePipeline(apiKey);

    const context = this.cachedContext ?? (await this.contextCollector.collect());
    this.log.appendLine('[VTP] Classifying intent...');

    const result = await this.intentProcessor!.classify(
      segment,
      this.promptBuffer,
      context,
    );

    this.log.appendLine(`[VTP] Intent: ${result.type} — "${result.content || result.commandIntent || ''}"`);
    this.send({ type: 'intentResult', intent: result, buffer: this.promptBuffer });

    switch (result.type) {
      case 'PROMPT_CONTENT':
        this.promptBuffer += (this.promptBuffer ? ' ' : '') + result.content;
        break;

      case 'COMMAND': {
        this.log.appendLine(`[VTP] Executing command: "${result.commandIntent}"`);
        const description = await this.commandExecutor!.execute(
          result.commandIntent ?? segment,
        );
        this.log.appendLine(`[VTP] Command result: ${description}`);
        this.send({ type: 'commandFired', description });
        break;
      }

      case 'SEND':
        this.log.appendLine('[VTP] SEND intent — elaborating.');
        await this.elaborateAndInject();
        break;

      case 'CANCEL':
        this.log.appendLine('[VTP] CANCEL intent — clearing buffer.');
        this.promptBuffer = '';
        break;
    }
  }

  private async onSend(prompt: string): Promise<void> {
    this.log.appendLine(`[VTP] Manual send — injecting (${prompt.length} chars).`);
    await this.chatInjector.inject(prompt);
    this.promptBuffer = '';
    this.send({ type: 'injected' });
  }

  private async elaborateAndInject(): Promise<void> {
    if (!this.promptBuffer.trim()) {
      this.log.appendLine('[VTP] Buffer empty — nothing to elaborate.');
      return;
    }

    const apiKey = await this.secretManager.getApiKey();
    if (!apiKey) return;

    this.ensurePipeline(apiKey);
    this.send({ type: 'elaborating' });
    this.log.appendLine(`[VTP] Elaborating: "${this.promptBuffer.slice(0, 80)}..."`);

    try {
      const [context, conversation] = await Promise.all([
        this.contextCollector.collect(),
        this.cachedConversation ?? this.conversationMatcher.findBestMatch(),
      ]);

      const elaborated = await this.promptElaborator!.elaborate(
        this.promptBuffer,
        context,
        conversation,
      );

      this.log.appendLine(`[VTP] Elaboration done (${elaborated.length} chars).`);
      this.promptBuffer = '';
      this.send({ type: 'elaborated', prompt: elaborated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[VTP] Elaboration error: ${message}`);
      this.send({ type: 'error', message: `Elaboration failed: ${message}` });
    }
  }

  private refreshContext(): void {
    Promise.all([
      this.contextCollector.collect(),
      this.conversationMatcher.findBestMatch(),
    ]).then(([context, conversation]) => {
      this.cachedContext = context;
      this.cachedConversation = conversation;
      const conversationTitle = conversation?.title ?? 'No matched conversation';
      this.log.appendLine(
        `[VTP] Context refreshed — workspace: "${context.workspaceName}", conversation: "${conversationTitle}"`,
      );
      this.send({ type: 'contextUpdate', workspaceName: context.workspaceName, conversationTitle });
    }).catch((err) => {
      this.log.appendLine(`[VTP] Context refresh error: ${err}`);
    });
  }

  private ensurePipeline(apiKey: string): void {
    const model = vscode.workspace
      .getConfiguration('vtp')
      .get<string>('elaborationModel', 'gemini-2.0-flash');

    if (!this.intentProcessor) {
      this.intentProcessor = new IntentProcessor(apiKey);
    }
    if (!this.commandExecutor) {
      this.commandExecutor = new CommandExecutor(this.commandRegistry.getCommands());
    }
    if (!this.promptElaborator) {
      this.promptElaborator = new PromptElaborator(apiKey, model);
    }
  }

  private send(msg: ExtensionMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'),
    );
    const nonce = this.nonce();
    const htmlPath = path.join(this.extensionUri.fsPath, 'media', 'panel.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');

    html = html
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{cspNonce\}\}/g, nonce)
      .replace('{{styleUri}}', styleUri.toString())
      .replace('{{scriptUri}}', scriptUri.toString());

    return html;
  }

  private nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () =>
      chars[Math.floor(Math.random() * chars.length)],
    ).join('');
  }

  dispose(): void {
    this.commandRegistry.dispose();
  }
}
