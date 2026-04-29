/**
 * SettingsManager — handles all API key and Deepgram configuration UI flows.
 *
 * Extracted from VTPPanel to keep the orchestrator focused on recording logic.
 * All methods are async because they show VS Code UI prompts.
 */

import * as vscode from 'vscode';
import { SecretManager } from '../config/SecretManager';
import type { ExtensionMessage } from '../types';

export interface SettingsManagerDeps {
  secretManager: SecretManager;
  log: (msg: string) => void;
  send: (msg: ExtensionMessage) => void;
}

export class SettingsManager {
  private deps: SettingsManagerDeps;

  constructor(deps: SettingsManagerDeps) {
    this.deps = deps;
  }

  // ── API Key ─────────────────────────────────────────────────────────────────

  async sendApiKeyStatus(): Promise<void> {
    const key = await this.deps.secretManager.getApiKey();
    this.deps.send({ type: 'apiKeyStatus', hasKey: !!key });
    this.deps.log(`[VTP] API key status: ${key ? 'set' : 'not set'}`);
  }

  async handleOpenSettings(): Promise<void> {
    const existing = await this.deps.secretManager.getApiKey();
    if (existing) {
      const action = await vscode.window.showInformationMessage(
        'VTP: Gemini API key is active ✔', 'Update Key',
      );
      if (action === 'Update Key') {
        const newKey = await this.deps.secretManager.promptForApiKey();
        if (newKey) { await this.sendApiKeyStatus(); }
      }
    } else {
      const key = await this.deps.secretManager.promptForApiKey();
      if (key) { await this.sendApiKeyStatus(); }
    }
  }

  async showApiKeyInfo(): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      'VTP uses Gemini for intent classification and prompt elaboration. Get a free key at Google AI Studio.',
      'Open AI Studio',
      'Enter My Key Now',
    );
    if (action === 'Open AI Studio') {
      vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com/apikey'));
    } else if (action === 'Enter My Key Now') {
      await this.handleOpenSettings();
    }
  }

  handleMicDenied(): void {
    // FFmpeg is already the primary mic source — webview denial is expected, nothing to do.
  }

  // ── Deepgram ────────────────────────────────────────────────────────────────

  async sendDeepgramKeyStatus(): Promise<void> {
    const key = await this.deps.secretManager.getSecret('vtp.deepgramApiKey');
    const engine = vscode.workspace.getConfiguration('vtp').get<string>('transcriptionEngine', 'gemini');
    this.deps.send({ type: 'deepgramKeyStatus', hasKey: !!key, active: engine === 'deepgram', engine: engine as 'gemini' | 'deepgram' });
    this.deps.log(`[VTP] Deepgram status: ${key ? 'key set' : 'no key'}, engine=${engine}`);
  }

  /**
   * Full opt-in onboarding flow for the optional Deepgram transcription engine.
   *
   * Deepgram is a 3rd-party service — we always show a disclosure first.
   * The key is stored ONLY in VS Code SecretStorage on this machine.
   * Nothing is ever sent anywhere except api.deepgram.com when recording.
   */
  async handleDeepgramKey(): Promise<void> {
    const existingKey = await this.deps.secretManager.getSecret('vtp.deepgramApiKey');
    const engine = vscode.workspace.getConfiguration('vtp').get<string>('transcriptionEngine', 'gemini');

    if (existingKey && engine === 'deepgram') {
      // Already active — offer privacy settings, disable, or remove
      const action = await vscode.window.showInformationMessage(
        'Deepgram real-time transcription is active ✔. Your API key is stored locally in VS Code SecretStorage.',
        'Privacy Settings',
        'Disable Deepgram',
        'Remove Key',
        'Cancel',
      );

      if (action === 'Privacy Settings') {
        await this.handleDeepgramPrivacySettings();
      } else if (action === 'Disable Deepgram') {
        await vscode.workspace.getConfiguration('vtp').update('transcriptionEngine', 'gemini', vscode.ConfigurationTarget.Global);
        this.deps.log('[VTP] Deepgram disabled — switched back to Gemini transcription.');
      } else if (action === 'Remove Key') {
        await this.deps.secretManager.deleteSecret('vtp.deepgramApiKey');
        await vscode.workspace.getConfiguration('vtp').update('transcriptionEngine', 'gemini', vscode.ConfigurationTarget.Global);
        this.deps.log('[VTP] Deepgram API key removed.');
      }
      await this.sendDeepgramKeyStatus();
      return;
    }

    // ── First-time disclosure ──
    const disclosure = await vscode.window.showInformationMessage(
      [
        '⚡ Deepgram is an optional 3rd-party service that reduces transcription latency from ~5s to ~300ms.',
        'Free API key is all you need.',
        '| Data usage: Deepgram transcribes your audio and by default uses it to improve their models (opt-out available via mip_opt_out=true).',
        'They do NOT sell your data. Logs retained 90 days.',
        'See deepgram.com/privacy for full details.',
      ].join(' '),
      'Get Free Key',
      'Enter My Key',
      'Cancel',
    );

    if (disclosure === 'Get Free Key') {
      await vscode.env.openExternal(vscode.Uri.parse('https://console.deepgram.com'));
      const action2 = await vscode.window.showInformationMessage(
        'Once you have your Deepgram API key, click Enter Key to activate real-time transcription.',
        'Enter Key',
        'Cancel',
      );
      if (action2 !== 'Enter Key') { return; }
    } else if (disclosure !== 'Enter My Key') {
      return;
    }

    // ── Key input ──
    const key = await vscode.window.showInputBox({
      prompt: 'Paste your Deepgram API key',
      placeHolder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => v.trim().length < 10 ? 'Key looks too short \u2014 check and try again' : undefined,
    });

    if (!key?.trim()) { return; }

    await this.deps.secretManager.storeSecret('vtp.deepgramApiKey', key.trim());
    await vscode.workspace.getConfiguration('vtp').update('transcriptionEngine', 'deepgram', vscode.ConfigurationTarget.Global);
    await this.sendDeepgramKeyStatus();

    this.deps.log('[VTP] Deepgram API key saved. Real-time transcription enabled.');
    vscode.window.showInformationMessage('Deepgram activated ✔ \u2014 next recording will use real-time transcription.');
  }

  /**
   * Walk the user through Deepgram privacy preferences — MIP opt-out,
   * transcript redaction, and profanity filtering.
   */
  async handleDeepgramPrivacySettings(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('vtp');

    const mipOn       = cfg.get<boolean>('deepgramMipOptOut', false);
    const profanityOn = cfg.get<boolean>('deepgramProfanityFilter', false);
    const redactList  = cfg.get<string[]>('deepgramRedact', []);

    const items = [
      { label: 'Opt out of model training',    description: 'Prevents Deepgram from using your audio to improve their models (mip_opt_out)',       key: 'mip',     picked: mipOn },
      { label: 'Profanity filter',             description: 'Replaces recognised profanity with [censored] in the transcript',                      key: 'profanity', picked: profanityOn },
      { label: 'Redact PCI data',              description: 'Credit card numbers, CVVs, expiry dates',                                              key: 'pci',     picked: redactList.includes('pci') },
      { label: 'Redact PII data',              description: 'Names, addresses, phone numbers, emails',                                              key: 'pii',     picked: redactList.includes('pii') },
      { label: 'Redact numbers',               description: 'All numeric sequences in the transcript',                                              key: 'numbers', picked: redactList.includes('numbers') },
      { label: 'Redact SSN',                   description: 'Social Security Numbers',                                                              key: 'ssn',     picked: redactList.includes('ssn') },
    ];

    const picks = await vscode.window.showQuickPick(items, {
      title: 'Deepgram Privacy Settings',
      placeHolder: 'Space to toggle options, Enter to save. All changes take effect on the next recording.',
      canPickMany: true,
      ignoreFocusOut: true,
    });

    if (picks === undefined) { return; }

    const pickedKeys = new Set((picks as any[]).map((p) => (p as any).key));
    const newMip       = pickedKeys.has('mip');
    const newProfanity = pickedKeys.has('profanity');
    const newRedact: string[] = [];
    for (const r of ['pci', 'pii', 'numbers', 'ssn'] as const) {
      if (pickedKeys.has(r)) { newRedact.push(r); }
    }

    await cfg.update('deepgramMipOptOut', newMip, vscode.ConfigurationTarget.Global);
    await cfg.update('deepgramProfanityFilter', newProfanity, vscode.ConfigurationTarget.Global);
    await cfg.update('deepgramRedact', newRedact, vscode.ConfigurationTarget.Global);

    const redactSummary = newRedact.length > 0 ? newRedact.join(', ') : 'none';
    this.deps.log(
      `[VTP] Deepgram privacy: mip_opt_out=${newMip}, redact=[${redactSummary}], profanity_filter=${newProfanity}`,
    );
    vscode.window.showInformationMessage(
      `Deepgram privacy saved — MIP opt-out: ${newMip ? 'on' : 'off'} | Redact: ${redactSummary} | Profanity filter: ${newProfanity ? 'on' : 'off'}`,
    );
  }
}
