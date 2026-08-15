import { OllamaClient } from './OllamaClient';

/**
 * PromptCleaner — hybrid filler / repetition stripper (fully local).
 *
 *   regexClean(text)  : free, instant local pass — strips fillers and dupes
 *   isNoisy(text)     : true if the buffer has self-corrections or high
 *                       filler density that warrant an LLM upgrade
 *   clean(text)       : runs regex always; runs a LOCAL Ollama pass only when
 *                       isNoisy AND an Ollama daemon is available. Otherwise
 *                       returns the regex result. No network, no API key.
 */

// Pure discourse-marker fillers — safe to strip mid-sentence.
const FILLER_RE = /\b(uh+|um+|er+h?|ahh+|hmm+|mhm+|mm+)\b/gi;

// High-confidence self-correction / restart markers → flip the noise gate.
const NOISY_MARKERS = /\b(actually|i\s+mean|wait[,\s]|scratch\s+that|hold\s+on|no\s+wait|let\s+me\s+think|sorry,?\s+(I\s+)?mean)\b/i;

// Lower-confidence filler family used only in the density check (not stripped).
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
  /**
   * @param ollama Optional local Ollama client. When null (or unavailable at
   *               call time), clean() is pure-regex.
   */
  constructor(private readonly ollama: OllamaClient | null) {}

  /** Pure-local cleanup. Always safe to run. */
  static regexClean(text: string): string {
    let s = text;
    s = s.replace(FILLER_RE, '');
    // Collapse immediate word-level repetitions: "the the navbar" → "the navbar".
    s = s.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
    s = s.replace(/\s+([,.!?;:])/g, '$1');
    s = s.replace(/[,]\s*[,]+/g, ',');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s;
  }

  /** Noise gate — true only when an LLM pass would actually add value. */
  static isNoisy(text: string): boolean {
    if (!text) return false;
    if (NOISY_MARKERS.test(text)) return true;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= NOISE_WORD_FLOOR) return false;
    const fillerHits = (text.match(SOFT_FILLERS) || []).length;
    return fillerHits >= NOISE_FILLER_HITS;
  }

  /**
   * Hybrid clean: regex first; local Ollama upgrade only when isNoisy and a
   * daemon is available. Falls back to the regex result on any error.
   */
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
