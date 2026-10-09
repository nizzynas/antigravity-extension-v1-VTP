import * as vscode from 'vscode';

export interface ClaudeConversation {
  title: string;
  isActive: boolean;
}

const CLAUDE_VIEW_TYPES = [
  'mainThreadWebview-claudeVSCodePanel',
  'claudeVSCodePanel',
];

function stripEllipsis(s: string): string {
  return (s || '').replace(/[….]+\s*$/, '').trim();
}

export async function listClaudeConversations(): Promise<ClaudeConversation[]> {
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
      tabInfo.set(label, (tabInfo.get(label) || false) || tab.isActive);
    }
  }

  let fullTitles: string[] = [];
  try {
    const result = await vscode.commands.executeCommand<string[]>('claude-code.getPanelTitlesVTP');
    if (Array.isArray(result)) fullTitles = result.filter((t): t is string => typeof t === 'string' && t.length > 0);
  } catch {
  }

  const out: ClaudeConversation[] = [];
  const seen = new Set<string>();

  if (fullTitles.length > 0) {
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

export function getLockedTitle(): string {
  return vscode.workspace.getConfiguration('vtp').get<string>(LOCKED_TITLE_KEY, '') || '';
}

export async function setLockedTitle(title: string): Promise<void> {
  await vscode.workspace.getConfiguration('vtp')
    .update(LOCKED_TITLE_KEY, title, vscode.ConfigurationTarget.Global);
}

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
