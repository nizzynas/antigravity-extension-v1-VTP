import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { PATCHES, extensionFiles, patchStatus, PATCH_SCHEMA_VERSION } from './patches';
import { resolveExtDir } from './patcher';

export interface Health {
  at: string;
  ide: string;
  claudeCode: { version: string | null; dir: string | null };
  patches: Record<string, string>;
  commands: { inject: boolean; submit: boolean; titles: boolean };
  schema: number;
  working: boolean;
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
    } catch {}

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
  } catch {}

  return health;
}

export function describeHealth(h: Health): string {
  if (h.working) return `VTP is wired into Claude Code ${h.claudeCode.version} and working.`;
  return `VTP is not wired into Claude Code${h.claudeCode.version ? ` ${h.claudeCode.version}` : ''}: ${h.wrong[0] ?? 'unknown'}`;
}
