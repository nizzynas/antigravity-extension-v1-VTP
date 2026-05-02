#!/usr/bin/env node
/**
 * Apply VTP integration patch to the locally installed Claude Code extension.
 *
 * Usage:
 *   node tools/patch-claude-code.js
 *   CLAUDE_CODE_EXT_DIR=<path> node tools/patch-claude-code.js
 *
 * What it does:
 *   1. Locates Claude Code extension dir (~/.antigravity/extensions/anthropic.claude-code-*).
 *   2. Backs up extension.js, webview/index.js, package.json into a timestamped folder.
 *   3. Applies regex-anchored patches that add two commands:
 *        - claude-code.injectPromptVTP(text, submit?)   →  insert text into composer (and submit by default)
 *        - claude-code.submitVTP()                      →  submit whatever's already in the composer
 *   4. Writes a marker file (.vtp-patched.json) recording version + sha + backup dir.
 *
 * Idempotent: re-running with no Claude updates is a no-op.
 *
 * Reload the IDE window (Developer: Reload Window) AFTER patching for the new
 * commands to register.
 */

const fs   = require('fs');
const path = require('path');
const {
  findClaudeCodeExtDir, extensionFiles, sha256,
  PATCHES, applyPatches, patchPackageJson, patchStatus,
} = require('./claude-code-patch');

function ts() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function exitErr(msg, code = 1) {
  console.error('\nERROR: ' + msg + '\n');
  process.exit(code);
}

function autoUnpatchIfNeeded(f) {
  if (!fs.existsSync(f.marker)) return false;
  const backups = fs.existsSync(f.backupDir)
    ? fs.readdirSync(f.backupDir).filter(n => fs.statSync(path.join(f.backupDir, n)).isDirectory()).sort().reverse()
    : [];
  if (backups.length === 0) {
    console.log('  (force): marker exists but no backup found — proceeding without unpatch');
    return false;
  }
  const latest = path.join(f.backupDir, backups[0]);
  console.log('  (force): restoring from backup ' + backups[0] + ' before re-patching');
  const restore = [
    [path.join(latest, 'extension.js'), f.extJs],
    [path.join(latest, 'webview', 'index.js'), f.wvJs],
    [path.join(latest, 'package.json'), f.pkgJson],
  ];
  for (const [src, dst] of restore) {
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  // Move the old marker aside so the marker check below sees a clean state
  const stale = f.marker.replace(/\.json$/, '.replaced-' + Date.now() + '.json');
  fs.renameSync(f.marker, stale);
  return true;
}

function main() {
  const args  = process.argv.slice(2);
  const force = args.includes('--force') || args.includes('-f');

  const extDir = findClaudeCodeExtDir();
  if (!extDir) exitErr('Claude Code extension not found. Set CLAUDE_CODE_EXT_DIR or install the extension.');
  console.log('Extension dir: ' + extDir);

  const f   = extensionFiles(extDir);
  const pkg = JSON.parse(fs.readFileSync(f.pkgJson, 'utf-8'));
  const version = pkg.version;
  console.log('Claude Code version: ' + version);

  if (force && fs.existsSync(f.marker)) {
    console.log('--force passed: rolling back to original before re-patching');
    autoUnpatchIfNeeded(f);
  }

  // Idempotency check via marker
  if (fs.existsSync(f.marker)) {
    const marker = JSON.parse(fs.readFileSync(f.marker, 'utf-8'));
    if (marker.version === version) {
      // Re-verify the patches are actually present
      const extJs = fs.readFileSync(f.extJs, 'utf-8');
      const wvJs  = fs.readFileSync(f.wvJs,  'utf-8');
      let allApplied = true;
      for (const [name, patch] of Object.entries(PATCHES)) {
        if (patch.json) continue;
        const content = patch.file === 'extJs' ? extJs : wvJs;
        if (patchStatus(content, patch) !== 'applied') { allApplied = false; break; }
      }
      if (allApplied) {
        console.log('Already patched (version ' + version + ', applied at ' + marker.appliedAt + '). Nothing to do.');
        console.log('Pass --force to re-apply (rolls back to original first).');
        return;
      }
      console.log('Marker exists but at least one patch is missing. Re-applying.');
    } else {
      console.log('Marker is for old version ' + marker.version + '. Re-applying for ' + version + '.');
    }
  }

  // Read originals
  const origExtJs = fs.readFileSync(f.extJs, 'utf-8');
  const origWvJs  = fs.readFileSync(f.wvJs,  'utf-8');
  const origPkg   = fs.readFileSync(f.pkgJson, 'utf-8');

  // Verify anchors before touching anything
  console.log('\nVerifying patch anchors...');
  for (const [name, patch] of Object.entries(PATCHES)) {
    if (patch.json) { console.log('  ' + name + ': (json file, structured edit)'); continue; }
    const content = patch.file === 'extJs' ? origExtJs : origWvJs;
    const status  = patchStatus(content, patch);
    console.log('  ' + name + ': ' + status);
    if (status === 'broken') {
      exitErr('Anchor not found for "' + name + '" — Claude Code source likely changed. Aborting (no files modified).');
    }
  }

  // Backup
  const backupSubdir = path.join(f.backupDir, ts());
  fs.mkdirSync(backupSubdir, { recursive: true });
  fs.mkdirSync(path.join(backupSubdir, 'webview'), { recursive: true });
  fs.copyFileSync(f.extJs,   path.join(backupSubdir, 'extension.js'));
  fs.copyFileSync(f.wvJs,    path.join(backupSubdir, 'webview', 'index.js'));
  fs.copyFileSync(f.pkgJson, path.join(backupSubdir, 'package.json'));
  console.log('\nBackup: ' + backupSubdir);

  // Apply
  const { extJs, wvJs, results } = applyPatches(f, PATCHES);
  console.log('\nPatch results:');
  for (const r of results) console.log('  ' + r.name + ': ' + r.status);

  const pkgPatch = patchPackageJson(f);
  console.log('  pkgJson_cmds: ' + (pkgPatch.changed ? 'applied' : 'already-applied'));

  // Write
  fs.writeFileSync(f.extJs, extJs, 'utf-8');
  fs.writeFileSync(f.wvJs,  wvJs,  'utf-8');
  if (pkgPatch.changed) fs.writeFileSync(f.pkgJson, pkgPatch.content, 'utf-8');

  // Verify package.json still parses
  try { JSON.parse(fs.readFileSync(f.pkgJson, 'utf-8')); }
  catch (e) { exitErr('package.json is no longer valid JSON after patching: ' + e.message); }

  // Marker
  const marker = {
    version,
    appliedAt: new Date().toISOString(),
    backupDir: backupSubdir,
    sha: {
      orig:    { extJs: sha256(origExtJs), wvJs: sha256(origWvJs), pkgJson: sha256(origPkg) },
      patched: { extJs: sha256(extJs),     wvJs: sha256(wvJs),     pkgJson: sha256(fs.readFileSync(f.pkgJson, 'utf-8')) },
    },
  };
  fs.writeFileSync(f.marker, JSON.stringify(marker, null, 2));
  console.log('\nMarker: ' + f.marker);

  console.log('\n✓ Patch applied. To activate:');
  console.log('  1. In Antigravity, Cmd/Ctrl+Shift+P → "Developer: Reload Window"');
  console.log('  2. Open a Claude Code chat tab so a webview is alive');
  console.log('  3. Cmd/Ctrl+Shift+P → "Claude Code: Inject Prompt (VTP)"');
  console.log('  4. Type a test prompt and hit Enter — it should appear in the chat and submit.');
  console.log('\nTo revert: node tools/unpatch-claude-code.js');
}

main();
