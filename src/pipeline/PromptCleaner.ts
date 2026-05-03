import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * PromptCleaner — hybrid filler / repetition stripper.
 *
 *   regexClean(text)  : free, instant local pass — strips fillers and dupes
 *   isNoisy(text)     : true if the buffer has self-corrections or high
 *                       filler density that warrant an LLM upgrade
 *   clean(text)       : runs regex always; runs flash-lite only when isNoisy
 *
 * Used for two paths in VTPPanel:
 *   - silent auto-clean before every send (gated by _isEnhanced)
 *   - voice-triggered "clean up and review" (preview before send)
 */

// Pure discourse-marker fillers — safe to strip mid-sentence. "like", "you
// know", "I mean" are NOT in this list because they often carry meaning
// ("looks like", "I mean it") — those go through the noise gate instead.
const FILLER_RE = /\b(uh+|um+|er+h?|ahh+|hmm+|mhm+|mm+)\b/gi;

// High-confidence self-correction / restart markers. Their presence flips
// the noise gate to true so the LLM gets called.
const NOISY_MARKERS = /\b(actually|i\s+mean|wait[,\s]|scratch\s+that|hold\s+on|no\s+wait|let\s+me\s+think|sorry,?\s+(I\s+)?mean)\b/i;

// Lower-confidence filler family used only in density check (not stripped).
const SOFT_FILLERS = /\b(uh+|um+|like|you\s+know|basically|kinda|sorta|sort\s+of|kind\s+of)\b/gi;

// Word count threshold above which density matters. Below this, even a noisy
// short prompt is faster to inject as-is than to round-trip Gemini.
const NOISE_WORD_FLOOR = 25;
const NOISE_FILLER_HITS = 3;

export class PromptCleaner {
  constructor(private apiKey: string | null) {}

  /** Pure-local cleanup. Always safe to run. */
  static regexClean(text: string): string {
    let s = text;
    // Strip discourse-marker fillers (and elongated "uhhhh" forms).
    s = s.replace(FILLER_RE, '');
    // Collapse immediate word-level repetitions: "the the navbar" → "the navbar".
    s = s.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
    // Tidy punctuation and whitespace left over from stripping.
    s = s.replace(/\s+([,.!?;:])/g, '$1');
    s = s.replace(/[,]\s*[,]+/g, ',');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s;
  }

  /** Noise gate — true only when the LLM would actually add value. */
  static isNoisy(text: string): boolean {
    if (!text) return false;
    if (NOISY_MARKERS.test(text)) return true;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= NOISE_WORD_FLOOR) return false;
    const fillerHits = (text.match(SOFT_FILLERS) || []).length;
    return fillerHits >= NOISE_FILLER_HITS;
  }

  /**
   * Hybrid clean: regex first; flash-lite upgrade only when isNoisy.
   * Falls back to the regex result on any LLM error.
   */
  async clean(text: string): Promise<{ cleaned: string; usedLLM: boolean }> {
    const regexPass = PromptCleaner.regexClean(text);
    if (!PromptCleaner.isNoisy(regexPass) || !this.apiKey) {
      return { cleaned: regexPass, usedLLM: false };
    }
    try {
      const llmPass = await this.llmClean(regexPass);
      return { cleaned: llmPass || regexPass, usedLLM: true };
    } catch {
      return { cleaned: regexPass, usedLLM: false };
    }
  }

  private async llmClean(text: string): Promise<string> {
    const genai = new GoogleGenerativeAI(this.apiKey!);
    const model = genai.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
      systemInstruction: [
        'You are a transcript cleanup service.',
        "Your ONLY job is to remove noise from the user's dictated text.",
        'Remove: filler words (um, uh, like, you know, basically, so, right, I mean, kinda, sorta),',
        'self-corrections (e.g. "X — actually Y" → keep Y only),',
        'and off-topic conversational tangents.',
        'NEVER add, rephrase, expand, or reorder the real content.',
        'NEVER add commentary, preamble, or explanations.',
        'Output ONLY the cleaned text. If nothing needs cleaning, output the input unchanged.',
      ].join(' '),
      generationConfig: { temperature: 0 },
    });
    const result = await model.generateContent([`Clean up this dictated text:\n\n${text}`]);
    return result.response.text().trim();
  }
}
