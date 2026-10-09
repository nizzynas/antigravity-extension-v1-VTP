import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { MatchedConversation, ConversationMessage } from '../types';

const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

export interface ScoredConversation extends MatchedConversation {
  lastModified: number;
  preview: string;
  workspacePath: string;
}

export class ConversationMatcher {
  private contextDepth: number;

  constructor(contextDepth = 20) {
    this.contextDepth = contextDepth;
  }

  static getBrainDir(): string {
    return BRAIN_DIR;
  }

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

    const plainMatch = rawLog.match(/^(?:USER|user)[:\s]+(.+)/m);
    if (plainMatch) return plainMatch[1].trim();

    return '';
  }

  private cleanUserContent(raw: string): string {
    const reqMatch = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
    const text = reqMatch ? reqMatch[1] : raw;

    return text
      .replace(/<[A-Z_]+>[\s\S]*?<\/[A-Z_]+>/g, '')
      .replace(/<[A-Z_]+\s*\/?>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractTitle(id: string, firstUserMsg: string): string {
    if (!firstUserMsg || firstUserMsg.length < 4) {
      return `Chat ${id.slice(0, 8)}`;
    }

    let title = firstUserMsg.charAt(0).toUpperCase() + firstUserMsg.slice(1);

    if (title.length > 45) {
      title = title.slice(0, 42);
      const lastSpace = title.lastIndexOf(' ');
      if (lastSpace > 20) title = title.slice(0, lastSpace);
      title += '...';
    }

    return title;
  }

  private extractWorkspacePath(rawLog: string): string {
    const lines = rawLog.split('\n');
    for (const line of lines.slice(0, 60)) {
      try {
        const step = JSON.parse(line.trim());
        if (!step.content || typeof step.content !== 'string') continue;

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

  private shortenPath(fullPath: string): string {
    const normalized = fullPath.replace(/\\\\/g, '/').replace(/\\/g, '/');

    const desktopIdx = normalized.indexOf('Desktop/');
    if (desktopIdx !== -1) {
      const after = normalized.slice(desktopIdx + 'Desktop/'.length);
      const segments = after.split('/').filter(Boolean);
      if (segments.length >= 3 && segments[0] === segments[0].toUpperCase() && segments[0].length <= 6) {
        return segments.slice(0, 3).join('/');
      }
      return segments.slice(0, 2).join('/');
    }

    const segments = normalized.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return segments.slice(-2).join('/');
    }

    return segments[segments.length - 1] ?? '';
  }
}
