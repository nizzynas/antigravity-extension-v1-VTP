export type IntentType = 'PROMPT_CONTENT' | 'COMMAND' | 'SEND' | 'ENHANCE' | 'CANCEL';

export type InjectionTarget = 'antigravity' | 'claude-code';

export interface IntentResult {
  type: IntentType;
  content: string;
  commandIntent?: string;
}

export interface WorkspaceContext {
  workspaceName: string;
  activeFile: { path: string; content: string; language: string } | null;
  openEditors: { path: string; content: string }[];
  gitDiff: string;
  projectMeta: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface MatchedConversation {
  id: string;
  title: string;
  messages: ConversationMessage[];
  score: number;
}

export interface CustomCommand {
  triggers: string[];
  action: 'terminal' | 'browser' | 'antigravity';
  run?: string;
  url?: string;
  prompt?: string;
}

export type PanelMessage =
  | { type: 'startRecording' }
  | { type: 'stopRecording' }
  | { type: 'pauseRecording' }
  | { type: 'resumeRecording' }
  | { type: 'send'; prompt: string }
  | { type: 'cancel' }
  | { type: 'ready' }
  | { type: 'openSettings' }
  | { type: 'showInfo' }
  | { type: 'setVadMode'; vadMode: boolean }
  | { type: 'log'; message: string }
  | { type: 'selectContext' }
  | { type: 'enhancementDecision'; action: 'approve' | 'reject' | 'regenerate' }
  | { type: 'openKeybindings' }
  | { type: 'switchInjectionTarget' }
  | { type: 'lockClaudeConversation' }
  | { type: 'onboardingComplete'; activationMode: 'wake' | 'manual'; postSendMode: 'continuous' | 'pause'; wakePhrase: string }
  | { type: 'applySettings'; activationMode: 'wake' | 'manual'; postSendMode: 'continuous' | 'pause'; wakePhrase: string }
  | { type: 'setVoiceActivation'; enabled: boolean; wakePhrase: string }
  | { type: 'micTest' }
  | { type: 'setInputGate'; db: number }
  | { type: 'voskReady' }
  | { type: 'voskError'; message: string }
  | { type: 'voskPartial'; text: string }
  | { type: 'voskResult'; text: string };



export type ExtensionMessage =
  | { type: 'intentResult'; intent: IntentResult; buffer: string }
  | { type: 'commandFired'; description: string }
  | { type: 'elaborating' }
  | { type: 'elaborated'; prompt: string; original: string }
  | { type: 'enhancedApproved' }
  | { type: 'enhancedRejected'; original: string }
  | { type: 'injected' }
  | { type: 'error'; message: string }
  | { type: 'contextUpdate'; workspaceName: string; conversationTitle: string; pinned?: boolean; extrasCount?: number }
  | { type: 'settings'; vadMode: boolean }
  | { type: 'transcriptResult'; text: string }
  | { type: 'hotkeyStatus'; combo: string }
  | { type: 'voskModelChunk'; data: string; index: number; count: number; done: boolean }
  | { type: 'voskStart' }
  | { type: 'voskPcm'; data: string }
  | { type: 'voskStop' }
  | { type: 'modelStatus'; state: 'downloading' | 'loading' | 'ready' | 'error'; pct?: number; message?: string }
  | { type: 'micState'; on: boolean; device?: string; test?: boolean; gateDb?: number }
  | { type: 'micLevel'; rms: number; peak: number; stalled: boolean; msSinceStt: number; gateOpen: boolean; gateDb: number }

  | { type: 'recordingStarted' }
  | { type: 'recordingStopped' }
  | { type: 'vadAutoStop' }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'autoPaused' }
  | { type: 'wakeReady' }
  | { type: 'awaitingDecision' }
  | { type: 'showOnboarding' }
  | { type: 'settingsStatus'; activationMode: 'wake' | 'manual'; postSendMode: 'continuous' | 'pause'; wakePhrase: string }
  | { type: 'targetState'; target: 'antigravity' | 'claude-code'; lockedTitle: string };
