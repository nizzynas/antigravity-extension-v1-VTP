/**
 * patches.ts — Patch definitions for the Claude Code → VTP hot-patch.
 *
 * MIRROR of tools/claude-code-patch.js. Keep these two files in sync; the
 * tools/ scripts are the user-facing CLI form, this is the extension-side
 * embedded form. If you change one, change the other.
 *
 * Tested against Claude Code 2.1.126 (anthropic.claude-code).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Extension discovery ─────────────────────────────────────────────────────

export function findClaudeCodeExtDir(): string | null {
  if (process.env.CLAUDE_CODE_EXT_DIR && fs.existsSync(process.env.CLAUDE_CODE_EXT_DIR)) {
    return process.env.CLAUDE_CODE_EXT_DIR;
  }
  const roots = [
    path.join(os.homedir(), '.antigravity', 'extensions'),
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const matches = fs.readdirSync(root)
      .filter((name) => /^anthropic\.claude-code-/i.test(name))
      .map((name) => path.join(root, name))
      .filter((p) => {
        try { return fs.statSync(p).isDirectory(); } catch { return false; }
      })
      .sort()
      .reverse();
    if (matches.length > 0) return matches[0];
  }
  return null;
}

export interface ExtensionFiles {
  extJs: string;
  wvJs: string;
  pkgJson: string;
  marker: string;
  backupDir: string;
}

export function extensionFiles(extDir: string): ExtensionFiles {
  return {
    extJs:    path.join(extDir, 'extension.js'),
    wvJs:     path.join(extDir, 'webview', 'index.js'),
    pkgJson:  path.join(extDir, 'package.json'),
    marker:   path.join(extDir, '.vtp-patched.json'),
    backupDir: path.join(extDir, '.vtp-backups'),
  };
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ─── Webview runtime helper (prepended to webview/index.js) ──────────────────
// MUST match tools/claude-code-patch.js byte-for-byte.

export const VTP_RUNTIME_HELPER = `
(function(){
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

  window.__vtp_lastDiag = null;

  function vtpFindComposer() {
    var hints = [/claude/i, /message/i, /prompt/i, /describe/i, /answer/i,
                 /tell claude/i, /reply/i, /ask/i, /\\btype\\b/i, /esc to focus/i, /unfocus/i];
    var elements = [];
    var allEditables = Array.prototype.slice.call(
      document.querySelectorAll('textarea, [contenteditable], [contenteditable=""], [role="textbox"]'));
    var tally = { ta: 0, ce: 0, tb: 0, monaco: 0, hidden: 0 };
    for (var i = 0; i < allEditables.length; i++) {
      var el = allEditables[i];
      var visible = isVisible(el);
      var kind;
      if (el.tagName === 'TEXTAREA') {
        if (el.disabled || el.readOnly) continue;
        if (el.className && /inputarea/.test(el.className)) { tally.monaco++; continue; }
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
      s += Math.min((r.width * r.height) / 15000, 5);
      s += Math.min(r.bottom / Math.max(window.innerHeight, 1), 1) * 2;
      if (r.width < 80) s -= 3;
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
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch(e){}
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
    var did = false;
    try { did = document.execCommand('insertText', false, val); } catch(e){}
    if (!did && el.textContent !== val) {
      try { el.textContent = val; } catch(e){}
    }
    try {
      el.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText',
        data: val,
        bubbles: true,
      }));
    } catch(e){
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

// ─── Patch definitions ───────────────────────────────────────────────────────

interface RegexPatch {
  file: 'extJs' | 'wvJs';
  anchor: RegExp;
  appliedMarker: RegExp;
  /** Build the replacement given the matched anchor text. */
  replacement: (matchedAnchor: string) => string;
}

interface JsonPatch { json: true; }

type Patch = RegexPatch | JsonPatch;

export const PATCHES: Record<string, Patch> = {
  extJs_innerComm: {
    file: 'extJs',
    anchor: /notifyToggleDictation\(\)\{this\.send\(\{type:"request",channelId:"",requestId:"",request:\{type:"toggle_dictation"\}\}\)\}/,
    appliedMarker: /notifyVTPInject\(/,
    replacement: (m) =>
      m
      + 'notifyVTPInject(text,submit){this.send({type:"request",channelId:"",requestId:"",request:{type:"vtp_inject_prompt",text:text,submit:submit!==!1}})}'
      + 'notifyVTPSubmit(){this.send({type:"request",channelId:"",requestId:"",request:{type:"vtp_submit_only"}})}',
  },
  extJs_manager: {
    file: 'extJs',
    anchor: /notifyToggleDictation\(\)\{for\(let V of this\.allComms\)V\.notifyToggleDictation\(\)\}/,
    appliedMarker: /for\(let V of this\.allComms\)V\.notifyVTPInject\(/,
    replacement: (m) =>
      m
      + 'notifyVTPInject(text,submit){for(let V of this.allComms)V.notifyVTPInject(text,submit)}'
      + 'notifyVTPSubmit(){for(let V of this.allComms)V.notifyVTPSubmit()}',
  },
  extJs_commands: {
    file: 'extJs',
    anchor: /(V\.subscriptions\.push\(I4\.commands\.registerCommand\("claude-vscode\.toggleDictation",\(\)=>\{D\.notifyToggleDictation\(\)\}\)\);)/,
    appliedMarker: /claude-code\.injectPromptVTP/,
    replacement: (m) =>
      m
      + 'V.subscriptions.push(I4.commands.registerCommand("claude-code.injectPromptVTP",async(text,submit)=>{'
      +   'if(!text||typeof text!=="string"){text=await I4.window.showInputBox({prompt:"VTP — prompt to inject into Claude Code",ignoreFocusOut:true});if(!text)return;}'
      +   'try{var __n=(D&&D.allComms&&D.allComms.size)||0;I4.window.showInformationMessage("[VTP] dispatched "+text.length+" chars → "+__n+" webview(s)");}catch(e){}'
      +   'try{D.notifyVTPInject(text,submit!==false);}catch(e){I4.window.showErrorMessage("[VTP] dispatch threw: "+e.message);}'
      + '}));'
      + 'V.subscriptions.push(I4.commands.registerCommand("claude-code.submitVTP",()=>{'
      +   'try{var __n=(D&&D.allComms&&D.allComms.size)||0;I4.window.showInformationMessage("[VTP] submit → "+__n+" webview(s)");D.notifyVTPSubmit();}catch(e){I4.window.showErrorMessage("[VTP] submit threw: "+e.message);}'
      + '}));',
  },
  wvJs_handler: {
    file: 'wvJs',
    anchor: /case"toggle_dictation":this\.toggleDictationSignal\.emit\(\);break;/,
    appliedMarker: /case"vtp_inject_prompt":/,
    replacement: (m) =>
      m
      + 'case"vtp_inject_prompt":try{window.__vtp_inject($.request.text,$.request.submit)}catch(e){console.error("[VTP]",e)}break;'
      + 'case"vtp_submit_only":try{window.__vtp_submit()}catch(e){console.error("[VTP]",e)}break;',
  },
  wvJs_helper: {
    file: 'wvJs',
    anchor: /^var he1=Object\.create;/,
    appliedMarker: /window\.__vtp_inject\s*=/,
    replacement: (m) => VTP_RUNTIME_HELPER + m,
  },
  pkgJson_cmds: { json: true },
};

// ─── Patch status / apply helpers ────────────────────────────────────────────

export type PatchStatus = 'applied' | 'unapplied' | 'broken';

export function patchStatus(content: string, patch: Patch): PatchStatus {
  if ((patch as JsonPatch).json) return 'applied'; // json handled separately
  const rx = patch as RegexPatch;
  if (rx.appliedMarker.test(content)) return 'applied';
  if (rx.anchor.test(content)) return 'unapplied';
  return 'broken';
}

export function applyPatches(files: ExtensionFiles): {
  extJs: string;
  wvJs: string;
  results: Array<{ name: string; status: string }>;
} {
  let extJs = fs.readFileSync(files.extJs, 'utf-8');
  let wvJs  = fs.readFileSync(files.wvJs,  'utf-8');
  const results: Array<{ name: string; status: string }> = [];

  for (const [name, patch] of Object.entries(PATCHES)) {
    if ((patch as JsonPatch).json) continue;
    const rx = patch as RegexPatch;
    const content = rx.file === 'extJs' ? extJs : wvJs;
    const status = patchStatus(content, rx);
    if (status === 'applied') { results.push({ name, status: 'already-applied' }); continue; }
    if (status === 'broken')  { results.push({ name, status: 'anchor-not-found' }); continue; }
    const updated = content.replace(rx.anchor, (matched: string) => rx.replacement(matched));
    if (updated === content) { results.push({ name, status: 'replace-noop' }); continue; }
    if (rx.file === 'extJs') extJs = updated;
    else wvJs = updated;
    results.push({ name, status: 'applied' });
  }
  return { extJs, wvJs, results };
}

export function patchPackageJson(files: ExtensionFiles): { changed: boolean; content: string } {
  const raw = fs.readFileSync(files.pkgJson, 'utf-8');
  const pkg = JSON.parse(raw);
  pkg.contributes = pkg.contributes || {};
  pkg.contributes.commands = pkg.contributes.commands || [];
  const wanted = [
    { command: 'claude-code.injectPromptVTP', title: 'Claude Code: Inject Prompt (VTP)' },
    { command: 'claude-code.submitVTP',       title: 'Claude Code: Submit Composer (VTP)' },
  ];
  const have = new Set<string>(pkg.contributes.commands.map((c: any) => c.command));
  let added = 0;
  for (const w of wanted) {
    if (!have.has(w.command)) { pkg.contributes.commands.push(w); added++; }
  }
  if (added === 0) return { changed: false, content: raw };
  return { changed: true, content: JSON.stringify(pkg, null, 2) + '\n' };
}
