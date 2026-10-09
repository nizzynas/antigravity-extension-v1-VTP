import { IntentResult, WorkspaceContext } from '../types';

const SEND_PHRASES = [
  'ok send', 'okay send', 'send it', 'send message', 'go ahead and send',
  'submit this', 'send this', 'send that', 'send the prompt', 'go send',
  'please send', 'just send', 'send this prompt', 'send that prompt', 'send now',
];
const ENHANCE_PHRASES = [
  'enhance prompt', 'enhance this', 'enhance it', 'enhance the prompt',
  'elaborate this', 'elaborate the prompt', 'improve this prompt',
  'make it better', 'expand this', 'rewrite this prompt',
  'enhance that', 'elaborate that',
];
const CANCEL_PHRASES = [
  'cancel', 'never mind', 'nevermind', 'start over', 'forget it', 'clear that', 'discard',
];

const COMMAND_RE =
  /^(?:please\s+)?(?:open the terminal|open terminal|run the tests?|run tests?|git commit|git push|git status|open the file explorer|split the editor|toggle the sidebar|format the (?:file|document)|save the file|save all)\b/i;

const SEND_TAIL_RE = /\b(send (?:it|this|that|the prompt|this prompt|that prompt|now|message)|ok(?:ay)? send|please send|just send|submit this)\b\s*[.!?]*\s*$/i;
const ENHANCE_TAIL_RE = /\b(enhance (?:this|it|that|the prompt|prompt)|elaborate (?:this|that|the prompt)|improve this prompt|make it better|expand this|rewrite this prompt)\b\s*[.!?]*\s*$/i;

const FILLER_STRIP_RE = /\b(uh+|um+|er+h?|like|you know|i mean|basically|so|well)\b/gi;

const MIN_WORD_COUNT = 2;

export class IntentProcessor {
  constructor(_unused?: unknown) {}

  async classify(
    segment: string,
    _promptBuffer: string,
    _context: WorkspaceContext,
  ): Promise<IntentResult> {
    const raw = segment.trim();
    const lower = raw.toLowerCase();
    const stripLead = (s: string) => s.replace(/^(uh|um|okay|ok)\s+/i, '').trim();
    const wordCount = lower.split(/\s+/).filter(Boolean).length;

    if (wordCount < MIN_WORD_COUNT) {
      return { type: 'PROMPT_CONTENT', content: segment };
    }

    if (ENHANCE_PHRASES.some((p) => lower === p || stripLead(lower) === p)) {
      return { type: 'ENHANCE', content: '' };
    }
    if (SEND_PHRASES.some((p) => lower === p || stripLead(lower) === p)) {
      return { type: 'SEND', content: '' };
    }
    if (CANCEL_PHRASES.some((p) => lower === p || lower.startsWith(p + ' '))) {
      return { type: 'CANCEL', content: '' };
    }

    if (COMMAND_RE.test(lower)) {
      return { type: 'COMMAND', content: '', commandIntent: raw };
    }

    if (SEND_TAIL_RE.test(raw)) {
      const content = this.cleanContent(raw.replace(SEND_TAIL_RE, ''));
      return { type: 'SEND', content };
    }
    if (ENHANCE_TAIL_RE.test(raw)) {
      const content = this.cleanContent(raw.replace(ENHANCE_TAIL_RE, ''));
      return { type: 'ENHANCE', content };
    }

    return { type: 'PROMPT_CONTENT', content: this.cleanContent(raw) };
  }

  private cleanContent(text: string): string {
    return text
      .replace(FILLER_STRIP_RE, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.!?;:])/g, '$1')
      .trim();
  }
}
