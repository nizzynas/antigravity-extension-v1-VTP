import { OllamaClient } from './OllamaClient';

const FILLER_RE = /\b(uh+|um+|er+h?|ahh+|hmm+|mhm+|mm+)\b/gi;

const NOISY_MARKERS = /\b(actually|i\s+mean|wait[,\s]|scratch\s+that|hold\s+on|no\s+wait|let\s+me\s+think|sorry,?\s+(I\s+)?mean)\b/i;

const SOFT_FILLERS = /\b(uh+|um+|like|you\s+know|basically|kinda|sorta|sort\s+of|kind\s+of)\b/gi;

const NOISE_WORD_FLOOR = 25;
const NOISE_FILLER_HITS = 3;

const CLEAN_SYSTEM = [
  'You are a transcript cleanup service.',
  "Your ONLY job is to remove noise from the user's dictated text.",
  'Remove: filler words (um, uh, like, you know, basically, so, right, I mean, kinda, sorta),',
  'self-corrections (e.g. "X — actually Y" → keep Y only),',
  'and off-topic conversational tangents.',
  'NEVER add, rephrase, expand, or reorder the real content.',
  'NEVER add commentary, preamble, or explanations.',
  'Output ONLY the cleaned text. If nothing needs cleaning, output the input unchanged.',
].join(' ');

export class PromptCleaner {
  constructor(private readonly ollama: OllamaClient | null) {}

  static regexClean(text: string): string {
    let s = text;
    s = s.replace(FILLER_RE, '');
    s = s.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
    s = s.replace(/\s+([,.!?;:])/g, '$1');
    s = s.replace(/[,]\s*[,]+/g, ',');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s;
  }

  static isNoisy(text: string): boolean {
    if (!text) return false;
    if (NOISY_MARKERS.test(text)) return true;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= NOISE_WORD_FLOOR) return false;
    const fillerHits = (text.match(SOFT_FILLERS) || []).length;
    return fillerHits >= NOISE_FILLER_HITS;
  }

  async clean(text: string): Promise<{ cleaned: string; usedLLM: boolean }> {
    const regexPass = PromptCleaner.regexClean(text);
    if (!PromptCleaner.isNoisy(regexPass) || !this.ollama) {
      return { cleaned: regexPass, usedLLM: false };
    }
    try {
      if (!(await this.ollama.isAvailable())) {
        return { cleaned: regexPass, usedLLM: false };
      }
      const llmPass = await this.ollama.generate(
        `Clean up this dictated text:\n\n${regexPass}`,
        { system: CLEAN_SYSTEM, temperature: 0 },
      );
      return { cleaned: llmPass || regexPass, usedLLM: !!llmPass };
    } catch {
      return { cleaned: regexPass, usedLLM: false };
    }
  }
}
