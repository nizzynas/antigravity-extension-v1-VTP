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

/**
 * Manages the VTP Webview sidebar panel.
 * Acts as the bridge between the Webview UI and the processing pipeline.
 */
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
  ) {
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const contextDepth = vscode.workspace
      .getConfiguration('vtp')
      .get<number>('contextDepth', 20);

    this.conversationMatcher = new ConversationMatcher(contextDepth);
    this.commandRegistry = new CommandRegistry(workspaceRoot);
    this.commandRegistry.initialize();
  }

  /** Called by VS Code when the webview panel becomes visible */
  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(
      (msg: PanelMessage) => this.handleMessage(msg),
    );
  }

  // ─── Message handler ──────────────────────────────────────────────────────

  private async handleMessage(msg: PanelMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.onPanelReady();
        break;

      case 'transcript':
        if (msg.isFinal) {
          await this.onFinalTranscript(msg.segment);
        }
        break;

      case 'send':
        await this.onSend(msg.prompt);
        break;

      case 'cancel':
        this.promptBuffer = '';
        break;
    }
  }

  private async onPanelReady(): Promise<void> {
    const config = vscode.workspace.getConfiguration('vtp');
    this.send({
      type: 'settings',
      vadMode: config.get<boolean>('vadMode', false),
      language: config.get<string>('language', 'en-US'),
    });

    // Refresh context in the background
    this.refreshContext();
  }

  private async onFinalTranscript(segment: string): Promise<void> {
    const apiKey = await this.secretManager.ensureApiKey();
    if (!apiKey) {
      this.send({ type: 'error', message: 'No API key set. Use "VTP: Set Gemini API Key".' });
      return;
    }

    this.ensurePipeline(apiKey);

    const context = this.cachedContext ?? (await this.contextCollector.collect());
    const result = await this.intentProcessor!.classify(
      segment,
      this.promptBuffer,
      context,
    );

    this.send({ type: 'intentResult', intent: result, buffer: this.promptBuffer });

    switch (result.type) {
      case 'PROMPT_CONTENT':
        this.promptBuffer += (this.promptBuffer ? ' ' : '') + result.content;
        break;

      case 'COMMAND': {
        const description = await this.commandExecutor!.execute(
          result.commandIntent ?? segment,
        );
        this.send({ type: 'commandFired', description });
        break;
      }

      case 'SEND':
        await this.elaborateAndInject();
        break;

      case 'CANCEL':
        this.promptBuffer = '';
        break;
    }
  }

  private async onSend(prompt: string): Promise<void> {
    // User hit the Send button manually with an edited prompt
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

      const elaborated = await this.promptElaborator!.elaborate(
        this.promptBuffer,
        context,
        conversation,
      );

      this.promptBuffer = '';
      this.send({ type: 'elaborated', prompt: elaborated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: 'error', message: `Elaboration failed: ${message}` });
    }
  }

  private async refreshContext(): Promise<void> {
    const [context, conversation] = await Promise.all([
      this.contextCollector.collect(),
      this.conversationMatcher.findBestMatch(),
    ]);
    this.cachedContext = context;
    this.cachedConversation = conversation;
    this.send({
      type: 'contextUpdate',
      workspaceName: context.workspaceName,
      conversationTitle: conversation?.title ?? 'No matched conversation',
    });
  }

  /** Lazily initialise pipeline objects (avoids work before API key is set) */
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

  // ─── Helpers ──────────────────────────────────────────────────────────────

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

    const htmlPath = path.join(
      this.extensionUri.fsPath,
      'media',
      'panel.html',
    );
    let html = fs.readFileSync(htmlPath, 'utf-8');

    html = html
      .replace('{{cspNonce}}', nonce)
      .replace('{{styleUri}}', styleUri.toString())
      .replace('{{scriptUri}}', scriptUri.toString());

    return html;
  }

  private nonce(): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () =>
      chars[Math.floor(Math.random() * chars.length)],
    ).join('');
  }

  dispose(): void {
    this.commandRegistry.dispose();
  }
}
