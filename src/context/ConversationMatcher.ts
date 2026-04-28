import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { MatchedConversation, ConversationMessage } from '../types';

const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

export interface ScoredConversation extends MatchedConversation {
  lastModified: number;
  /** Preview snippet from the first user message in the log */
  preview: string;
}

/**
 * Finds Antigravity conversations from ~/.gemini/antigravity/brain.
 *
 * PRIMARY:  The most recently modified conversation = the one currently open in Antigravity.
 * EXTRA:    Any additional conversations the user manually pins as supplementary context.
 */
export class ConversationMatcher {
  private contextDepth: number;

  constructor(contextDepth = 20) {
    this.contextDepth = contextDepth;
  }

  /**
   * Returns the most recently modified conversation (the "current" chat).
   * This is the primary auto-detected context and does NOT rely on scoring.
   */
  async findBestMatch(): Promise<MatchedConversation | null> {
    const all = this.loadAllConversations();
    if (!all.length) return null;
    const best = all.sort((a, b) => b.lastModified - a.lastModified)[0];
    return {
      id:       best.id,
      title:    best.title,
      messages: best.messages,
      score:    0,
    };
  }

  /**
   * Returns ALL conversations sorted by recency (newest first).
   * Used by the extra-context picker.
   */
  async findAllMatches(): Promise<ScoredConversation[]> {
    return this.loadAllConversations()
      .sort((a, b) => b.lastModified - a.lastModified)
      .map(({ rawLog: _raw, ...rest }) => rest);
  }

  /** Tokens derived from the current workspace — kept for optional relevance sorting */
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
    preview: string;
    rawLog: string;
    messages: ConversationMessage[];
    lastModified: number;
    score: number;
  }> {
    if (!fs.existsSync(BRAIN_DIR)) return [];

    const results = [];

    for (const entry of fs.readdirSync(BRAIN_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const overviewPath = path.join(
        BRAIN_DIR, entry.name, '.system_generated', 'logs', 'overview.txt',
      );
      const fallbackPath = path.join(BRAIN_DIR, entry.name, 'overview.txt');
      const filePath = fs.existsSync(overviewPath)
        ? overviewPath
        : fs.existsSync(fallbackPath) ? fallbackPath : null;

      if (!filePath) continue;

      try {
        const rawLog = fs.readFileSync(filePath, 'utf-8');
        const stat   = fs.statSync(filePath);
        const messages = this.parseMessages(rawLog);
        results.push({
          id:           entry.name,
          title:        this.extractTitle(entry.name, rawLog),
          preview:      this.extractPreview(rawLog),
          rawLog,
          messages,
          lastModified: stat.mtimeMs,
          score:        0,
        });
      } catch {
        // Skip unreadable logs
      }
    }

    return results;
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
    const match = rawLog.substring(0, 1000).match(/(?:title|Title)[:\s]+([^\n]{1,80})/);
    return match ? match[1].trim() : `Conversation ${id.slice(0, 8)}`;
  }

  private extractPreview(rawLog: string): string {
    // Grab the first user message content as a short preview
    const match = rawLog.match(/^(?:USER|user)[:\s]+(.+)/m);
    if (!match) return '';
    return match[1].trim().slice(0, 80);
  }
}
