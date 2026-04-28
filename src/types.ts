// Shared types for the VTP extension.
// Keep this file lean — it's the contract between all modules.

export type IntentType = 'PROMPT_CONTENT' | 'COMMAND' | 'SEND' | 'ENHANCE' | 'CANCEL';

export interface IntentResult {
  type: IntentType;
  /** Cleaned text (filler words removed). Populated for PROMPT_CONTENT. */
  content: string;
  /** Natural-language description of the desired action. Populated for COMMAND. */
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
  run?: string;    // terminal
  url?: string;    // browser
  prompt?: string; // antigravity (template, supports {activeFile})
}

// ─── Message bus between Webview ↔ Extension host ─────────────────────────

/** Messages sent FROM the Webview TO the extension host */
export type PanelMessage =
  | { type: 'startRecording' }                                 // open system browser capture page
  | { type: 'stopRecording' }                                  // user manually stopped
  | { type: 'send'; prompt: string }
  | { type: 'cancel' }
  | { type: 'ready' }
  | { type: 'openSettings' }
  | { type: 'showInfo' }
  | { type: 'micPermissionDenied' }                            // legacy — keep for safety
  | { type: 'log'; message: string };

/** Messages sent FROM the extension host TO the Webview */
export type ExtensionMessage =
  | { type: 'intentResult'; intent: IntentResult; buffer: string }
  | { type: 'commandFired'; description: string }
  | { type: 'elaborating' }
  | { type: 'elaborated'; prompt: string }
  | { type: 'injected' }
  | { type: 'error'; message: string }
  | { type: 'contextUpdate'; workspaceName: string; conversationTitle: string }
  | { type: 'settings'; vadMode: boolean; language: string }
  | { type: 'transcriptResult'; text: string }                 // transcribed audio from Gemini
  | { type: 'apiKeyStatus'; hasKey: boolean }                  // API key state for UI indicator
  | { type: 'recordingStarted' }                               // browser capture page opened
  | { type: 'recordingStopped' };                              // audio received, processing
