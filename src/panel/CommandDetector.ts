export const PAUSE_CMD = /^[\s.,!?]*(pause(\s+(vtp|recording|listening|chat))?|stop\s+listening|mute)[\s.,!?]*$/i;

export const CLEAR_CMD = /^[\s.,!?]*(clear(\s+(transcript|that|this|the\s+transcript|buffer))?|cancel(\s+(that|this))?)[\s.,!?]*$/i;

export const CLEAR_FINAL_CMD = /^[\s.,!?]*(clear(\s+(the\s+)?(transcript|buffer|prompt|that|this))?|reset(\s+the)?\s+(transcript|buffer|prompt)|start\s+over)[\s.,!?]*$/i;

export const CLEAN_REVIEW_CMD = /\b(clean\s+(it\s+)?up\s+and\s+(review|show|preview)|clean\s+and\s+review|review\s+(the\s+)?clean(up)?|scrub\s+and\s+show)\b/i;

export const CLEAN_CMD = /\b(clean\s+it\s+up|clean\s+(this|that|the\s+prompt)\s+up|clean\s+up(\s+(the\s+)?(prompt|transcript|that|this))?|scrub\s+(that|this|it|the\s+prompt)|tidy\s+(this|that|it)\s+up)\b/i;

export const ENHANCE_LIVE = /\b(enhance\s+(this|my|the)\s+prompt|enhance\s+prompt|improve\s+(this|my|the)\s+prompt|rewrite\s+(this|my|the)\s+prompt)\b/i;

export const SEND_TRIGGER = /\b(send it|send this|send the prompt|send this prompt|send my prompt|send now|submit this|submit the prompt)\b[.,!?\s]*$/i;

export const ACTION_TRIGGER = /\b(enhance (this|my|the) prompt|rewrite (this|my|the) prompt|improve (this|my|the) prompt|cancel( that)?|clear( that)?|open the terminal|run (the )?tests|hey vtp)\b/i;

export const WAKE_PHRASE = /\b(resume|i'?m back)\b/i;

export const WAKE_NOISE = /^[\s.,!?]*((resume|i'?m back|i\s+am\s+back)[\s.,!?]*)+$/i;

export const ENHANCE_APPROVE = /\b(approve|accept|looks?\s+good|yes|use\s+it|perfect|great|keep\s+it|apply)\b|prove\s*$/i;
export const ENHANCE_REJECT = /\b(reject|revert|no|go\s+back|undo|restore|cancel|discard|original)\b/i;
export const ENHANCE_REGEN = /\b(regenerate|try\s+again|redo|new\s+version|another|different|again)\b/i;

export const SIDE_CMD = /(?:side\s+command\s*:\s*|\bhey[,!]?\s+(?=(?:pull\b|search\b|look\b|navigate\b|browse\b|open\b))|\b(?:pull\s+up|search\s+for|look\s+up|navigate\s+to|browse\s+to|open\s+(?:the\s+)?(?:browser|website|page|site)\s+(?:to|at|for)?\s*|open\s+(?=\S*(?:\.\S+|\bdot\b))))(.+)/i;

export const PAUSE_AND_SIDE_CMD = /^[\s.,!?]*(?:pause|stop\s+listening|mute)[\s.,!?]*(?:and|then|also)?[\s.,!?]+(.+)/i;

export function extractSideCommand(text: string): string | null {
  const m = text.match(SIDE_CMD);
  if (!m) return null;
  return m[1].trim().replace(/[.,!?]+$/, '').trim() || null;
}

export function extractPauseAndSideCmd(text: string): string | null {
  const m = text.match(PAUSE_AND_SIDE_CMD);
  if (!m) return null;
  return m[1].trim().replace(/[.,!?]+$/, '').trim() || null;
}

export function stripFiller(text: string): string {
  return text
    .replace(/^[\s,]*(hello|hi|hey|um|uh|okay|ok|alright|right|so|yeah|yes|well|now|please)[\s,]+/gi, '')
    .replace(/[\s,]*(hello|hi|hey|um|uh|okay|ok|alright|right|yeah|yes)[\s,]*$/gi, '')
    .trim();
}

export function hasSendTrigger(text: string): boolean {
  const PATTERN = /\b(send it|send the prompt|send this prompt|send my prompt|send this|send that|submit this|go ahead and send|ok send|okay send|go send|please send|just send|send message|send now|submit now)\b[.,!?\s]*$/i;
  if (PATTERN.test(text) || PATTERN.test(stripFiller(text))) { return true; }
  return /\bsend\s+the\s+\w+[.,!?\s]*$/i.test(stripFiller(text));
}

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

export function sanitizeTranscription(raw: string): string {
  let text = raw.trim();

  text = text.replace(/^WEBVTT[\s\S]*?\n\n/m, '');
  text = text.replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '');
  text = text.replace(/^\d{2}:\d{2}(:\d{2})?$/gm, '');
  text = text.replace(/^\d+$/gm, '');

  text = text.replace(/\[[^\]]*\]/g, '');

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

  text = text.replace(/\*\*[^*]*\*\*/g, '');
  text = text.replace(/^(Transcription|Here is the transcription|The text spoken)[:\s]*/i, '');

  text = text.replace(/\s{2,}/g, ' ').trim();
  return text;
}

export function hasVoiceEnergy(buf: Buffer, threshold = 600): boolean {
  const PCM_OFFSET = 44;
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
