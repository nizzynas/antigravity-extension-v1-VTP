import * as vscode from 'vscode';

/** Minimal types matching ms-vscode.vscode-speech export surface */
interface SpeechSessionEvent {
  readonly status: SpeechStatus;
  readonly text?: string;
}

const enum SpeechStatus {
  Started     = 1,
  Recognizing = 2,  // interim
  Recognized  = 3,  // final
  Stopped     = 4,
  Error       = 5,
}

interface SpeechSession {
  readonly onDidChange: vscode.Event<SpeechSessionEvent>;
}

interface SpeechAPI {
  createSpeechToTextSession(token: vscode.CancellationToken): SpeechSession;
  readonly hasSpeechProvider: boolean;
}

export type TranscriptHandler = (text: string, isFinal: boolean) => void;
export type ErrorHandler = (message: string) => void;

/**
 * Thin wrapper around the VS Code Speech extension API.
 * Uses local on-device processing — no API quota, no browser tab.
 */
export class VoiceCapture {
  private cts: vscode.CancellationTokenSource | null = null;

  /** Returns true if ms-vscode.vscode-speech (or compatible) is installed. */
  static isAvailable(): boolean {
    return !!vscode.extensions.getExtension('ms-vscode.vscode-speech');
  }

  async start(onTranscript: TranscriptHandler, onError: ErrorHandler): Promise<void> {
    const ext = vscode.extensions.getExtension<SpeechAPI>('ms-vscode.vscode-speech');
    if (!ext) {
      onError('VS Code Speech extension (ms-vscode.vscode-speech) is not installed.');
      return;
    }

    const api: SpeechAPI = ext.isActive ? ext.exports : await ext.activate();

    if (!api?.createSpeechToTextSession) {
      onError('Speech extension loaded but API is unavailable. Try updating ms-vscode.vscode-speech.');
      return;
    }

    this.cts = new vscode.CancellationTokenSource();
    const session = api.createSpeechToTextSession(this.cts.token);

    session.onDidChange((e: SpeechSessionEvent) => {
      switch (e.status) {
        case SpeechStatus.Recognizing:
          if (e.text) onTranscript(e.text, false);
          break;
        case SpeechStatus.Recognized:
          if (e.text) onTranscript(e.text, true);
          break;
        case SpeechStatus.Error:
          onError('Speech recognition error — check your microphone.');
          break;
        case SpeechStatus.Stopped:
          break; // Normal stop
      }
    });
  }

  stop(): void {
    this.cts?.cancel();
    this.cts?.dispose();
    this.cts = null;
  }

  isRunning(): boolean {
    return this.cts !== null && !this.cts.token.isCancellationRequested;
  }
}
