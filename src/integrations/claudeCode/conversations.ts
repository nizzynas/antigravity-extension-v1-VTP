/**
 * Conversation enumeration + lock for Claude Code.
 *
 * We enumerate open Claude Code conversation tabs via VS Code's tabGroups API
 * (no Claude-side patches needed for this part). The user locks one by title;
 * all subsequent injects pass `targetTitle` through the patched IPC and only
 * the matching webview acts on the message.
 */

import * as vscode from 'vscode';

export interface ClaudeConversation {
  /** Display label, used as the targetTitle filter on the webview side. */
  title: string;
  /** True if this tab is currently active in its tab group. */
  isActive: boolean;
}

const CLAUDE_VIEW_TYPES = [
  'mainThreadWebview-claudeVSCodePanel',
  'claudeVSCodePanel',
];

/**
 * Strip trailing ellipsis ("…" or "...") and surrounding whitespace.
 * VS Code's tab.label gives us a truncated display form like
 * "Migrate antigravity data…" but Claude's panel.title (which the patched
 * extension compares against) is the FULL conversation title. Stripping the
 * truncation marker lets the substring match in the patch line up correctly.
 */
function stripEllipsis(s: string): string {
  return (s || '').replace(/[….]+\s*$/, '').trim();
}

/**
 * Returns all open Claude Code conversation tabs (newest active first).
 * Empty array if none open.
 *
 * Prefers titles read from `claude-code.getPanelTitlesVTP` (the patched
 * command exposes panel.title directly — full, untruncated). Falls back to
 * VS Code's `tab.label` (which is truncated to ~24 chars by the tab UI) if
 * the command isn't registered yet (patch not applied / Claude not active).
 */
export async function listClaudeConversations(): Promise<ClaudeConversation[]> {
  // Build a map of title → isActive from tab.label first so we know which
  // tabs are currently focused — getPanelTitlesVTP doesn't expose that.
  const tabInfo = new Map<string, boolean>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input: any = tab.input;
      const viewType: string | undefined = input?.viewType;
      const isClaude = viewType
        ? CLAUDE_VIEW_TYPES.some((v) => viewType === v || viewType.endsWith(v))
        : false;
      if (!isClaude) continue;
      const label = stripEllipsis(tab.label || '');
      if (!label) continue;
      // If multiple tabs have the same label, OR the active flags.
      tabInfo.set(label, (tabInfo.get(label) || false) || tab.isActive);
    }
  }

  // Pull full titles from the patched Claude manager.
  let fullTitles: string[] = [];
  try {
    const result = await vscode.commands.executeCommand<string[]>('claude-code.getPanelTitlesVTP');
    if (Array.isArray(result)) fullTitles = result.filter((t): t is string => typeof t === 'string' && t.length > 0);
  } catch {
    // Patch not active — fall back to tab.label only.
  }

  const out: ClaudeConversation[] = [];
  const seen = new Set<string>();

  if (fullTitles.length > 0) {
    // Map each full title to its active flag by finding the tab whose
    // (truncated) label is a prefix of the full title.
    for (const full of fullTitles) {
      if (seen.has(full)) continue;
      seen.add(full);
      let isActive = false;
      for (const [tabLabel, tabActive] of tabInfo) {
        if (full === tabLabel || full.startsWith(tabLabel) || tabLabel.startsWith(full)) {
          isActive = isActive || tabActive;
        }
      }
      out.push({ title: full, isActive });
    }
  } else {
    // Fallback path: use the (truncated) tab labels as titles.
    for (const [label, isActive] of tabInfo) {
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({ title: label, isActive });
    }
  }

  out.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
  return out;
}

const LOCKED_TITLE_KEY = 'claudeCodeLockedTitle';

/** Returns the currently-locked Claude conversation title (empty string if none). */
export function getLockedTitle(): string {
  return vscode.workspace.getConfiguration('vtp').get<string>(LOCKED_TITLE_KEY, '') || '';
}

/** Persist the locked title at user/global scope. Pass empty string to unlock. */
export async function setLockedTitle(title: string): Promise<void> {
  await vscode.workspace.getConfiguration('vtp')
    .update(LOCKED_TITLE_KEY, title, vscode.ConfigurationTarget.Global);
}

/**
 * Show a quick-pick of open Claude conversations and persist the user's choice
 * as the lock target. Returns the chosen title (or null if cancelled).
 */
export async function pickAndLockConversation(): Promise<string | null> {
  const convs = await listClaudeConversations();
  const current = getLockedTitle();

  if (convs.length === 0) {
    vscode.window.showWarningMessage(
      'VTP: No Claude Code conversation tabs open. Open a chat first, then run this command again.',
    );
    return null;
  }

  const items: Array<vscode.QuickPickItem & { title: string }> = convs.map((c) => ({
    label: (c.isActive ? '$(eye) ' : '') + c.title,
    description: c.isActive ? 'currently active' : '',
    title: c.title,
    picked: current === c.title,
  }));
  // Prepend an "unlock" entry if currently locked
  const unlockItem: vscode.QuickPickItem & { title: string } = {
    label: '$(unlock) (unlock — fan to all open chats)',
    description: '',
    title: '',
  };
  const all: Array<vscode.QuickPickItem & { title: string }> = current
    ? [unlockItem, ...items]
    : items;

  const pick = await vscode.window.showQuickPick(all, {
    title: 'VTP — Lock prompts to a Claude Code conversation',
    placeHolder: current ? `Currently locked: "${current}"` : 'Pick the chat that should receive prompts',
    ignoreFocusOut: true,
  });
  if (!pick) return null;

  await setLockedTitle(pick.title);
  if (pick.title === '') {
    vscode.window.showInformationMessage('VTP: unlocked — prompts will fan to all open Claude chats.');
    return '';
  }
  vscode.window.showInformationMessage(`VTP: locked to "${pick.title}".`);
  return pick.title;
}
