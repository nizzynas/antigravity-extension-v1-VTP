#!/usr/bin/env node
/**
 * Restore the Claude Code extension to its pre-VTP state.
 *
 * Usage:
 *   node tools/unpatch-claude-code.js              # restore most recent backup
 *   node tools/unpatch-claude-code.js --list       # list backups
 *   node tools/unpatch-claude-code.js --backup <name>  # restore a specific backup
 *
 * Reload the IDE window after running.
 */

const fs   = require('fs');
const path = require('path');
const { findClaudeCodeExtDir, extensionFiles } = require('./claude-code-patch');

function exitErr(msg, code = 1) {
  console.error('\nERROR: ' + msg + '\n');
  process.exit(code);
}

function listBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter(name => fs.statSync(path.join(backupDir, name)).isDirectory())
    .sort()
    .reverse();
}

function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const backupArgIdx = args.indexOf('--backup');
  const explicitBackup = backupArgIdx !== -1 ? args[backupArgIdx + 1] : null;

  const extDir = findClaudeCodeExtDir();
  if (!extDir) exitErr('Claude Code extension not found.');
  const f = extensionFiles(extDir);

  const backups = listBackups(f.backupDir);
  if (backups.length === 0) exitErr('No backups found in ' + f.backupDir);

  if (listOnly) {
    console.log('Backups in ' + f.backupDir + ':');
    for (const b of backups) console.log('  ' + b);
    return;
  }

  const chosen = explicitBackup || backups[0];
  const sourceDir = path.join(f.backupDir, chosen);
  if (!fs.existsSync(sourceDir)) exitErr('Backup not found: ' + sourceDir);

  const restore = [
    [path.join(sourceDir, 'extension.js'), f.extJs],
    [path.join(sourceDir, 'webview', 'index.js'), f.wvJs],
    [path.join(sourceDir, 'package.json'), f.pkgJson],
  ];

  console.log('Restoring from: ' + chosen);
  for (const [src, dst] of restore) {
    if (!fs.existsSync(src)) {
      console.warn('  (skip, missing in backup) ' + path.basename(dst));
      continue;
    }
    fs.copyFileSync(src, dst);
    console.log('  restored ' + path.relative(extDir, dst));
  }

  if (fs.existsSync(f.marker)) {
    const restoredMarker = f.marker.replace(/\.json$/, '.restored.json');
    fs.renameSync(f.marker, restoredMarker);
    console.log('  marker → ' + path.relative(extDir, restoredMarker));
  }

  console.log('\n✓ Restored. Reload the IDE window for the change to take effect.');
}

main();
