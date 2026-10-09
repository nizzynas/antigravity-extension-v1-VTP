import * as vscode from 'vscode';
import type { ExtensionMessage } from '../types';

export interface SettingsManagerDeps {
  log: (msg: string) => void;
  send: (msg: ExtensionMessage) => void;
}

export class SettingsManager {
  constructor(private deps: SettingsManagerDeps) {}

  async handleOpenSettings(): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      'VTP runs fully locally — no API key needed. Speech is transcribed on-device with Vosk. ' +
      'For smart prompt "enhance", install Ollama and pull a model (e.g. `ollama pull llama3.2`).',
      'Get Ollama',
      'Re-download Speech Model',
    );
    if (action === 'Get Ollama') {
      vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
    } else if (action === 'Re-download Speech Model') {
      await vscode.commands.executeCommand('vtp.redownloadModel');
    }
  }

  async showInfo(): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      'VTP is 100% local. Nothing you say leaves this machine. ' +
      'Transcription: Vosk (offline). Enhancement: optional local Ollama.',
      'How it works',
      'Get Ollama',
    );
    if (action === 'How it works') {
      vscode.env.openExternal(vscode.Uri.parse('https://github.com/nizzynas/antigravity-extension-v1-VTP#readme'));
    } else if (action === 'Get Ollama') {
      vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
    }
  }
}
