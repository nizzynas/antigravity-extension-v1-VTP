import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { MatchedConversation, ConversationMessage } from '../types';

const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

/**
 * Finds the Antigravity conversation most relevant to the current workspace
 * by scoring each conversation log's file-path overlap with open workspace files.
 */
export class ConversationMatcher {
  private contextDepth: number;

  constructor(contextDepth = 20) {
    this.contextDepth = contextDepth;
  }

  async findBestMatch(): Promise<MatchedConversation | null> {
    const workspaceTokens = this.getWorkspaceTokens();
    const conversations = this.loadAllConversations();

    if (!conversations.length) return null;

    const scored = conversations
      .map((conv) => ({
        ...conv,
        score: this.score(conv.rawLog, workspaceTokens),
      }))
      .sort((a, b) => b.score - a.score || b.lastModified - a.lastModified);

    return scored[0] ?? null;
  }

  /** Tokens derived from the current workspace to match against log text */
  private getWorkspaceTokens(): Set<string> {
    const tokens = new Set<string>();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      tokens.add(path.basename(folder.uri.fsPath).toLowerCase());
    }

    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file') {
        tokens.add(path.basename(doc.uri.fsPath).toLowerCase());
      }
    }

    return tokens;
  }

  private loadAllConversations(): Array<{
    id: string;
    title: string;
    rawLog: string;
    messages: ConversationMessage[];
    lastModified: number;
  }> {
    if (!fs.existsSync(BRAIN_DIR)) return [];

    const results = [];

    for (const entry of fs.readdirSync(BRAIN_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      // Antigravity stores logs under .system_generated/logs/overview.txt
      const overviewPath = path.join(
        BRAIN_DIR,
        entry.name,
        '.system_generated',
        'logs',
        'overview.txt',
      );

      // Fallback: some versions store it directly
      const fallbackPath = path.join(BRAIN_DIR, entry.name, 'overview.txt');
      const filePath = fs.existsSync(overviewPath)
        ? overviewPath
        : fs.existsSync(fallbackPath)
          ? fallbackPath
          : null;

      if (!filePath) continue;

      try {
        const rawLog = fs.readFileSync(filePath, 'utf-8');
        const stat = fs.statSync(filePath);
        results.push({
          id: entry.name,
          title: this.extractTitle(entry.name, rawLog),
          rawLog,
          messages: this.parseMessages(rawLog),
          lastModified: stat.mtimeMs,
        });
      } catch {
        // Skip unreadable logs
      }
    }

    return results;
  }

  private score(rawLog: string, tokens: Set<string>): number {
    const log = rawLog.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (log.includes(token)) score += 2;
    }
    return score;
  }

  private parseMessages(rawLog: string): ConversationMessage[] {
    const messages: ConversationMessage[] = [];
    const lines = rawLog.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const userMatch = trimmed.match(/^(?:USER|user)[:\s]+(.+)/);
      const asstMatch = trimmed.match(/^(?:ASSISTANT|assistant|model)[:\s]+(.+)/);

      if (userMatch) {
        messages.push({ role: 'user', content: userMatch[1] });
      } else if (asstMatch) {
        messages.push({ role: 'assistant', content: asstMatch[1] });
      }
    }

    return messages.slice(-this.contextDepth);
  }

  private extractTitle(id: string, rawLog: string): string {
    const match = rawLog.match(/(?:title|Title)[:\s]+([^\n]+)/);
    return match ? match[1].trim() : `Conversation ${id.slice(0, 8)}`;
  }
}
