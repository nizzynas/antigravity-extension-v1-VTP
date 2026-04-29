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
  | { type: 'startRecording' }
  | { type: 'stopRecording' }
  | { type: 'pauseRecording' }                                 // kill mic, keep buffer, no process
  | { type: 'resumeRecording' }                                // restart mic, append to buffer
  | { type: 'send'; prompt: string }
  | { type: 'cancel' }
  | { type: 'ready' }
  | { type: 'openSettings' }
  | { type: 'showInfo' }
  | { type: 'setVadMode'; vadMode: boolean }
  | { type: 'log'; message: string }
  /** User clicked the context card — open the conversation picker */
  | { type: 'selectContext' }
  /** Enhancement review decision: approve keeps enhanced, reject restores original, regenerate re-elaborates */
  | { type: 'enhancementDecision'; action: 'approve' | 'reject' | 'regenerate' }
  /** User clicked the DG button to manage their optional Deepgram API key */
  | { type: 'manageDeepgramKey' }
  /** User clicked the ⌨ KEY button — open VS Code keyboard shortcut editor for VTP */
  | { type: 'openKeybindings' }
  /** Onboarding completed — persist engine choice, keys, and flow preferences */
  | { type: 'onboardingComplete'; engine: 'gemini' | 'deepgram'; geminiKey?: string; deepgramKey?: string; activationMode: 'wake' | 'manual'; postSendMode: 'continuous' | 'pause'; wakePhrase: string }
  /** Settings panel saved new preferences */
  | { type: 'applySettings'; activationMode: 'wake' | 'manual'; postSendMode: 'continuous' | 'pause'; wakePhrase: string }
  /** User switched transcription engine from the engine picker dropdown */
  | { type: 'setEngine'; engine: 'gemini' | 'deepgram' }
  /** Voice activation toggle changed from the panel (legacy compat, kept for keybind path) */
  | { type: 'setVoiceActivation'; enabled: boolean; wakePhrase: string };



/** Messages sent FROM the extension host TO the Webview */
export type ExtensionMessage =
  | { type: 'intentResult'; intent: IntentResult; buffer: string }
  | { type: 'commandFired'; description: string }
  | { type: 'elaborating' }
  | { type: 'elaborated'; prompt: string; original: string }   // prompt=enhanced, original=saved original
  | { type: 'enhancedApproved' }                               // panel: commit enhanced text
  | { type: 'enhancedRejected'; original: string }             // panel: restore original text
  | { type: 'injected' }
  | { type: 'error'; message: string }
  | { type: 'contextUpdate'; workspaceName: string; conversationTitle: string; pinned?: boolean; extrasCount?: number }
  | { type: 'settings'; vadMode: boolean }
  | { type: 'transcriptResult'; text: string }
  | { type: 'apiKeyStatus'; hasKey: boolean }
  /** Deepgram key status (optional — only sent when Deepgram is configured) */
  | { type: 'deepgramKeyStatus'; hasKey: boolean; active: boolean; engine: 'gemini' | 'deepgram' }

  | { type: 'recordingStarted' }
  | { type: 'recordingStopped' }
  | { type: 'vadAutoStop' }
  | { type: 'paused' }       // manual pause confirmed
  | { type: 'resumed' }      // manual resume confirmed
  | { type: 'autoPaused' }   // auto-pause triggered by extended silence
  | { type: 'wakeReady' }    // FFmpeg initialized, wake monitor is listening
  | { type: 'awaitingDecision' }   // non-decision speech discarded during enhance review
  /** Tell the webview to render the first-run onboarding wizard */
  | { type: 'showOnboarding' }
  /** Notify webview of current flow settings (sent on ready + after applySettings) */
  | { type: 'settingsStatus'; activationMode: 'wake' | 'manual'; postSendMode: 'continuous' | 'pause'; wakePhrase: string };
