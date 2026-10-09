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

  dispose(): void {}
}
