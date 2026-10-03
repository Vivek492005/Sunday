// sunday-agent — voice input/output for the chat webview.
//
// Uses the browser Web Speech APIs only:
//   - input:  SpeechRecognition (Chrome/Edge; webkitSpeechRecognition)
//   - output: speechSynthesis (all modern browsers)
//
// Privacy: transcription and synthesis happen on the user's device via the
// browser's speech services. No audio is ever sent to Sunday servers — only
// the transcribed *text* (which the user then explicitly sends) leaves the
// webview, exactly as if typed. See docs/VOICE.md.

/** Minimal structural typing for the Web Speech recognition API. */
export interface SpeechRecognitionEventLike {
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
  resultIndex: number;
}

export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Window shape we need; keeps the module testable without DOM lib types. */
export interface VoiceWindow {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
  speechSynthesis?: {
    speak(u: { text: string; lang?: string; rate?: number }): void;
    cancel(): void;
    speaking: boolean;
  };
  SpeechSynthesisUtterance?: new (text: string) => { text: string; lang?: string; rate?: number };
}

function win(): VoiceWindow | undefined {
  return typeof window !== 'undefined' ? (window as unknown as VoiceWindow) : undefined;
}

export function getSpeechRecognitionCtor(w: VoiceWindow | undefined = win()): SpeechRecognitionCtor | undefined {
  if (!w) return undefined;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function isSpeechRecognitionSupported(w: VoiceWindow | undefined = win()): boolean {
  return getSpeechRecognitionCtor(w) !== undefined;
}

export function isSpeechSynthesisSupported(w: VoiceWindow | undefined = win()): boolean {
  return !!w?.speechSynthesis && !!w?.SpeechSynthesisUtterance;
}

export type VoiceInputState = 'idle' | 'listening' | 'error';

export interface VoiceRecognizerCallbacks {
  /** Interim + final transcripts as they arrive. */
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}

/**
 * Small state machine around SpeechRecognition. Emits interim transcripts
 * live and a final transcript on stop; surfaces API errors as messages.
 * All browser access is injectable for tests.
 */
export class VoiceRecognizer {
  private rec: SpeechRecognitionLike | undefined;
  private _state: VoiceInputState = 'idle';

  constructor(
    private readonly ctor: SpeechRecognitionCtor | undefined,
    private readonly cb: VoiceRecognizerCallbacks,
  ) {}

  get state(): VoiceInputState {
    return this._state;
  }

  get supported(): boolean {
    return this.ctor !== undefined;
  }

  start(lang = 'en-US'): boolean {
    if (!this.ctor || this._state === 'listening') return false;
    try {
      const rec = new this.ctor();
      rec.lang = lang;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.continuous = true;
      rec.onresult = (e) => {
        let interim = '';
        let fin = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const t = r[0]?.transcript ?? '';
          if (r.isFinal) fin += t;
          else interim += t;
        }
        if (fin) this.cb.onTranscript(fin, true);
        else if (interim) this.cb.onTranscript(interim, false);
      };
      rec.onerror = (e) => {
        this._state = 'error';
        this.cb.onError(speechErrorMessage(e.error));
      };
      rec.onend = () => {
        if (this._state === 'listening') this._state = 'idle';
        this.cb.onEnd();
      };
      rec.start();
      this.rec = rec;
      this._state = 'listening';
      return true;
    } catch {
      this._state = 'error';
      this.cb.onError('Could not start voice input.');
      return false;
    }
  }

  /** Stop and keep whatever was transcribed so far. */
  stop(): void {
    if (this._state !== 'listening') return;
    try {
      this.rec?.stop();
    } catch {
      /* stopping a dead recognizer is fine */
    }
    // onend will flip state to idle; do it eagerly too in case onend never fires.
    this._state = 'idle';
  }

  abort(): void {
    try {
      this.rec?.abort();
    } catch {
      /* ignore */
    }
    this.rec = undefined;
    this._state = 'idle';
  }
}

function speechErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was denied. Allow microphone permission and try again.';
    case 'no-speech':
      return 'No speech detected. Try again.';
    case 'audio-capture':
      return 'No microphone found.';
    case 'network':
      return 'Speech service unavailable (network). Try again later.';
    default:
      return `Voice input error (${code}).`;
  }
}

export interface SpeakOptions {
  lang?: string;
  rate?: number;
  /** Truncate spoken text to this many chars (long responses get summarized). */
  maxChars?: number;
}

/**
 * Speak text via speechSynthesis. Returns false when unsupported.
 * Long responses are truncated with an ellipsis note to avoid
 * reading entire diffs aloud.
 */
export function speakText(
  text: string,
  opts: SpeakOptions = {},
  w: VoiceWindow | undefined = win(),
): boolean {
  if (!w?.speechSynthesis || !w?.SpeechSynthesisUtterance) return false;
  const clean = stripForSpeech(summarizeForSpeech(text, opts.maxChars ?? 500));
  if (!clean) return false;
  try {
    w.speechSynthesis.cancel();
    const u = new w.SpeechSynthesisUtterance(clean);
    if (opts.lang) u.lang = opts.lang;
    if (opts.rate) u.rate = opts.rate;
    w.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

export function stopSpeaking(w: VoiceWindow | undefined = win()): void {
  try {
    w?.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}

/** Keep spoken output short: first maxChars chars, cut at a sentence boundary. */
export function summarizeForSpeech(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const lastEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  const head = lastEnd > maxChars * 0.5 ? cut.slice(0, lastEnd + 1) : cut;
  return `${head} …(response truncated for speech)`;
}

/** Strip markdown/code fences so TTS doesn't read punctuation soup. */
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' [code block] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface VoiceConfig {
  inputEnabled: boolean;
  outputEnabled: boolean;
}

export const VOICE_CONFIG_DEFAULTS: VoiceConfig = { inputEnabled: false, outputEnabled: false };
