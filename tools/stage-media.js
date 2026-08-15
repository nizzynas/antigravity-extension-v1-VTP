#!/usr/bin/env node
/**
 * Copy the speech engine into media/ before building.
 *
 * The panel runs in a webview, and a webview's content policy will not fetch
 * script from anywhere else — so vosk.js has to sit inside the extension and
 * be loaded by file path. That is why it was committed: it has to be in the
 * packaged extension, and copying it in by hand was the shortest way there.
 *
 * It does not have to be in the repository, though. It is `vosk-browser`'s own
 * build, byte for byte, and `vosk-browser` is already a dependency — so the
 * copy in git was 5.6MB of something npm can hand over on demand, kept forever
 * in the history of a public repo and impossible to take out again later.
 *
 * Run before build and before packaging. Idempotent, and silent when there is
 * nothing to do.
 *
 *   node tools/stage-media.js
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const NEEDED = [
  {
    from: path.join(root, 'node_modules', 'vosk-browser', 'dist', 'vosk.js'),
    to: path.join(root, 'media', 'vendor', 'vosk.js'),
    why: 'the speech engine, loaded by the panel webview',
  },
];

let missing = 0;

for (const item of NEEDED) {
  if (!fs.existsSync(item.from)) {
    console.error(`stage-media: ${path.relative(root, item.from)} is not there — run npm install first.`);
    missing++;
    continue;
  }

  // Same bytes already in place: leave it alone rather than rewriting a 5MB
  // file on every build.
  if (fs.existsSync(item.to) && fs.statSync(item.to).size === fs.statSync(item.from).size) continue;

  fs.mkdirSync(path.dirname(item.to), { recursive: true });
  fs.copyFileSync(item.from, item.to);
  console.log(`stage-media: ${path.relative(root, item.to)} ← ${item.why}`);
}

process.exit(missing ? 1 : 0);
