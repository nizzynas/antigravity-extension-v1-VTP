import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export function inboxDir(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'VTP', 'inbox');
}

interface Handover {
  text: string;
  submit?: boolean;
  targetTitle?: string;
}

export function sameConversation(title: string, said: string): boolean {
  const tidy = (s: string) => (s || '').toLowerCase().replace(/[….]+\s*$/, '').trim();
  const a = tidy(title);
  const b = tidy(said);
  if (!b) return true;
  if (!a) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export class Inbox {
  private watcher: fs.FSWatcher | null = null;
  private readonly busy = new Set<string>();

  constructor(private readonly log: (m: string) => void) {}

  start(): void {
    const dir = inboxDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e: any) {
      this.log(`[VTP inbox] cannot make ${dir}: ${e?.message ?? e}`);
      return;
    }

    for (const name of this.pending(dir)) void this.take(dir, name);

    try {
      this.watcher = fs.watch(dir, (_event, name) => {
        if (name && /\.json$/i.test(String(name)) && !/\.done\.json$/i.test(String(name))) {
          void this.take(dir, String(name));
        }
      });
      this.log(`[VTP inbox] listening at ${dir}`);
    } catch (e: any) {
      this.log(`[VTP inbox] cannot watch ${dir}: ${e?.message ?? e}`);
    }
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private pending(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter((n) => /\.json$/i.test(n) && !/\.done\.json$/i.test(n));
    } catch {
      return [];
    }
  }

  private async take(dir: string, name: string): Promise<void> {
    const file = path.join(dir, name);
    if (this.busy.has(file)) return;
    this.busy.add(file);

    const base = file;
    const mine = file + '.mine';
    try {
      fs.renameSync(file, mine);
    } catch {
      this.busy.delete(file);
      return;
    }

    try {
      const handover = await this.read(mine);
      if (!handover) return;

      const text = String(handover.text ?? '').trim();
      if (!text) {
        this.answer(base, { ok: false, error: 'nothing to say' });
        return;
      }

      const submit = handover.submit === true;
      const target = String(handover.targetTitle ?? '');

      const open = await this.openConversations();
      const matched = target ? open.filter((t) => sameConversation(t, target)) : open;

      if (open.length === 0) {
        this.answer(base, { ok: false, error: 'no Claude conversation is open in the editor', panels: open });
        return;
      }
      if (matched.length === 0) {
        this.answer(base, {
          ok: false,
          error: `no open conversation matches "${target}"`,
          panels: open,
        });
        return;
      }

      await vscode.commands.executeCommand('claude-code.injectPromptVTP', text, submit, target);
      this.log(`[VTP inbox] handed over ${text.length} chars to ${matched.length} of ${open.length} conversation(s)${submit ? ', sent' : ''}`);
      this.answer(base, {
        ok: true,
        chars: text.length,
        submitted: submit,
        panels: matched,
      });
    } catch (e: any) {
      const why = String(e?.message ?? e);
      this.log(`[VTP inbox] ${name} failed: ${why}`);
      this.answer(base, {
        ok: false,
        error: /command .* not found/i.test(why)
          ? 'claude-code.injectPromptVTP is not registered — the Claude Code patch is not applied in this window'
          : why,
      });
    } finally {
      try { fs.unlinkSync(mine); } catch {}
      this.busy.delete(file);
    }
  }

  private async openConversations(): Promise<string[]> {
    try {
      const titles = await vscode.commands.executeCommand<string[]>('claude-code.getPanelTitlesVTP');
      return Array.isArray(titles) ? titles.filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  private async read(file: string): Promise<Handover | null> {
    let last = -1;
    for (let i = 0; i < 20; i++) {
      let size = -1;
      try { size = fs.statSync(file).size; } catch { return null; }
      if (size > 0 && size === last) {
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8')) as Handover;
        } catch (e: any) {
          this.answer(file, { ok: false, error: `not readable as JSON: ${e?.message ?? e}` });
          return null;
        }
      }
      last = size;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  }

  private answer(file: string, result: Record<string, unknown>): void {
    try {
      fs.writeFileSync(
        file.replace(/\.json$/i, '') + '.done.json',
        JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2),
        'utf8',
      );
    } catch {}
  }
}
