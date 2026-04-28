import { GoogleGenerativeAI } from '@google/generative-ai';
import { IntentResult, WorkspaceContext } from '../types';

// ─── Fast local phrase gates — avoid an API round-trip for unambiguous cases ─

const SEND_PHRASES = [
  'ok send', 'okay send', 'send it', 'send message', 'go ahead and send',
  'submit this', 'send this', 'send that', 'send the prompt', 'go send',
  'please send', 'just send', 'send this prompt', 'send that prompt',
];
const ENHANCE_PHRASES = [
  'enhance prompt', 'enhance this', 'enhance it', 'enhance the prompt',
  'elaborate this', 'elaborate the prompt', 'improve this prompt',
  'make it better', 'expand this', 'rewrite this prompt',
  'enhance that', 'elaborate that',
];
const CANCEL_PHRASES = [
  'cancel', 'never mind', 'start over', 'forget it', 'clear that', 'discard',
];

// Minimum word count — single words / mic noise skipped
const MIN_WORD_COUNT = 2;

/**
 * Classifies each transcript segment AND extracts the clean prompt content.
 *
 * Intent types:
 *   PROMPT_CONTENT — developer narrating what to build (default, vast majority)
 *   ENHANCE        — explicit request to elaborate the accumulated prompt
 *   SEND           — explicit request to inject the prompt as-is
 *   COMMAND        — immediate IDE/OS/terminal action (rare, must be unambiguous)
 *   CANCEL         — discard everything and restart
 *
 * CRITICAL: For ALL intent types the LLM returns a "content" field containing
 * the cleaned prompt text extracted from the segment (filler words and trigger
 * phrases removed). This lets VTPPanel accumulate content even when SEND or
 * ENHANCE is detected in the same breath as the prompt.
 */
export class IntentProcessor {
  private readonly model;

  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }

  async classify(
    segment: string,
    promptBuffer: string,
    context: WorkspaceContext,
  ): Promise<IntentResult> {
    const lower = segment.toLowerCase().trim();
    const wordCount = lower.split(/\s+/).filter(Boolean).length;

    // Too short — likely mic noise, treat as content with no LLM call
    if (wordCount < MIN_WORD_COUNT) {
      return { type: 'PROMPT_CONTENT', content: segment };
    }

    // Fast local gates for unambiguous standalone commands
    // (only triggers when the ENTIRE segment is just the command phrase)
    if (ENHANCE_PHRASES.some((p) => lower === p || lower.replace(/^(uh|um)\s+/, '') === p)) {
      return { type: 'ENHANCE', content: '' };
    }
    if (SEND_PHRASES.some((p) => lower === p || lower.replace(/^(uh|um)\s+/, '') === p)) {
      return { type: 'SEND', content: '' };
    }
    if (CANCEL_PHRASES.some((p) => lower === p || lower.startsWith(p + ' '))) {
      return { type: 'CANCEL', content: '' };
    }

    // LLM handles everything else — including mixed segments like
    // "build a login page, send it" or "enhance this: add auth support"
    const systemPrompt = this.buildClassifierPrompt(context, promptBuffer);
    const result = await this.model.generateContent([
      { text: systemPrompt },
      { text: `Classify and extract: "${segment}"` },
    ]);

    return this.parseResponse(result.response.text(), segment);
  }

  private buildClassifierPrompt(ctx: WorkspaceContext, buffer: string): string {
    return `You are a real-time voice intent classifier inside a VS Code extension called VTP.
The developer speaks naturally while coding. Your job is to classify the intent AND extract
the clean prompt content from every segment.

INTENT TYPES:
- PROMPT_CONTENT: Developer describing what to build/code. The DEFAULT — use when in doubt.
- SEND: Developer wants to inject the prompt into the AI chat (e.g. "send it", "send the prompt").
- ENHANCE: Developer wants Gemini to rewrite/elaborate the prompt (e.g. "enhance this", "elaborate").
- COMMAND: Direct IDE/OS/terminal action — VERY RARE. Only for unmistakable IDE directives.
- CANCEL: Developer wants to discard and restart (e.g. "cancel", "never mind").

THE "content" FIELD — ALWAYS REQUIRED:
Extract the meaningful prompt text from the segment. Remove:
  - Filler words: "uh", "um", "like", "you know", "so", "well"
  - Send trigger phrases: "send it", "send the prompt", "send this", "ok send", etc.
  - Enhance trigger phrases: "enhance this", "elaborate", "improve", "make it better", etc.
  - Cancel phrases: "cancel", "never mind", etc.
  - IDE command phrases (for COMMAND intent): the action directive itself

EXAMPLES:
  Segment: "uh build a login page with Google OAuth, send the prompt"
  → type: "SEND", content: "build a login page with Google OAuth"

  Segment: "enhance this: add TypeScript strict mode to the auth module"
  → type: "ENHANCE", content: "add TypeScript strict mode to the auth module"

  Segment: "build a REST API for users, enhance that"
  → type: "ENHANCE", content: "build a REST API for users"

  Segment: "I want a dark mode toggle in the navbar"
  → type: "PROMPT_CONTENT", content: "I want a dark mode toggle in the navbar"

  Segment: "open the terminal"
  → type: "COMMAND", content: "", commandIntent: "open the terminal"

  Segment: "never mind start over"
  → type: "CANCEL", content: ""

CONSERVATIVE COMMAND RULES (all must be true):
1. The action targets the IDE/OS itself, NOT the code being written.
2. It is unmistakably an immediate action, not a feature to build.
3. "make a save button" → PROMPT_CONTENT (building UI, not IDE action)
4. "run the tests" / "open the terminal" / "git commit" → COMMAND

Current workspace: ${ctx.workspaceName}
Active file: ${ctx.activeFile?.path ?? 'none'}
Accumulated buffer: "${buffer.slice(-200)}"

Respond with JSON ONLY — no markdown:
{
  "type": "PROMPT_CONTENT" | "SEND" | "ENHANCE" | "COMMAND" | "CANCEL",
  "content": "cleaned prompt text extracted from the segment (empty string if none)",
  "commandIntent": "IDE action description (COMMAND only, else omit)"
}`;
  }

  private parseResponse(raw: string, fallbackSegment: string): IntentResult {
    try {
      const cleaned = raw.replace(/```(?:json)?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const type = (['PROMPT_CONTENT', 'SEND', 'ENHANCE', 'COMMAND', 'CANCEL'].includes(parsed.type))
        ? parsed.type
        : 'PROMPT_CONTENT';
      return {
        type,
        content: parsed.content ?? '',
        commandIntent: parsed.commandIntent,
      };
    } catch {
      // If JSON parse fails, treat entire segment as prompt content
      return { type: 'PROMPT_CONTENT', content: fallbackSegment };
    }
  }
}
