import { WorkspaceContext, MatchedConversation } from '../types';
import { OllamaClient } from './OllamaClient';

/** Thrown when enhancement is requested but no local LLM is available. */
export class NoLocalModelError extends Error {
  constructor() {
    super('Enhancement needs a local LLM. Install Ollama (ollama.com) and pull a model, e.g. `ollama pull llama3.2`. Until then VTP will send your cleaned dictation as-is.');
    this.name = 'NoLocalModelError';
  }
}

/**
 * Takes the accumulated prompt buffer + workspace/conversation context and asks
 * a LOCAL Ollama model to produce a clean, detailed, codebase-aware prompt.
 *
 * Fully local — no API key, nothing leaves the machine. If Ollama is not
 * running (or has no models), elaborate() throws NoLocalModelError and the
 * caller falls back to sending the raw/cleaned buffer.
 */
export class PromptElaborator {
  private readonly ollama: OllamaClient;

  constructor(model = 'llama3.2') {
    this.ollama = new OllamaClient(model);
  }

  async elaborate(
    promptBuffer: string,
    workspace: WorkspaceContext,
    conversation: MatchedConversation | null,
  ): Promise<string> {
    if (!(await this.ollama.isAvailable())) {
      throw new NoLocalModelError();
    }
    const prompt = this.buildPrompt(promptBuffer, workspace, conversation);
    const out = await this.ollama.generate(prompt, {
      system:
        'You are an expert prompt engineer embedded in a code editor. ' +
        'Output ONLY the final prompt — no preamble, no commentary, no markdown headers.',
      temperature: 0.2,
      timeoutMs: 45_000,
    });
    return out.trim();
  }

  private buildPrompt(
    buffer: string,
    ws: WorkspaceContext,
    conv: MatchedConversation | null,
  ): string {
    const activeFileSection = ws.activeFile
      ? `Active file: ${ws.activeFile.path} (${ws.activeFile.language})
\`\`\`${ws.activeFile.language}
${ws.activeFile.content}
\`\`\``
      : 'No active file.';

    const openEditorsSection =
      ws.openEditors.length > 1
        ? ws.openEditors
            .filter((e) => e.path !== ws.activeFile?.path)
            .map((e) => `- ${e.path}`)
            .join('\n')
        : 'None';

    const gitSection = ws.gitDiff
      ? `\`\`\`diff\n${ws.gitDiff}\n\`\`\``
      : 'No uncommitted changes.';

    const conversationSection = conv
      ? `Conversation: "${conv.title}" (last ${conv.messages.length} messages)
${conv.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}`
      : 'No matched conversation history.';

    return `A developer dictated rough voice notes. Your tasks:
1. Remove all filler words (um, uh, like, you know, etc.) and false starts
2. Use the workspace and conversation context to make the prompt precise and specific
3. Reference actual file names, function names, and patterns present in the codebase
4. Include relevant edge cases and acceptance criteria
5. Output ONLY the final prompt — no preamble, no commentary, no markdown headers

=== WORKSPACE: ${ws.workspaceName} ===
${activeFileSection}

Open editors:
${openEditorsSection}

Git diff:
${gitSection}

Package info:
${ws.projectMeta || 'Not available'}

=== RECENT CONVERSATION ===
${conversationSection}

=== DEVELOPER'S VOICE NOTES (raw) ===
"${buffer}"

Note: Any side-commands the developer issued mid-sentence have already been executed.
This buffer contains only the prompt-building content. Clean and expand it now.`;
  }
}
