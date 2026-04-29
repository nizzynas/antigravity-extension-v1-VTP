import * as vscode from 'vscode';

const GEMINI_KEY_ID = 'vtp.geminiApiKey';

/**
 * Manages the per-developer Gemini API key using VS Code's encrypted SecretStorage.
 * Keys are never written to source control or settings files.
 */
export class SecretManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getApiKey(): Promise<string | undefined> {
    return this.secrets.get(GEMINI_KEY_ID);
  }

  async setApiKey(key: string): Promise<void> {
    await this.secrets.store(GEMINI_KEY_ID, key.trim());
  }

  async deleteApiKey(): Promise<void> {
    await this.secrets.delete(GEMINI_KEY_ID);
  }

  /**
   * Prompts the user for their Gemini API key via an input box.
   * Returns the key if entered, undefined if dismissed.
   */
  async promptForApiKey(): Promise<string | undefined> {
    const key = await vscode.window.showInputBox({
      title: 'VTP — Gemini API Key',
      prompt: 'Enter your Gemini API key. Stored encrypted on this machine only.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim().length > 20 ? null : 'Key looks too short — check and try again.',
    });

    if (key) {
      await this.setApiKey(key);
      return key.trim();
    }
    return undefined;
  }

  /**
   * Returns the stored key, or prompts for one if not set.
   * Returns null if the user dismisses the prompt.
   */
  async ensureApiKey(): Promise<string | null> {
    const existing = await this.getApiKey();
    if (existing) return existing;

    vscode.window.showInformationMessage(
      'VTP needs your Gemini API key to work. Enter it now.',
    );
    return (await this.promptForApiKey()) ?? null;
  }

  // ─── Generic secret helpers (for optional integrations like Deepgram) ──────

  /** Read any named secret from VS Code SecretStorage. */
  async getSecret(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  /** Write any named secret to VS Code SecretStorage (encrypted, local only). */
  async storeSecret(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
  }

  /** Delete any named secret from VS Code SecretStorage. */
  async deleteSecret(key: string): Promise<void> {
    await this.secrets.delete(key);
  }
}
