// Tests for voice.ts: config message building, language normalization.
// vscode-free by design; the vscode-coupled fallback path (showInformationMessage)
// is covered in chatView.test.ts.
import { describe, expect, it } from 'vitest';
import {
  buildVoiceConfigMessage,
  normalizeVoiceLanguage,
  VOICE_DEFAULT_LANGUAGE,
  VOICE_UNSUPPORTED_MESSAGE,
  VOICE_UNSUPPORTED_TOOLTIP,
  type VoiceConfigSource,
} from './voice.js';

function fakeConfig(values: Record<string, unknown> = {}): VoiceConfigSource {
  return {
    get: <T>(key: string, def: T): T =>
      (key in values ? (values[key] as T) : def),
  };
}

describe('buildVoiceConfigMessage', () => {
  it('uses documented defaults when nothing is configured', () => {
    const msg = buildVoiceConfigMessage(fakeConfig());
    expect(msg).toEqual({
      type: 'sunday/voice/config',
      inputEnabled: false,
      outputEnabled: false,
      language: 'en-US',
    });
  });

  it('passes through enabled flags and the configured language', () => {
    const msg = buildVoiceConfigMessage(
      fakeConfig({ 'voice.inputEnabled': true, 'voice.outputEnabled': true, 'voice.language': 'hi-IN' }),
    );
    expect(msg.inputEnabled).toBe(true);
    expect(msg.outputEnabled).toBe(true);
    expect(msg.language).toBe('hi-IN');
  });

  it('falls back to en-US for a malformed language tag', () => {
    const msg = buildVoiceConfigMessage(fakeConfig({ 'voice.language': 'not a tag!!' }));
    expect(msg.language).toBe('en-US');
  });
});

describe('normalizeVoiceLanguage', () => {
  it('accepts valid BCP 47 tags', () => {
    expect(normalizeVoiceLanguage('en-US')).toBe('en-US');
    expect(normalizeVoiceLanguage('hi-IN')).toBe('hi-IN');
    expect(normalizeVoiceLanguage('pt-BR')).toBe('pt-BR');
  });

  it('rejects garbage and non-strings', () => {
    for (const bad of ['', 'e', 'en US', 'en_US!', '<script>', 42, undefined, null, {}]) {
      expect(normalizeVoiceLanguage(bad)).toBe(VOICE_DEFAULT_LANGUAGE);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeVoiceLanguage('  en-GB  ')).toBe('en-GB');
  });
});

describe('fallback strings', () => {
  it('uses the spec tooltip and message', () => {
    expect(VOICE_UNSUPPORTED_TOOLTIP).toBe('Voice input not supported in this browser');
    expect(VOICE_UNSUPPORTED_MESSAGE).toContain('not supported');
  });
});
