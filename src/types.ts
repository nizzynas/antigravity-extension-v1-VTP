// Shared types for the VTP extension.
// Keep this file lean — it's the contract between all modules.

export type IntentType = 'PROMPT_CONTENT' | 'COMMAND' | 'SEND' | 'ENHANCE' | 'CANCEL';

/** Where VTP routes injected prompts. Antigravity = native chat; claude-code = patched Claude Code extension. */
export type InjectionTarget = 'antigravity' | 'claude-code';

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
  /** User clicked the ⌨ KEY button — open VS Code keyboard shortcut editor for VTP */
  | { type: 'openKeybindings' }
  /** User clicked the target toggle button — open the target picker */
  | { type: 'switchInjectionTarget' }
  /** User wants to (re)lock the Claude Code conversation target */
  | { type: 'lockClaudeConversation' }
  /** Onboarding completed — persist flow preferences (no keys; VTP is fully local) */
  | { type: 'onboardingComplete'; activationMode: 'wake' | 'manual'; postSendMode: 'continuous' | 'pause'; wakePhrase: string }
  /** Settings panel saved new preferences */
  | { type: 'applySettings'; activationMode: 'wake' | 'manual'; postSendMode: 'continuous' | 'pause'; wakePhrase: string }
  /** Voice activation toggle changed from the panel (legacy compat, kept for keybind path) */
  | { type: 'setVoiceActivation'; enabled: boolean; wakePhrase: string }
  /** User clicked the input meter while idle — run a short mic-only level test. */
  | { type: 'micTest' }
  /** User dragged the sensitivity marker on the input meter (dBFS). */
  | { type: 'setInputGate'; db: number }
  // ─── Local Vosk STT (webview → host) ──────────────────────────────────────
  /** Vosk model finished loading in the webview and is ready to transcribe. */
  | { type: 'voskReady' }
  /** Vosk / mic error surfaced from the webview. */
  | { type: 'voskError'; message: string }
  /** Interim (partial) transcript while the user is speaking. */
  | { type: 'voskPartial'; text: string }
  /** Final transcript for a completed utterance. */
  | { type: 'voskResult'; text: string };



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
  /** Global hotkey combo, shown in the record hint. */
  | { type: 'hotkeyStatus'; combo: string }
  // ─── Local Vosk STT (host → webview) ──────────────────────────────────────
  /**
   * Model bytes streamed to the webview as base64 chunks (Antigravity's webview
   * won't serve the large globalStorage file via fetch). `done` marks the last
   * chunk; the webview reassembles them into a Blob for Vosk.createModel.
   */
  | { type: 'voskModelChunk'; data: string; index: number; count: number; done: boolean }
  /** Create a fresh recognizer for a new capture session. */
  | { type: 'voskStart' }
  /** Feed a chunk of base64-encoded s16le/16kHz PCM (from host FFmpeg) to Vosk. */
  | { type: 'voskPcm'; data: string }
  /** Flush + tear down the recognizer at the end of a session. */
  | { type: 'voskStop' }
  /** Progress / status of the one-time model download + load. */
  | { type: 'modelStatus'; state: 'downloading' | 'loading' | 'ready' | 'error'; pct?: number; message?: string }
  // ─── Input meter ──────────────────────────────────────────────────────────
  /** Mic capture started/stopped host-side. `device` is the OS input FFmpeg opened. */
  | { type: 'micState'; on: boolean; device?: string; test?: boolean; gateDb?: number }
  /**
   * Live input level, emitted ~10×/sec while the mic is on. `rms`/`peak` are
   * linear 0..1. `stalled` means FFmpeg has sent no bytes at all recently (dead
   * device), as opposed to sending silence. `msSinceStt` is the time since Vosk
   * last returned any words — lets the panel say "audio is fine, STT is not".
   * `gateOpen` is whether audio is currently passing the sensitivity gate.
   */
  | { type: 'micLevel'; rms: number; peak: number; stalled: boolean; msSinceStt: number; gateOpen: boolean; gateDb: number }

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
  | { type: 'settingsStatus'; activationMode: 'wake' | 'manual'; postSendMode: 'continuous' | 'pause'; wakePhrase: string }
  /** Current injection target + (optional) Claude Code lock label, sent on ready and after switch */
  | { type: 'targetState'; target: 'antigravity' | 'claude-code'; lockedTitle: string };
