/**
 * Whether the patch is actually working, written somewhere you can read it.
 *
 * The failure this exists for: Claude Code updates, the anchors no longer
 * match the new minified build, and the only sign is that talking to it stops
 * doing anything. The patcher reports it applied patches — it did, to whatever
 * anchors still matched — and the marker file says a version that is no longer
 * installed. You find out days later, and then have no idea which of the seven
 * anchors moved.
 *
 * Two things are checked, because either alone lies:
 *
 *   the file  — do the patches read as applied in the files on disk right now.
 *               Says which anchor is missing, which is the one thing that makes
 *               a broken patch fixable rather than mysterious.
 *   the room  — did the command actually register in this window. Files can be
 *               perfect and the extension host still be running the copy it
 *               loaded before the patch, at which point nothing works and the
 *               files all look right.
 *
 * Written to a file as well as the log, so a program outside the IDE can tell
 * whether it is worth handing anything over.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { PATCHES, extensionFiles, patchStatus, PATCH_SCHEMA_VERSION } from './patches';
import { resolveExtDir } from './patcher';

export interface Health {
  at: string;
  /** The IDE this was checked in — one machine can have several. */
  ide: string;
  claudeCode: { version: string | null; dir: string | null };
  /** Per anchor: applied, unapplied, or broken. */
  patches: Record<string, string>;
  /** Whether the patched-in commands exist in this window. */
  commands: { inject: boolean; submit: boolean; titles: boolean };
  schema: number;
  /** True only if every part of it holds. */
  working: boolean;
  /** What to look at first, when it is not. */
  wrong: string[];
}

export function healthFile(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'VTP', 'health.json');
}

export async function checkHealth(): Promise<Health> {
  const at = new Date().toISOString();
  const ide = `${vscode.env.appName} ${vscode.version}`;
  const wrong: string[] = [];

  const dir = resolveExtDir();
  const patches: Record<string, string> = {};
  let version: string | null = null;

  if (!dir) {
    wrong.push('Claude Code is not installed in this IDE, or not activated in this window');
  } else {
    const files = extensionFiles(dir);
    try {
      version = JSON.parse(fs.readFileSync(files.pkgJson, 'utf8')).version ?? null;
    } catch { /* unreadable, which the anchors below will also show */ }

    let extJs = '', wvJs = '', pkgJson = '';
    try {
      extJs = fs.readFileSync(files.extJs, 'utf8');
      wvJs = fs.readFileSync(files.wvJs, 'utf8');
      pkgJson = fs.readFileSync(files.pkgJson, 'utf8');
    } catch (e: any) {
      wrong.push(`cannot read the extension files: ${e?.message ?? e}`);
    }

    for (const [name, patch] of Object.entries(PATCHES)) {
      if ((patch as any).json) {
        patches[name] = pkgJson.includes('injectPromptVTP') ? 'applied' : 'unapplied';
      } else {
        const content = (patch as any).file === 'extJs' ? extJs : wvJs;
        patches[name] = content ? patchStatus(content, patch as any) : 'unknown';
      }
      if (patches[name] !== 'applied') {
        // Named individually, and the two failures kept apart, because they
        // want opposite things done. "The patch failed" is a shrug; one of
        // these is a button to press and the other is a regex to go and fix.
        wrong.push(patches[name] === 'unapplied'
          ? `${name} has not been applied to Claude Code ${version ?? '?'} — its anchor still matches, so applying the patch will fix it`
          : `${name} no longer matches Claude Code ${version ?? '?'} — the anchor needs updating for this build`);
      }
    }
  }

  const all = await vscode.commands.getCommands(true);
  const commands = {
    inject: all.includes('claude-code.injectPromptVTP'),
    submit: all.includes('claude-code.submitVTP'),
    titles: all.includes('claude-code.getPanelTitlesVTP'),
  };
  if (!commands.inject) {
    wrong.push(
      Object.values(patches).every((s) => s === 'applied')
        ? 'the files are patched but the command is missing — this window is still running the copy it loaded before the patch, so reload it'
        : 'claude-code.injectPromptVTP is not registered',
    );
  }

  const health: Health = {
    at, ide,
    claudeCode: { version, dir },
    patches,
    commands,
    schema: PATCH_SCHEMA_VERSION,
    working: commands.inject && Object.values(patches).every((s) => s === 'applied'),
    wrong,
  };

  try {
    fs.mkdirSync(path.dirname(healthFile()), { recursive: true });
    fs.writeFileSync(healthFile(), JSON.stringify(health, null, 2), 'utf8');
  } catch { /* the log still has it */ }

  return health;
}

/** One line, for the log and for a message box. */
export function describeHealth(h: Health): string {
  if (h.working) return `VTP is wired into Claude Code ${h.claudeCode.version} and working.`;
  return `VTP is not wired into Claude Code${h.claudeCode.version ? ` ${h.claudeCode.version}` : ''}: ${h.wrong[0] ?? 'unknown'}`;
}
