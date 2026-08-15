/**
 * A way in from outside the IDE.
 *
 * Everything VTP can do is reachable only from inside this extension host: the
 * patch registers a VS Code command, and VS Code commands can be called by
 * extensions and by nothing else. So the voice pipeline could put a prompt
 * into a Claude conversation and no other program on the machine could, which
 * is the wall Hangar hits when it wants to hand a note over.
 *
 * A folder is the door. A file appears, its contents go into the chat, and a
 * result is written back next to it. No port to pick, nothing to be already in
 * use, nothing for a firewall to ask about, and it works when the IDE is
 * starting up because the folder is read on activation as well as watched.
 *
 * It lives under the user's own profile, so writing to it means already being
 * this user on this machine — the same reach as typing in the chat directly.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Where things are handed over. Hangar writes here; this reads and answers. */
export function inboxDir(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'VTP', 'inbox');
}

interface Handover {
  /** What to put in the chat. */
  text: string;
  /** Send it, or leave it sitting in the composer. Left sitting by default —
   *  handing someone a sentence is not the same as speaking for them. */
  submit?: boolean;
  /** Which conversation, by panel title. Empty means whichever is open. */
  targetTitle?: string;
}

/**
 * Whether a name someone said refers to this conversation.
 *
 * The same rule the extension-side dispatch uses, because answering "which
 * conversations match" with one rule and delivering with another produces the
 * report nobody can act on: told it went somewhere it did not.
 *
 * Trailing ellipses go because a tab label is truncated where the panel title
 * is not, so the two forms of the same name never match on the nose.
 */
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

    // Anything left while the IDE was shut. A note handed over to a closed
    // window should still arrive when it opens, rather than being a file
    // nobody ever reads.
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
    // fs.watch fires more than once for a single write, and the second one
    // arrives while the first is still in the chat.
    if (this.busy.has(file)) return;
    this.busy.add(file);

    try {
      const handover = await this.read(file);
      if (!handover) return;

      const text = String(handover.text ?? '').trim();
      if (!text) {
        this.answer(file, { ok: false, error: 'nothing to say' });
        return;
      }

      const submit = handover.submit === true;
      const target = String(handover.targetTitle ?? '');

      // Which conversations are actually open, before claiming to have put
      // anything in one. A title that matches nothing dispatches to nobody and
      // reports success, so the caller says "put it in the chat about X" about
      // a chat that does not exist — the one failure that looks exactly like
      // working, right up until you go and look at an empty composer.
      const open = await this.openConversations();
      const matched = target ? open.filter((t) => sameConversation(t, target)) : open;

      if (open.length === 0) {
        this.answer(file, { ok: false, error: 'no Claude conversation is open in the editor', panels: open });
        return;
      }
      if (matched.length === 0) {
        this.answer(file, {
          ok: false,
          error: `no open conversation matches "${target}"`,
          panels: open,
        });
        return;
      }

      await vscode.commands.executeCommand('claude-code.injectPromptVTP', text, submit, target);
      this.log(`[VTP inbox] handed over ${text.length} chars to ${matched.length} of ${open.length} conversation(s)${submit ? ', sent' : ''}`);
      this.answer(file, {
        ok: true,
        chars: text.length,
        submitted: submit,
        panels: matched,
      });
    } catch (e: any) {
      // The usual reason is the patch not being on, which is worth saying in
      // full: the caller is another program and cannot see the IDE's messages.
      const why = String(e?.message ?? e);
      this.log(`[VTP inbox] ${name} failed: ${why}`);
      this.answer(file, {
        ok: false,
        error: /command .* not found/i.test(why)
          ? 'claude-code.injectPromptVTP is not registered — the Claude Code patch is not applied in this window'
          : why,
      });
    } finally {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      this.busy.delete(file);
    }
  }

  /** The Claude conversations open in this window, by name. */
  private async openConversations(): Promise<string[]> {
    try {
      const titles = await vscode.commands.executeCommand<string[]>('claude-code.getPanelTitlesVTP');
      return Array.isArray(titles) ? titles.filter(Boolean) : [];
    } catch {
      // The command is part of the same patch as the injection itself, so its
      // absence is reported by the dispatch below rather than here.
      return [];
    }
  }

  /**
   * Read it once it is all there.
   *
   * The watcher fires on the first byte, and a file half written parses as
   * broken JSON. Reading until the size stops changing costs a few
   * milliseconds and turns a race into a wait.
   */
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

  /** Left next to it, so the other program knows what happened. */
  private answer(file: string, result: Record<string, unknown>): void {
    try {
      fs.writeFileSync(
        file.replace(/\.json$/i, '') + '.done.json',
        JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2),
        'utf8',
      );
    } catch { /* the log still has it */ }
  }
}
