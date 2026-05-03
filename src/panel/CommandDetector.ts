/**
 * CommandDetector — voice command regex matching, trigger detection, and text stripping.
 *
 * Pure logic module: no VS Code API, no audio, no state mutation.
 * VTPPanel passes text in and gets boolean/string results back.
 */

// ── Regex patterns ──────────────────────────────────────────────────────────────

/** Pause: only when the ENTIRE utterance is the command. */
export const PAUSE_CMD = /^[\s.,!?]*(pause(\s+(vtp|recording|listening|chat))?|stop\s+listening|mute)[\s.,!?]*$/i;

/** Clear / cancel: anchored so "clear that. Perfect. Okay. So for..." doesn't wipe. */
export const CLEAR_CMD = /^[\s.,!?]*(clear(\s+(transcript|that|this|the\s+transcript|buffer))?|cancel(\s+(that|this))?)[\s.,!?]*$/i;

/** Clear (onFinalTranscript variant — slightly broader set). */
export const CLEAR_FINAL_CMD = /^[\s.,!?]*(clear(\s+(the\s+)?(transcript|buffer|prompt|that|this))?|reset(\s+the)?\s+(transcript|buffer|prompt)|start\s+over)[\s.,!?]*$/i;

/**
 * Clean-up + review trigger: cleans the buffer and shows a preview before
 * sending. Checked BEFORE CLEAN_CMD because it's the more specific phrase.
 */
export const CLEAN_REVIEW_CMD = /\b(clean\s+(it\s+)?up\s+and\s+(review|show|preview)|clean\s+and\s+review|review\s+(the\s+)?clean(up)?|scrub\s+and\s+show)\b/i;

/** Clean-up trigger: "clean it up", "scrub that", etc. (silent — no preview). */
export const CLEAN_CMD = /\b(clean\s+it\s+up|clean\s+(this|that|the\s+prompt)\s+up|clean\s+up(\s+(the\s+)?(prompt|transcript|that|this))?|scrub\s+(that|this|it|the\s+prompt)|tidy\s+(this|that|it)\s+up)\b/i;

/** Enhance trigger (live chunks). */
export const ENHANCE_LIVE = /\b(enhance\s+(this|my|the)\s+prompt|enhance\s+prompt|improve\s+(this|my|the)\s+prompt|rewrite\s+(this|my|the)\s+prompt)\b/i;

/** Send trigger (for onFinalTranscript path). */
export const SEND_TRIGGER = /\b(send it|send this|send the prompt|send this prompt|send my prompt|send now|submit this|submit the prompt)\b[.,!?\s]*$/i;

/** Action trigger — broad set that forces Gemini classification. */
export const ACTION_TRIGGER = /\b(enhance (this|my|the) prompt|rewrite (this|my|the) prompt|improve (this|my|the) prompt|cancel( that)?|clear( that)?|open the terminal|run (the )?tests|hey vtp)\b/i;

/** Wake phrases for resuming from pause. */
export const WAKE_PHRASE = /\b(resume|i'?m back)\b/i;

/** Post-wake noise: pure wake words with no real content. */
export const WAKE_NOISE = /^[\s.,!?]*((resume|i'?m back|i\s+am\s+back)[\s.,!?]*)+$/i;

/** Enhancement voice approve phrases. */
export const ENHANCE_APPROVE = /\b(approve|accept|looks?\s+good|yes|use\s+it|perfect|great|keep\s+it|apply)\b|prove\s*$/i;
/** Enhancement voice reject phrases. */
export const ENHANCE_REJECT = /\b(reject|revert|no|go\s+back|undo|restore|cancel|discard|original)\b/i;
/** Enhancement voice regenerate phrases. */
export const ENHANCE_REGEN = /\b(regenerate|try\s+again|redo|new\s+version|another|different|again)\b/i;

/**
 * Side command: a natural-language instruction to either open a URL directly
 * or inject into Antigravity chat for MCP tool execution.
 *
 * Supported triggers (intentionally narrow to avoid false positives):
 *   "side command: [instruction]"
 *   "pull up [something]"
 *   "search for [query]"
 *   "look up [query]"
 *   "navigate to [url]"
 *   "browse to [url]"
 *   "open the browser to [url]"
 *   "hey, pull up [thing]"
 *
 * Intentionally EXCLUDED (too common in natural speech):
 *   "go to" — "go to the next step", "go to the function above"
 *   "show me" — "show me what you mean", "show me the code"
 *   "find me" — "find me a solution"
 *   "open [X]" — too broad without "browser" qualifier
 */
export const SIDE_CMD = /(?:side\s+command\s*:\s*|\bhey[,!]?\s+(?=(?:pull\b|search\b|look\b|navigate\b|browse\b|open\b))|\b(?:pull\s+up|search\s+for|look\s+up|navigate\s+to|browse\s+to|open\s+(?:the\s+)?(?:browser|website|page|site)\s+(?:to|at|for)?\s*|open\s+(?=\S*(?:\.\S+|\bdot\b))))(.+)/i;

/**
 * Combined "pause AND side command" — e.g. "pause and pull up google.com"
 * or "pause, then search for React hooks".
 */
export const PAUSE_AND_SIDE_CMD = /^[\s.,!?]*(?:pause|stop\s+listening|mute)[\s.,!?]*(?:and|then|also)?[\s.,!?]+(.+)/i;

/**
 * Extracts the side-command payload from a transcript string.
 * Returns the clean instruction string, or null if no side command was found.
 *
 * Examples:
 *   "side command: pull up google.com"     → "pull up google.com"
 *   "hey, search for React hooks"          → "search for React hooks"
 *   "pull up the React docs"               → "pull up the React docs"
 *   "pause and pull up google.com"         → null  (use extractPauseAndSideCmd instead)
 */
export function extractSideCommand(text: string): string | null {
  const m = text.match(SIDE_CMD);
  if (!m) return null;
  return m[1].trim().replace(/[.,!?]+$/, '').trim() || null;
}

/**
 * For a combined "pause and [side command]" utterance, returns the side-command
 * payload (the part after "pause and"). Returns null if the pattern doesn't match.
 *
 * Example:
 *   "pause and pull up google.com"  → "pull up google.com"
 */
export function extractPauseAndSideCmd(text: string): string | null {
  const m = text.match(PAUSE_AND_SIDE_CMD);
  if (!m) return null;
  return m[1].trim().replace(/[.,!?]+$/, '').trim() || null;
}

// ── Functions ───────────────────────────────────────────────────────────────────

/**
 * Strips filler words/greetings from start and end of an utterance
 * so "hello send it hello" → "send it" and triggers correctly.
 */
export function stripFiller(text: string): string {
  return text
    .replace(/^[\s,]*(hello|hi|hey|um|uh|okay|ok|alright|right|so|yeah|yes|well|now|please)[\s,]+/gi, '')
    .replace(/[\s,]*(hello|hi|hey|um|uh|okay|ok|alright|right|yeah|yes)[\s,]*$/gi, '')
    .trim();
}

/**
 * Returns true if the text contains a voice "send" command.
 * Anchored to end-of-utterance to prevent mid-sentence matches.
 */
export function hasSendTrigger(text: string): boolean {
  const PATTERN = /\b(send it|send the prompt|send this prompt|send my prompt|send this|send that|submit this|go ahead and send|ok send|okay send|go send|please send|just send|send message|send now|submit now)\b[.,!?\s]*$/i;
  if (PATTERN.test(text) || PATTERN.test(stripFiller(text))) { return true; }
  // Loose fallback: "send the [single-word]" catches Gemini mishearings
  return /\bsend\s+the\s+\w+[.,!?\s]*$/i.test(stripFiller(text));
}

/**
 * Strips common "send" trigger phrases from a segment's end.
 * e.g. "This is a test. Send the prompt." → "This is a test."
 */
export function stripSendTrigger(segment: string): string {
  const triggers = [
    'send the prompt', 'send this prompt', 'send my prompt',
    'send it', 'ok send', 'okay send',
    'send message', 'go ahead and send', 'submit this',
    'send this', 'send that', 'go send', 'please send', 'just send',
  ];
  let text = segment.trim();
  for (const trigger of triggers) {
    text = text.replace(new RegExp(`[.,!?]?\\s*${trigger}[.,!?]?$`, 'gi'), '').trim();
  }
  return text;
}

/**
 * Strips common "enhance" trigger phrases from a segment's end.
 */
export function stripEnhanceTrigger(segment: string): string {
  const triggers = [
    'enhance this prompt', 'enhance my prompt', 'enhance the prompt', 'enhance prompt',
    'improve this prompt', 'improve my prompt', 'improve the prompt',
    'rewrite this prompt', 'rewrite my prompt', 'rewrite the prompt',
  ];
  let text = segment.trim();
  for (const trigger of triggers) {
    text = text.replace(new RegExp(`[.,!?]?\\s*${trigger}[.,!?]?$`, 'gi'), '').trim();
  }
  return text;
}

/**
 * Strips VTT/SRT subtitle format, sound annotations, and leaked system-prompt
 * text from a Gemini transcription response.
 *
 * Gemini uses [brackets] ONLY for non-speech content:
 *   [ chewing ]  [ RATTLE ]  [SOUND]  [SILENCE]  [ 0m0s ]  [NO SPEECH]
 * Real spoken words are NEVER inside brackets, so we strip ALL [...] tokens.
 */
export function sanitizeTranscription(raw: string): string {
  let text = raw.trim();

  // Strip VTT / SRT subtitle format (Gemini occasionally returns these)
  text = text.replace(/^WEBVTT[\s\S]*?\n\n/m, '');       // WEBVTT header block
  text = text.replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, ''); // timestamps
  text = text.replace(/^\d{2}:\d{2}(:\d{2})?$/gm, '');   // short time tokens
  text = text.replace(/^\d+$/gm, '');                     // SRT sequence numbers

  // Strip ALL [bracketed] non-speech annotations
  text = text.replace(/\[[^\]]*\]/g, '');

  // Strip leaked system-prompt text
  const LEAK_MARKERS = [
    'Transcribe this audio exactly as spoken',
    'Output only the transcription',
    'If no speech, output an empty string',
    'You are a transcription service',
    'Transcribe the audio.',
    'transcribe the audio',
    'You are a verbatim',
  ];
  for (const marker of LEAK_MARKERS) {
    const idx = text.toLowerCase().indexOf(marker.toLowerCase());
    if (idx > -1) {
      text = text.substring(0, idx).trim().replace(/[.,!?]+$/, '').trim();
    }
  }

  // Strip **bold** annotations and common preamble
  text = text.replace(/\*\*[^*]*\*\*/g, '');
  text = text.replace(/^(Transcription|Here is the transcription|The text spoken)[:\s]*/i, '');

  // Collapse whitespace
  text = text.replace(/\s{2,}/g, ' ').trim();
  return text;
}

/**
 * Returns true only if the WAV buffer contains audio energy above the voice threshold.
 * WAV PCM is 16-bit LE starting at byte 44. Threshold ~600 on a 0–32767 scale
 * (~1.8% of max). Low enough to catch quiet/distant speech while still
 * discarding pure silence and fan/HVAC noise floors.
 */
export function hasVoiceEnergy(buf: Buffer, threshold = 600): boolean {
  const PCM_OFFSET = 44; // standard WAV header size
  if (buf.length <= PCM_OFFSET + 2) return false;
  let sumSq = 0;
  let count = 0;
  for (let i = PCM_OFFSET; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i);
    sumSq += sample * sample;
    count++;
  }
  if (count === 0) return false;
  const rms = Math.sqrt(sumSq / count);
  return rms >= threshold;
}
