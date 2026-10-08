// sunday-agent — voice input webview plumbing (Group D / D1).
//
// Pure message-building helpers for the chat webview's voice support. The
// vscode-coupled shell (postMessage to the webview, showInformationMessage
// for the unsupported fallback) stays in chatView.ts; everything here is
// vscode-free and unit-tested in voice.test.ts.

/** BCP 47 tag used when `sunday.voice.language` is unset. */
export const VOICE_DEFAULT_LANGUAGE = 'en-US';

/** Tooltip on the mic button when the Web Speech API is unavailable. */
export const VOICE_UNSUPPORTED_TOOLTIP = 'Voice input not supported in this browser';

/** Info message shown when the user clicks the disabled mic button. */
export const VOICE_UNSUPPORTED_MESSAGE =
  'Voice input is not supported in this browser. ' +
  'Dictation needs the Web Speech API (Chrome or Edge).';

/** Voice config as sent from the extension host to the chat webview. */
export interface VoiceWebviewConfig {
  inputEnabled: boolean;
  outputEnabled: boolean;
  /** BCP 47 language tag passed to SpeechRecognition.lang. */
  language: string;
}

/** Structural shape of `vscode.workspace.getConfiguration('sunday')`. */
export interface VoiceConfigSource {
  get<T>(key: string, def: T): T;
}

/**
 * Build the `sunday/voice/config` message from the `sunday.*` workspace
 * configuration. Missing keys fall back to the documented defaults.
 */
export function buildVoiceConfigMessage(cfg: VoiceConfigSource): {
  type: 'sunday/voice/config';
} & VoiceWebviewConfig {
  return {
    type: 'sunday/voice/config',
    inputEnabled: cfg.get<boolean>('voice.inputEnabled', false),
    outputEnabled: cfg.get<boolean>('voice.outputEnabled', false),
    // Normalize up front so the webview can trust the value for
    // SpeechRecognition.lang (garbage tags silently fail in some browsers).
    language: normalizeVoiceLanguage(cfg.get<string>('voice.language', VOICE_DEFAULT_LANGUAGE)),
  };
}

/**
 * Normalize a user-provided BCP 47 tag to a safe value for
 * SpeechRecognition.lang. Falls back to the default on anything that is
 * not a plausible language tag (letters, digits, dashes).
 */
export function normalizeVoiceLanguage(raw: unknown): string {
  if (typeof raw === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(raw.trim())) {
    return raw.trim();
  }
  return VOICE_DEFAULT_LANGUAGE;
}
