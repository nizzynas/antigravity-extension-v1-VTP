import { GoogleGenerativeAI } from '@google/generative-ai';
import { IntentResult, WorkspaceContext } from '../types';

const SEND_PHRASES = ['ok send', 'okay send', 'send it', 'send message', 'go ahead and send'];
const CANCEL_PHRASES = ['cancel', 'never mind', 'start over', 'forget it'];

/**
 * Classifies each final transcript segment as:
 *   PROMPT_CONTENT — part of the prompt being built
 *   COMMAND        — a side-action to execute immediately
 *   SEND           — user wants to finalize and inject the prompt
 *   CANCEL         — user wants to clear and restart
 *
 * Uses Gemini Flash for fast, low-latency classification.
 * Intent is determined from full context, not keyword matching,
 * so "make a pause button" ≠ "pause the chat".
 */
export class IntentProcessor {
  private readonly model;

  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  }

  async classify(
    segment: string,
    promptBuffer: string,
    context: WorkspaceContext,
  ): Promise<IntentResult> {
    const lower = segment.toLowerCase().trim();

    // Fast local checks before hitting the API
    if (SEND_PHRASES.some((p) => lower.includes(p))) {
      return { type: 'SEND', content: '' };
    }
    if (CANCEL_PHRASES.some((p) => lower === p)) {
      return { type: 'CANCEL', content: '' };
    }

    const systemPrompt = this.buildClassifierPrompt(context, promptBuffer);
    const result = await this.model.generateContent([
      { text: systemPrompt },
      { text: `Classify this segment: "${segment}"` },
    ]);

    return this.parseResponse(result.response.text(), segment);
  }

  private buildClassifierPrompt(ctx: WorkspaceContext, buffer: string): string {
    return `You are a real-time voice intent classifier inside a VS Code extension called VTP.
The developer is building software and speaking a mix of coding instructions and side-actions.

CLASSIFY each transcript segment as one of:
- PROMPT_CONTENT: developer is describing what to build or code (the bulk of their speech)
- COMMAND: developer wants a side-action taken in the IDE, browser, or OS RIGHT NOW
- SEND: developer wants to finalize and send the accumulated prompt
- CANCEL: developer wants to clear everything and restart

RULES FOR DISAMBIGUATION (critical):
- "make a pause button" → PROMPT_CONTENT (describing UI to build)
- "pause the chat" / "stop listening" → COMMAND (action on this extension)
- "actually no, make it blue" → PROMPT_CONTENT (changing mind about what to build)
- "actually pull up the landing page" → COMMAND (side-action in the IDE)
- "I want to pause the VTP" → COMMAND
- "I want to add a pause feature" → PROMPT_CONTENT
- Corrections and changes of mind about the thing being built → always PROMPT_CONTENT
- Actions directed at the IDE, terminal, browser, or this extension → COMMAND

Current workspace: ${ctx.workspaceName}
Active file: ${ctx.activeFile?.path ?? 'none'}
Recent prompt buffer: "${buffer.slice(-200)}"

Respond with JSON ONLY — no markdown, no explanation:
{
  "type": "PROMPT_CONTENT" | "COMMAND" | "SEND" | "CANCEL",
  "content": "cleaned text with filler words removed (for PROMPT_CONTENT, else empty string)",
  "commandIntent": "natural language description of the action (for COMMAND only, else omit)"
}`;
  }

  private parseResponse(raw: string, fallbackSegment: string): IntentResult {
    try {
      // Strip potential markdown code fences
      const cleaned = raw.replace(/```(?:json)?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      return {
        type: parsed.type ?? 'PROMPT_CONTENT',
        content: parsed.content ?? fallbackSegment,
        commandIntent: parsed.commandIntent,
      };
    } catch {
      // Graceful fallback — treat as prompt content
      return { type: 'PROMPT_CONTENT', content: fallbackSegment };
    }
  }
}
