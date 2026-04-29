/**
 * GlobalHotkey — stub.
 *
 * Global hotkey is handled by VS Code's native keybinding system via the
 * `contributes.keybindings` entry in package.json (default: Ctrl+Shift+Space).
 *
 * Users can remap it via:
 *   Keyboard Shortcuts editor → search "VTP: Toggle Recording"
 *   (Ctrl+K Ctrl+S to open)
 *
 * The native node-global-key-listener approach was removed because it
 * requires platform-specific binaries that conflict with VS Code's
 * security sandbox (spawn UNKNOWN on Windows).
 */

import * as vscode from 'vscode';

export interface GlobalHotkeyDeps {
  log: (msg: string) => void;
  onTrigger: () => void;
}

export class GlobalHotkey {
  constructor(private readonly deps: GlobalHotkeyDeps) {}

  start(): void {
    const cfg = vscode.workspace.getConfiguration('vtp');
    const combo = cfg.get<string>('globalHotkey', 'Ctrl+Shift+Space');
    this.deps.log(
      `[VTP] Hotkey is managed by VS Code keybindings (${combo}). ` +
      'Remap via: Keyboard Shortcuts → search "VTP: Toggle Recording".',
    );
  }

  dispose(): void { /* nothing to clean up */ }
}
