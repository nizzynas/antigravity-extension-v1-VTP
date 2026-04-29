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
  /** Relative workspace path like "VTP/antigravity-extension-v1-VTP" */
  workspacePath: string;
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

  /** Returns the brain directory path (cross-platform). */
  static getBrainDir(): string {
    return BRAIN_DIR;
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
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  private loadAllConversations(): ScoredConversation[] {
    if (!fs.existsSync(BRAIN_DIR)) return [];

    const results: ScoredConversation[] = [];

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
        const firstUserMsg = this.extractFirstUserMessage(rawLog);

        results.push({
          id:            entry.name,
          title:         this.extractTitle(entry.name, firstUserMsg),
          preview:       firstUserMsg.slice(0, 80),
          workspacePath: this.extractWorkspacePath(rawLog),
          messages,
          lastModified:  stat.mtimeMs,
          score:         0,
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

      // Try JSON step format first (the overview.txt format Antigravity uses)
      try {
        const step = JSON.parse(trimmed);
        if (step.content && typeof step.content === 'string') {
          if (step.source === 'USER_EXPLICIT' || step.type === 'USER_INPUT') {
            const text = this.cleanUserContent(step.content);
            if (text) messages.push({ role: 'user', content: text.slice(0, 500) });
          } else if (step.source === 'MODEL') {
            const text = step.content.trim();
            if (text) messages.push({ role: 'assistant', content: text.slice(0, 500) });
          }
        }
        continue;
      } catch {
        // Not JSON — try plain text format
      }

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

  /**
   * Extracts the first user message from overview.txt — used for both title and preview.
   * Strips <USER_REQUEST>, <ADDITIONAL_METADATA>, and XML tags.
   */
  private extractFirstUserMessage(rawLog: string): string {
    const lines = rawLog.split('\n');
    for (const line of lines.slice(0, 80)) {
      try {
        const step = JSON.parse(line.trim());
        if (!step.content) continue;
        if (step.source !== 'USER_EXPLICIT' && step.type !== 'USER_INPUT') continue;
        const text = this.cleanUserContent(step.content);
        if (text && text.length > 3) return text;
      } catch {
        continue;
      }
    }

    // Fallback: plain text USER: line
    const plainMatch = rawLog.match(/^(?:USER|user)[:\s]+(.+)/m);
    if (plainMatch) return plainMatch[1].trim();

    return '';
  }

  /**
   * Strips <USER_REQUEST>, <ADDITIONAL_METADATA>, and other XML wrapper tags
   * from the raw step content, returning only the user's actual text.
   */
  private cleanUserContent(raw: string): string {
    // Extract text between <USER_REQUEST>...</USER_REQUEST>, stripping the tag
    const reqMatch = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
    const text = reqMatch ? reqMatch[1] : raw;

    // Remove any remaining XML-like tags (<ADDITIONAL_METADATA>, etc.)
    return text
      .replace(/<[A-Z_]+>[\s\S]*?<\/[A-Z_]+>/g, '')
      .replace(/<[A-Z_]+\s*\/?>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Generates a short, clean title from the first user message.
   * Capitalizes first letter, limits to ~40 chars — like Antigravity's native list.
   */
  private extractTitle(id: string, firstUserMsg: string): string {
    if (!firstUserMsg || firstUserMsg.length < 4) {
      return `Chat ${id.slice(0, 8)}`;
    }

    // Capitalize first letter
    let title = firstUserMsg.charAt(0).toUpperCase() + firstUserMsg.slice(1);

    // Limit length — cut at word boundary
    if (title.length > 45) {
      title = title.slice(0, 42);
      const lastSpace = title.lastIndexOf(' ');
      if (lastSpace > 20) title = title.slice(0, lastSpace);
      title += '...';
    }

    return title;
  }

  /**
   * Extracts the workspace path from the overview.txt by scanning for
   * file paths in user metadata (Active Document, CWD, etc.).
   * Returns a short relative path like "VTP/antigravity-extension-v1-VTP".
   */
  private extractWorkspacePath(rawLog: string): string {
    // Scan the first ~30 lines with content for workspace indicators
    const lines = rawLog.split('\n');
    for (const line of lines.slice(0, 60)) {
      try {
        const step = JSON.parse(line.trim());
        if (!step.content || typeof step.content !== 'string') continue;

        // Look for Active Document or CWD paths in the metadata
        const pathMatch = step.content.match(
          /(?:Active Document|CWD|workspaceFolders)[:\s]*([^\n]+)/i,
        );
        if (pathMatch) {
          const wsPath = this.shortenPath(pathMatch[1].trim());
          if (wsPath) return wsPath;
        }
      } catch {
        continue;
      }
    }

    return '';
  }

  /**
   * Shortens a full filesystem path to a relative workspace-style path.
   * e.g. "c:\\Users\\banko\\Desktop\\VTP\\antigravity-extension-v1-VTP\\src\\panel\\VTPPanel.ts"
   *   → "VTP/antigravity-extension-v1-VTP"
   *
   * Heuristic: find "Desktop" or home dir, take the next 2 segments as the project path.
   */
  private shortenPath(fullPath: string): string {
    // Normalize separators
    const normalized = fullPath.replace(/\\\\/g, '/').replace(/\\/g, '/');

    // Try to find "Desktop/" as the anchor
    const desktopIdx = normalized.indexOf('Desktop/');
    if (desktopIdx !== -1) {
      const after = normalized.slice(desktopIdx + 'Desktop/'.length);
      const segments = after.split('/').filter(Boolean);
      // Take first 2 segments max (e.g. "WORK/savara/cswellnesscenter" → 3 if WORK is a group)
      // But check if first segment looks like a group folder (all caps, short)
      if (segments.length >= 3 && segments[0] === segments[0].toUpperCase() && segments[0].length <= 6) {
        return segments.slice(0, 3).join('/');
      }
      return segments.slice(0, 2).join('/');
    }

    // Fallback: last 2 meaningful path segments
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return segments.slice(-2).join('/');
    }

    return segments[segments.length - 1] ?? '';
  }
}
