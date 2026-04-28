import { GoogleGenerativeAI } from '@google/generative-ai';
import { WorkspaceContext, MatchedConversation } from '../types';

/**
 * Takes the accumulated prompt buffer + full context and calls Gemini
 * to produce a clean, detailed, codebase-aware prompt for Antigravity.
 *
 * Also handles filler word removal from the raw voice transcript.
 */
export class PromptElaborator {
  private readonly model;

  constructor(apiKey: string, modelName = 'gemini-2.5-flash') {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model: modelName });
  }

  async elaborate(
    promptBuffer: string,
    workspace: WorkspaceContext,
    conversation: MatchedConversation | null,
  ): Promise<string> {
    const prompt = this.buildPrompt(promptBuffer, workspace, conversation);
    const result = await this.model.generateContent(prompt);
    return result.response.text().trim();
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

    return `You are an expert prompt engineer embedded inside a VS Code extension.
A developer dictated rough voice notes. Your tasks:
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

=== RECENT ANTIGRAVITY CONVERSATION ===
${conversationSection}

=== DEVELOPER'S VOICE NOTES (raw) ===
"${buffer}"

Note: Any side-commands the developer issued mid-sentence have already been executed.
This buffer contains only the prompt-building content. Clean and expand it now.`;
  }
}
