/**
 * Patcher orchestration — apply, restore, and status-check the Claude Code
 * hot-patch from inside the extension.
 *
 * Public surface:
 *   ensurePatched()    — verify+apply on extension activation, idempotent.
 *   restoreOriginal()  — roll back to the most recent backup.
 *   getStatus()        — quick status report for UI/diagnostics.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  PATCHES, ExtensionFiles, applyPatches, patchPackageJson, patchStatus, sha256,
  findClaudeCodeExtDir, extensionFiles, PATCH_SCHEMA_VERSION,
} from './patches';

export interface PatchStatus {
  installed: boolean;
  extDir: string | null;
  version: string | null;
  patched: boolean;
  marker?: PatchMarker;
  /** True when the marker exists but its patchSchemaVersion is older than current. */
  schemaOutdated?: boolean;
}

export interface PatchMarker {
  version: string;
  /** Patch schema version written at apply time. Used to detect stale patches. */
  patchSchemaVersion?: number;
  appliedAt: string;
  backupDir: string;
  sha: {
    orig: { extJs: string; wvJs: string; pkgJson: string };
    patched: { extJs: string; wvJs: string; pkgJson: string };
  };
}

function ts(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function readPkgVersion(pkgJsonPath: string): string {
  return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')).version;
}

export function getStatus(): PatchStatus {
  const extDir = findClaudeCodeExtDir();
  if (!extDir) return { installed: false, extDir: null, version: null, patched: false };
  const f = extensionFiles(extDir);
  let version: string | null = null;
  try { version = readPkgVersion(f.pkgJson); } catch { /* ignore */ }
  let marker: PatchMarker | undefined;
  let patched = false;
  let schemaOutdated = false;
  if (fs.existsSync(f.marker)) {
    try {
      marker = JSON.parse(fs.readFileSync(f.marker, 'utf-8'));
      // Verify all regex patches still present (matches the CURRENT schema)
      const extJs = fs.readFileSync(f.extJs, 'utf-8');
      const wvJs  = fs.readFileSync(f.wvJs,  'utf-8');
      patched = Object.values(PATCHES).every((p) => {
        if ((p as any).json) return true;
        const content = (p as any).file === 'extJs' ? extJs : wvJs;
        return patchStatus(content, p) === 'applied';
      });
      schemaOutdated = (marker?.patchSchemaVersion ?? 1) < PATCH_SCHEMA_VERSION;
    } catch { /* ignore */ }
  }
  return { installed: true, extDir, version, patched, marker, schemaOutdated };
}

/**
 * Apply patches if needed. Returns true if a patch was applied this call.
 *
 * Behaviour:
 *   - No Claude Code installed → no-op, returns false.
 *   - Already patched + same version + all anchors verified → no-op, returns false.
 *   - Marker for old version → re-apply, returns true.
 *   - First-time → apply + create backup, returns true.
 */
export async function ensurePatched(log?: (m: string) => void): Promise<boolean> {
  const status = getStatus();
  const _log = log ?? (() => {});

  if (!status.installed || !status.extDir) {
    _log('[VTP/claude-code] extension not installed, skipping patch');
    return false;
  }

  // Detect three reasons to re-apply: Claude version changed, our patch schema
  // changed, or marker exists but patches no longer all match (e.g. partial state).
  const versionChanged = status.marker && status.marker.version !== status.version;
  const schemaChanged  = status.schemaOutdated === true;
  const partialPatch   = status.marker && !status.patched;

  if (status.patched && !versionChanged && !schemaChanged) {
    _log(`[VTP/claude-code] already patched (v${status.version}, schema v${PATCH_SCHEMA_VERSION})`);
    return false;
  }

  if (versionChanged) {
    _log(`[VTP/claude-code] Claude Code v${status.marker!.version} → v${status.version} — re-applying`);
  } else if (schemaChanged) {
    _log(`[VTP/claude-code] patch schema v${status.marker?.patchSchemaVersion ?? 1} → v${PATCH_SCHEMA_VERSION} — re-applying`);
  } else if (partialPatch) {
    _log('[VTP/claude-code] marker exists but patches incomplete — restoring + re-applying');
  }

  if (versionChanged || schemaChanged || partialPatch) {
    try { await restoreOriginal(_log); } catch { /* proceed even if restore fails */ }
  }

  const f = extensionFiles(status.extDir);
  const version = status.version!;

  // Verify anchors before touching anything
  const origExtJs = fs.readFileSync(f.extJs, 'utf-8');
  const origWvJs  = fs.readFileSync(f.wvJs,  'utf-8');
  const origPkg   = fs.readFileSync(f.pkgJson, 'utf-8');

  const broken: string[] = [];
  for (const [name, patch] of Object.entries(PATCHES)) {
    if ((patch as any).json) continue;
    const content = (patch as any).file === 'extJs' ? origExtJs : origWvJs;
    if (patchStatus(content, patch) === 'broken') broken.push(name);
  }
  if (broken.length > 0) {
    _log(`[VTP/claude-code] anchors not found: ${broken.join(', ')} — Claude Code source likely changed in v${version}. Aborting.`);
    throw new Error(`VTP patch anchors missing for Claude Code v${version}: ${broken.join(', ')}`);
  }

  // Backup
  const backupSubdir = path.join(f.backupDir, ts());
  fs.mkdirSync(path.join(backupSubdir, 'webview'), { recursive: true });
  fs.copyFileSync(f.extJs,   path.join(backupSubdir, 'extension.js'));
  fs.copyFileSync(f.wvJs,    path.join(backupSubdir, 'webview', 'index.js'));
  fs.copyFileSync(f.pkgJson, path.join(backupSubdir, 'package.json'));
  _log(`[VTP/claude-code] backup → ${backupSubdir}`);

  // Apply regex patches
  const { extJs, wvJs } = applyPatches(f);
  fs.writeFileSync(f.extJs, extJs, 'utf-8');
  fs.writeFileSync(f.wvJs,  wvJs,  'utf-8');

  // Apply pkgJson edit
  const pkgPatch = patchPackageJson(f);
  if (pkgPatch.changed) fs.writeFileSync(f.pkgJson, pkgPatch.content, 'utf-8');

  // Validate package.json still parses
  try { JSON.parse(fs.readFileSync(f.pkgJson, 'utf-8')); }
  catch (e: any) { throw new Error('package.json invalid after patch: ' + e.message); }

  // Marker
  const marker: PatchMarker = {
    version,
    patchSchemaVersion: PATCH_SCHEMA_VERSION,
    appliedAt: new Date().toISOString(),
    backupDir: backupSubdir,
    sha: {
      orig:    { extJs: sha256(origExtJs), wvJs: sha256(origWvJs), pkgJson: sha256(origPkg) },
      patched: { extJs: sha256(extJs),     wvJs: sha256(wvJs),     pkgJson: sha256(fs.readFileSync(f.pkgJson, 'utf-8')) },
    },
  };
  fs.writeFileSync(f.marker, JSON.stringify(marker, null, 2));
  _log(`[VTP/claude-code] applied for v${version} (schema v${PATCH_SCHEMA_VERSION})`);
  return true;
}

/**
 * Restore Claude Code to its pre-VTP state by copying the most recent backup
 * over the current files and removing the patch marker.
 */
export async function restoreOriginal(log?: (m: string) => void): Promise<boolean> {
  const _log = log ?? (() => {});
  const status = getStatus();
  if (!status.installed || !status.extDir) {
    _log('[VTP/claude-code] not installed, nothing to restore');
    return false;
  }
  const f = extensionFiles(status.extDir);
  if (!fs.existsSync(f.backupDir)) {
    _log('[VTP/claude-code] no backups available');
    return false;
  }
  const backups = fs.readdirSync(f.backupDir)
    .filter((n) => fs.statSync(path.join(f.backupDir, n)).isDirectory())
    .sort()
    .reverse();
  if (backups.length === 0) {
    _log('[VTP/claude-code] no backups in backup dir');
    return false;
  }
  const latest = path.join(f.backupDir, backups[0]);
  const restorePairs: Array<[string, string]> = [
    [path.join(latest, 'extension.js'), f.extJs],
    [path.join(latest, 'webview', 'index.js'), f.wvJs],
    [path.join(latest, 'package.json'), f.pkgJson],
  ];
  for (const [src, dst] of restorePairs) {
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  if (fs.existsSync(f.marker)) {
    fs.renameSync(f.marker, f.marker.replace(/\.json$/, '.restored-' + Date.now() + '.json'));
  }
  _log(`[VTP/claude-code] restored from ${backups[0]}`);
  return true;
}
