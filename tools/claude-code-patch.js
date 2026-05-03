#!/usr/bin/env node
/**
 * Shared patch definitions for Claude Code → VTP integration (PoC).
 *
 * This file is `require`d by patch-claude-code.js and unpatch-claude-code.js.
 * It contains:
 *   - extension-directory discovery
 *   - the regex-anchored patch pairs for extension.js, webview/index.js, package.json
 *   - the runtime helper injected into webview/index.js
 *
 * Tested against Claude Code 2.1.126.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

// Bump in lockstep with src/integrations/claudeCode/patches.ts PATCH_SCHEMA_VERSION.
const PATCH_SCHEMA_VERSION = 3;

// ─── Extension discovery ─────────────────────────────────────────────────────

/**
 * Antigravity is a VS Code fork. It stores extensions under ~/.antigravity/extensions.
 * Returns the latest installed Claude Code extension dir, or null if none found.
 */
function findClaudeCodeExtDir() {
  if (process.env.CLAUDE_CODE_EXT_DIR && fs.existsSync(process.env.CLAUDE_CODE_EXT_DIR)) {
    return process.env.CLAUDE_CODE_EXT_DIR;
  }
  const candidates = [
    path.join(os.homedir(), '.antigravity', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
  ];
  for (const root of candidates) {
    if (!fs.existsSync(root)) continue;
    const matches = fs.readdirSync(root)
      .filter(name => /^anthropic\.claude-code-/i.test(name))
      .map(name => path.join(root, name))
      .filter(p => fs.statSync(p).isDirectory())
      .sort()
      .reverse(); // newest version first (lex sort works for x.y.z)
    if (matches.length > 0) return matches[0];
  }
  return null;
}

// ─── File paths ──────────────────────────────────────────────────────────────

function extensionFiles(extDir) {
  return {
    extJs:    path.join(extDir, 'extension.js'),
    wvJs:     path.join(extDir, 'webview', 'index.js'),
    pkgJson:  path.join(extDir, 'package.json'),
    marker:   path.join(extDir, '.vtp-patched.json'),
    backupDir: path.join(extDir, '.vtp-backups'),
  };
}

// ─── Hash helper ─────────────────────────────────────────────────────────────

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ─── Patch definitions ───────────────────────────────────────────────────────
// Each entry is one regex find-and-replace against one file.
// `anchor` MUST match exactly once in the original file. Re-running the patcher
// is idempotent: if the anchor doesn't match (because the patch is already
// applied) and `applied` matches, we treat that file as already patched.

const PATCHES = {
  // Patch 1: extension.js — Inner Comm class. Add notifyVTPInject / notifyVTPSubmit
  // sibling methods to notifyToggleDictation. v2: targetTitle filter.
  extJs_innerComm: {
    file: 'extJs',
    anchor: /notifyToggleDictation\(\)\{this\.send\(\{type:"request",channelId:"",requestId:"",request:\{type:"toggle_dictation"\}\}\)\}/,
    // Marker is specific to v2 so re-apply upgrades the patch.
    appliedMarker: /notifyVTPInject\(text,submit,targetTitle\)/,
    replacement: (m) =>
      m[0]
      + 'notifyVTPInject(text,submit,targetTitle){this.send({type:"request",channelId:"",requestId:"",request:{type:"vtp_inject_prompt",text:text,submit:submit!==!1,targetTitle:targetTitle||""}})}'
      + 'notifyVTPSubmit(targetTitle){this.send({type:"request",channelId:"",requestId:"",request:{type:"vtp_submit_only",targetTitle:targetTitle||""}})}',
  },

  // Patch 2: extension.js — Manager class (the one with `this.allComms`).
  // Add manager-level notifyVTPInject / notifyVTPSubmit that fan out to allComms.
  extJs_manager: {
    file: 'extJs',
    anchor: /notifyToggleDictation\(\)\{for\(let V of this\.allComms\)V\.notifyToggleDictation\(\)\}/,
    appliedMarker: /for\(let V of this\.allComms\)V\.notifyVTPInject\(text,submit,targetTitle\)/,
    replacement: (m) =>
      m[0]
      + 'notifyVTPInject(text,submit,targetTitle){for(let V of this.allComms)V.notifyVTPInject(text,submit,targetTitle)}'
      + 'notifyVTPSubmit(targetTitle){for(let V of this.allComms)V.notifyVTPSubmit(targetTitle)}',
  },

  // Patch 3: extension.js — register commands on activation. Sibling to toggleDictation.
  extJs_commands: {
    file: 'extJs',
    anchor: /(V\.subscriptions\.push\(I4\.commands\.registerCommand\("claude-vscode\.toggleDictation",\(\)=>\{D\.notifyToggleDictation\(\)\}\)\);)/,
    appliedMarker: /claude-code\.injectPromptVTP.*targetTitle/,
    replacement: (m) =>
      m[0]
      + 'V.subscriptions.push(I4.commands.registerCommand("claude-code.injectPromptVTP",async(text,submit,targetTitle)=>{'
      +   'if(!text||typeof text!=="string"){text=await I4.window.showInputBox({prompt:"VTP — prompt to inject into Claude Code",ignoreFocusOut:true});if(!text)return;}'
      +   'try{var __n=(D&&D.allComms&&D.allComms.size)||0;I4.window.showInformationMessage("[VTP] dispatched "+text.length+" chars → "+__n+" webview(s)"+(targetTitle?" target=\\""+targetTitle.slice(0,30)+"\\"":""));}catch(e){}'
      +   'try{D.notifyVTPInject(text,submit!==false,targetTitle);}catch(e){I4.window.showErrorMessage("[VTP] dispatch threw: "+e.message);}'
      + '}));'
      + 'V.subscriptions.push(I4.commands.registerCommand("claude-code.submitVTP",(targetTitle)=>{'
      +   'try{var __n=(D&&D.allComms&&D.allComms.size)||0;I4.window.showInformationMessage("[VTP] submit → "+__n+" webview(s)"+(targetTitle?" target=\\""+targetTitle.slice(0,30)+"\\"":""));D.notifyVTPSubmit(targetTitle);}catch(e){I4.window.showErrorMessage("[VTP] submit threw: "+e.message);}'
      + '}));',
  },

  // Patch 4: webview/index.js — add vtp_inject_prompt + vtp_submit_only cases to
  // the handleRequestInner switch. v3: case-insensitive partial title match
  // (handles document.title vs tab.label format mismatches) + diagnostic log.
  wvJs_handler: {
    file: 'wvJs',
    anchor: /case"toggle_dictation":this\.toggleDictationSignal\.emit\(\);break;/,
    appliedMarker: /case"vtp_inject_prompt":[\s\S]*vtpTitleMatch/,
    replacement: (m) =>
      m[0]
      + 'case"vtp_inject_prompt":try{var _t=$.request.targetTitle||"";var _dt=document.title||"";var vtpTitleMatch=function(d,t){if(!t)return true;if(!d)return false;d=d.toLowerCase();t=t.toLowerCase();return d===t||d.indexOf(t)!==-1||t.indexOf(d)!==-1};console.log("[VTP] inject req — title=",_dt,"lock=",_t,"match=",vtpTitleMatch(_dt,_t));if(!vtpTitleMatch(_dt,_t)){break}window.__vtp_inject($.request.text,$.request.submit)}catch(e){console.error("[VTP]",e)}break;'
      + 'case"vtp_submit_only":try{var _t2=$.request.targetTitle||"";var _dt2=document.title||"";var vtpTitleMatch2=function(d,t){if(!t)return true;if(!d)return false;d=d.toLowerCase();t=t.toLowerCase();return d===t||d.indexOf(t)!==-1||t.indexOf(d)!==-1};if(!vtpTitleMatch2(_dt2,_t2)){console.log("[VTP] skip submit (title mismatch)",_dt2,_t2);break}window.__vtp_submit()}catch(e){console.error("[VTP]",e)}break;',
  },

  // Patch 5: webview/index.js — prepend the runtime helper at the very top.
  wvJs_helper: {
    file: 'wvJs',
    anchor: /^var he1=Object\.create;/,
    appliedMarker: /window\.__vtp_inject\s*=/,
    replacement: (m) => VTP_RUNTIME_HELPER + m[0],
  },

  // Patch 6: package.json — register the new commands so they appear in Command
  // Palette with friendly titles.
  pkgJson_cmds: {
    file: 'pkgJson',
    // We'll handle this one with structured JSON edit, not regex.
    json: true,
  },
};

// ─── Webview runtime helper ──────────────────────────────────────────────────
// Injected at the top of webview/index.js. Defines window.__vtp_inject and
// window.__vtp_submit. Does its best to find the real composer textarea
// without depending on minified internal symbols.

const VTP_RUNTIME_HELPER = `
(function(){
  // Visible status banner injected at the top of the webview's body.
  // Color-coded: purple = info, green = success, red = error.
  function vtpStatus(msg, kind) {
    try { console.log('[VTP]', msg); } catch(e){}
    try {
      var bid = '__vtp_status_banner';
      var b = document.getElementById(bid);
      if (!b) {
        b = document.createElement('div');
        b.id = bid;
        b.style.cssText = [
          'position:fixed','top:0','left:0','right:0','z-index:2147483647',
          'padding:8px 12px','font:600 13px ui-monospace,monospace',
          'color:#fff','text-align:center','pointer-events:none',
          'box-shadow:0 2px 6px rgba(0,0,0,.3)','letter-spacing:.3px'
        ].join(';');
        document.body.appendChild(b);
      }
      var bg = kind === 'err' ? '#dc2626' : kind === 'ok' ? '#16a34a' : '#7c3aed';
      b.style.background = bg;
      b.textContent = '[VTP] ' + msg;
      b.style.display = 'block';
      try { clearTimeout(b.__vtp_t); } catch(e){}
      b.__vtp_t = setTimeout(function(){ try { b.style.display = 'none'; } catch(e){} }, 4000);
    } catch(e) {}
  }

  function isVisible(el) {
    if (!el) return false;
    if (typeof el.offsetWidth !== 'number') return false;
    if (el.offsetWidth < 5 && el.offsetHeight < 5) return false;
    return true;
  }

  // Stash diagnostic info from last find so failure banner can show details
  window.__vtp_lastDiag = null;

  // Returns the best-scoring composer candidate among textareas + contenteditable
  // elements + role=textbox elements.
  function vtpFindComposer() {
    var hints = [/claude/i, /message/i, /prompt/i, /describe/i, /answer/i,
                 /tell claude/i, /reply/i, /ask/i, /\btype\b/i, /esc to focus/i, /unfocus/i];
    var elements = [];

    // Cast a wide net — anything that could be an editable surface
    var allEditables = Array.prototype.slice.call(
      document.querySelectorAll('textarea, [contenteditable], [contenteditable=""], [role="textbox"]'));

    var tally = { ta: 0, ce: 0, tb: 0, monaco: 0, hidden: 0 };

    for (var i = 0; i < allEditables.length; i++) {
      var el = allEditables[i];
      var visible = isVisible(el);
      var kind;
      if (el.tagName === 'TEXTAREA') {
        if (el.disabled || el.readOnly) continue;
        if (el.className && /inputarea/.test(el.className)) { tally.monaco++; continue; } // skip Monaco's hidden input
        kind = 'textarea';
        tally.ta++;
      } else if (el.hasAttribute('contenteditable')) {
        kind = 'contenteditable';
        tally.ce++;
      } else if (el.getAttribute('role') === 'textbox') {
        kind = 'role-textbox';
        tally.tb++;
      } else {
        continue;
      }
      if (!visible) { tally.hidden++; continue; }
      elements.push({el: el, kind: kind});
    }

    function metaText(el) {
      return [
        el.getAttribute('placeholder') || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('data-placeholder') || '',
        el.getAttribute('aria-placeholder') || '',
        el.getAttribute('title') || '',
        // Pull placeholder text from a nearby [data-placeholder] or [class*="placeholder"] sibling
        (function(){
          var p = el.parentElement;
          if (!p) return '';
          var sib = p.querySelector('[data-placeholder], [class*="placeholder"], [class*="Placeholder"]');
          return sib ? (sib.getAttribute('data-placeholder') || sib.textContent || '') : '';
        })(),
      ].join(' ');
    }

    function scoreOf(c) {
      var el = c.el;
      var meta = metaText(el).toLowerCase();
      var s = 0;
      for (var i = 0; i < hints.length; i++) if (hints[i].test(meta)) s += 6;
      if (el.getAttribute('role') === 'textbox') s += 5;
      if (c.kind === 'contenteditable') s += 3;
      var r = el.getBoundingClientRect();
      s += Math.min((r.width * r.height) / 15000, 5); // larger area = better
      s += Math.min(r.bottom / Math.max(window.innerHeight, 1), 1) * 2; // closer to bottom = better
      if (r.width < 80) s -= 3;
      // Dock-bonus: if there's an autosize/grow-style class
      var cls = el.className || '';
      if (typeof cls === 'string' && /(composer|chatinput|prompt|input)/i.test(cls)) s += 4;
      return s;
    }

    var scored = elements.map(function(c) { return {c: c, s: scoreOf(c), meta: metaText(c.el)}; });
    scored.sort(function(a, b) { return b.s - a.s; });

    var diag = {
      tally: tally,
      total: elements.length,
      top: scored.slice(0, 5).map(function(x) {
        var r = x.c.el.getBoundingClientRect();
        return {
          kind: x.c.kind,
          score: Math.round(x.s * 10) / 10,
          tag: x.c.el.tagName,
          role: x.c.el.getAttribute('role'),
          ce: x.c.el.getAttribute('contenteditable'),
          cls: (typeof x.c.el.className === 'string' ? x.c.el.className : '').slice(0, 60),
          meta: (x.meta || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
          rect: Math.round(r.width)+'x'+Math.round(r.height)+'@'+Math.round(r.left)+','+Math.round(r.top),
        };
      }),
    };
    window.__vtp_lastDiag = diag;
    try { console.log('[VTP] composer scan:', diag); } catch(e){}

    if (scored.length === 0) return null;
    // Loose threshold: even score 0 is acceptable as long as something visible+editable exists
    return scored[0].s > -10 ? scored[0].c : null;
  }

  function vtpSetTextareaValue(el, val) {
    var proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (proto && proto.set) proto.set.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function vtpSetContentEditable(el, val) {
    try { el.focus(); } catch(e){}
    // Select all existing content
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch(e){}

    // Approach 1: dispatch a synthetic beforeinput → React/ProseMirror often listens here
    var be = null;
    try {
      be = new InputEvent('beforeinput', {
        inputType: 'insertReplacementText',
        data: val,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(be);
    } catch(e){}

    // Approach 2: execCommand (works for ProseMirror, Lexical, plain contentEditable)
    var did = false;
    try { did = document.execCommand('insertText', false, val); } catch(e){}

    // Approach 3 (fallback): if the above didn't write, force the DOM and fire input
    if (!did && el.textContent !== val) {
      try { el.textContent = val; } catch(e){}
    }

    // Always fire input so React state syncs
    try {
      el.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText',
        data: val,
        bubbles: true,
      }));
    } catch(e){
      // InputEvent constructor not supported — fall back to a plain Event
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch(e2){}
    }
  }

  function vtpFindSendButton(near) {
    var sels = [
      'button[aria-label*="send" i]:not([disabled])',
      'button[title*="send" i]:not([disabled])',
      'button[data-testid*="send" i]:not([disabled])',
      'button[type="submit"]:not([disabled])'
    ];
    var scopes = [];
    if (near) {
      var f = near.closest && near.closest('form'); if (f) scopes.push(f);
      var c = near.closest && near.closest('[role="form"]'); if (c) scopes.push(c);
      var p = near.parentElement; if (p) scopes.push(p);
      // Walk up 4 levels for a containing scope
      var anc = near;
      for (var i = 0; i < 4 && anc; i++) {
        anc = anc.parentElement;
        if (anc) scopes.push(anc);
      }
    }
    scopes.push(document);
    for (var s = 0; s < scopes.length; s++) {
      for (var i = 0; i < sels.length; i++) {
        try {
          var btn = scopes[s].querySelector(sels[i]);
          if (btn && isVisible(btn)) return btn;
        } catch(e){}
      }
    }
    return null;
  }

  window.__vtp_inject = function(text, submit) {
    try { console.log('[VTP] __vtp_inject called', String(text||'').slice(0,80), 'submit=', submit); } catch(e){}
    var c = vtpFindComposer();
    if (!c) {
      var d = window.__vtp_lastDiag || {tally:{}};
      var t = d.tally || {};
      var top0 = (d.top && d.top[0]) || null;
      var msg = 'inject failed: ta=' + (t.ta||0) + ' ce=' + (t.ce||0) + ' txbox=' + (t.tb||0)
              + ' mona=' + (t.monaco||0) + ' hidden=' + (t.hidden||0);
      if (top0) msg += ' top=' + top0.kind + '/' + top0.score + '/' + top0.rect + ' meta="' + (top0.meta||'').slice(0,30) + '"';
      vtpStatus(msg, 'err');
      return false;
    }
    try { console.log('[VTP] picked:', c.kind, (c.el.outerHTML||'').slice(0, 180)); } catch(e){}

    try {
      if (c.kind === 'textarea') vtpSetTextareaValue(c.el, String(text || ''));
      else vtpSetContentEditable(c.el, String(text || ''));
      try { c.el.focus(); } catch(e){}
    } catch (e) {
      vtpStatus('inject error: ' + e.message, 'err');
      return false;
    }
    vtpStatus('injected ' + String(text||'').length + ' chars into ' + c.kind, 'ok');

    if (submit === false) return true;

    setTimeout(function() {
      var btn = vtpFindSendButton(c.el);
      if (btn) {
        try { btn.click(); console.log('[VTP] clicked send button'); } catch(e){ console.warn('[VTP] click failed', e); }
        return;
      }
      try {
        c.el.dispatchEvent(new KeyboardEvent('keydown', {
          key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true
        }));
        console.log('[VTP] dispatched Enter (no send button found)');
      } catch(e){}
    }, 120);

    return true;
  };

  window.__vtp_submit = function() {
    try { console.log('[VTP] __vtp_submit called'); } catch(e){}
    var c = vtpFindComposer();
    var btn = vtpFindSendButton(c && c.el);
    if (btn) { try { btn.click(); } catch(e){} return true; }
    if (c) {
      try {
        c.el.dispatchEvent(new KeyboardEvent('keydown', {
          key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true
        }));
      } catch(e){}
      return true;
    }
    vtpStatus('submit failed: no target', 'err');
    return false;
  };

  // Diagnostic helper — call from DevTools console: window.__vtp_diag()
  window.__vtp_diag = function() {
    var c = vtpFindComposer();
    var info = {
      url: location.href,
      title: document.title,
      composer: null,
    };
    if (c) {
      info.composer = {
        kind: c.kind,
        tag: c.el.tagName,
        role: c.el.getAttribute('role'),
        placeholder: c.el.getAttribute('placeholder'),
        ariaLabel: c.el.getAttribute('aria-label'),
        dataPlaceholder: c.el.getAttribute('data-placeholder'),
        outer: (c.el.outerHTML || '').slice(0, 300),
      };
    }
    info.allTextareas = Array.prototype.slice
      .call(document.querySelectorAll('textarea'))
      .map(function(t){ return {ph: t.getAttribute('placeholder'), aria: t.getAttribute('aria-label'), cls: t.className.slice(0,40), v: isVisible(t)}; });
    info.allContentEditables = Array.prototype.slice
      .call(document.querySelectorAll('[contenteditable]'))
      .map(function(t){ return {ph: t.getAttribute('placeholder') || t.getAttribute('aria-label') || t.getAttribute('data-placeholder'), tag: t.tagName, cls: (t.className||'').slice(0,40), v: isVisible(t)}; });
    console.log('[VTP DIAG]', info);
    return info;
  };
})();
`;

// ─── Apply / detect / unapply ────────────────────────────────────────────────

/**
 * Checks if a single patch is applied / unapplied / unknown.
 * Returns 'applied', 'unapplied', or 'broken'.
 */
function patchStatus(content, patch) {
  if (patch.appliedMarker && patch.appliedMarker.test(content)) return 'applied';
  if (patch.anchor.test(content)) return 'unapplied';
  return 'broken';
}

/**
 * Applies the regex patches. Returns { changed, results: [...] }
 */
function applyPatches(files, patches) {
  const results = [];
  let extJs = fs.readFileSync(files.extJs,  'utf-8');
  let wvJs  = fs.readFileSync(files.wvJs,   'utf-8');

  for (const [name, patch] of Object.entries(patches)) {
    if (patch.json) continue; // pkgJson handled separately
    const content = patch.file === 'extJs' ? extJs : wvJs;
    const status  = patchStatus(content, patch);
    if (status === 'applied') {
      results.push({ name, status: 'already-applied' });
      continue;
    }
    if (status === 'broken') {
      results.push({ name, status: 'anchor-not-found' });
      continue;
    }
    const updated = content.replace(patch.anchor, (...args) => patch.replacement(args));
    if (updated === content) {
      results.push({ name, status: 'replace-noop' });
      continue;
    }
    if (patch.file === 'extJs') extJs = updated;
    else wvJs = updated;
    results.push({ name, status: 'applied' });
  }

  return { extJs, wvJs, results };
}

/**
 * Patches package.json to surface the new commands in Command Palette.
 */
function patchPackageJson(files) {
  const raw = fs.readFileSync(files.pkgJson, 'utf-8');
  const pkg = JSON.parse(raw);
  pkg.contributes = pkg.contributes || {};
  pkg.contributes.commands = pkg.contributes.commands || [];

  const wanted = [
    { command: 'claude-code.injectPromptVTP', title: 'Claude Code: Inject Prompt (VTP)' },
    { command: 'claude-code.submitVTP',       title: 'Claude Code: Submit Composer (VTP)' },
  ];

  const have = new Set(pkg.contributes.commands.map(c => c.command));
  let added = 0;
  for (const w of wanted) {
    if (!have.has(w.command)) {
      pkg.contributes.commands.push(w);
      added++;
    }
  }
  if (added === 0) return { changed: false, content: raw };
  return { changed: true, content: JSON.stringify(pkg, null, 2) + '\n' };
}

module.exports = {
  findClaudeCodeExtDir,
  extensionFiles,
  sha256,
  PATCHES,
  PATCH_SCHEMA_VERSION,
  applyPatches,
  patchPackageJson,
  patchStatus,
};
