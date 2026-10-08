// Tests for voice.ts: recognizer state machine, speech helpers, config gating.
// Browser speech APIs are faked; no DOM, no network, no microphone.
import { describe, expect, it, vi } from 'vitest';
import {
  VoiceRecognizer,
  isSpeechRecognitionSupported,
  isSpeechSynthesisSupported,
  speakText,
  stopSpeaking,
  stripForSpeech,
  summarizeForSpeech,
  VOICE_CONFIG_DEFAULTS,
  type SpeechRecognitionCtor,
  type SpeechRecognitionLike,
  type VoiceWindow,
} from './voice.js';

interface FakeHarness {
  ctor: SpeechRecognitionCtor;
  instances: SpeechRecognitionLike[];
  emitOn: (rec: SpeechRecognitionLike, transcript: string, isFinal: boolean) => void;
  failOn: (rec: SpeechRecognitionLike, error: string) => void;
}

function makeFakeCtor(): FakeHarness {
  const instances: SpeechRecognitionLike[] = [];
  class FakeRec implements SpeechRecognitionLike {
    lang = '';
    interimResults = false;
    maxAlternatives = 1;
    continuous = false;
    onresult: ((e: any) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    stopped = false;
    start(): void {
      this.started = true;
      instances.push(this);
    }
    stop(): void {
      this.stopped = true;
      this.onend?.();
    }
    abort(): void {
      this.onend?.();
    }
    /** Simulate a recognition result. */
    emit(transcript: string, isFinal: boolean): void {
      this.onresult?.({
        resultIndex: 0,
        results: [{ isFinal, 0: { transcript } }],
      });
    }
  }
  return {
    ctor: FakeRec as unknown as SpeechRecognitionCtor,
    instances,
    emitOn: (rec: SpeechRecognitionLike, transcript: string, isFinal: boolean) =>
      (rec as unknown as { emit(t: string, f: boolean): void }).emit(transcript, isFinal),
    failOn: (rec: SpeechRecognitionLike, error: string) => rec.onerror?.({ error }),
  };
}

function cb() {
  return {
    onTranscript: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
  };
}

describe('speech API detection', () => {
  it('detects webkitSpeechRecognition', () => {
    const { ctor } = makeFakeCtor();
    const w = { webkitSpeechRecognition: ctor } as VoiceWindow;
    expect(isSpeechRecognitionSupported(w)).toBe(true);
    expect(isSpeechRecognitionSupported({} as VoiceWindow)).toBe(false);
  });

  it('detects speechSynthesis', () => {
    const w = {
      speechSynthesis: { speak: () => undefined, cancel: () => undefined, speaking: false },
      SpeechSynthesisUtterance: function (this: any, t: string) {
        this.text = t;
      },
    } as unknown as VoiceWindow;
    expect(isSpeechSynthesisSupported(w)).toBe(true);
    expect(isSpeechSynthesisSupported({} as VoiceWindow)).toBe(false);
  });
});

describe('VoiceRecognizer state machine', () => {
  it('starts listening and reports interim then final transcripts', () => {
    const { ctor, instances, emitOn } = makeFakeCtor();
    const c = cb();
    const r = new VoiceRecognizer(ctor, c);
    expect(r.supported).toBe(true);
    expect(r.state).toBe('idle');
    expect(r.start()).toBe(true);
    expect(r.state).toBe('listening');
    const rec = instances[0];
    emitOn(rec, 'hello wor', false);
    expect(c.onTranscript).toHaveBeenCalledWith('hello wor', false);
    emitOn(rec, 'hello world', true);
    expect(c.onTranscript).toHaveBeenCalledWith('hello world', true);
  });

  it('stop() ends listening and fires onEnd', () => {
    const { ctor, instances } = makeFakeCtor();
    const c = cb();
    const r = new VoiceRecognizer(ctor, c);
    r.start();
    r.stop();
    expect(r.state).toBe('idle');
    expect((instances[0] as unknown as { stopped: boolean }).stopped).toBe(true);
    expect(c.onEnd).toHaveBeenCalled();
  });

  it('second start while listening is a no-op', () => {
    const { ctor, instances } = makeFakeCtor();
    const r = new VoiceRecognizer(ctor, cb());
    expect(r.start()).toBe(true);
    expect(r.start()).toBe(false);
    expect(instances.length).toBe(1);
  });

  it('unsupported ctor: start returns false, stays idle', () => {
    const c = cb();
    const r = new VoiceRecognizer(undefined, c);
    expect(r.supported).toBe(false);
    expect(r.start()).toBe(false);
    expect(r.state).toBe('idle');
    expect(c.onError).not.toHaveBeenCalled();
  });

  it('API error surfaces a friendly message and error state', () => {
    const { ctor, instances, failOn } = makeFakeCtor();
    const c = cb();
    const r = new VoiceRecognizer(ctor, c);
    r.start();
    failOn(instances[0], 'not-allowed');
    expect(r.state).toBe('error');
    expect(c.onError).toHaveBeenCalledWith(expect.stringContaining('Microphone access was denied'));
  });

  it('abort() resets to idle without error', () => {
    const { ctor } = makeFakeCtor();
    const c = cb();
    const r = new VoiceRecognizer(ctor, c);
    r.start();
    r.abort();
    expect(r.state).toBe('idle');
    expect(c.onError).not.toHaveBeenCalled();
  });
});

describe('speakText', () => {
  function ttsWindow(spoken: string[]): VoiceWindow {
    return {
      speechSynthesis: {
        speak: (u: { text: string }) => {
          spoken.push(u.text);
        },
        cancel: () => undefined,
        speaking: false,
      },
      SpeechSynthesisUtterance: function (this: any, t: string) {
        this.text = t;
      },
    } as unknown as VoiceWindow;
  }

  it('speaks cleaned text when supported', () => {
    const spoken: string[] = [];
    expect(speakText('Hello **world**', {}, ttsWindow(spoken))).toBe(true);
    expect(spoken[0]).toBe('Hello world');
  });

  it('returns false when unsupported', () => {
    expect(speakText('hi', {}, {} as VoiceWindow)).toBe(false);
  });

  it('skips empty text', () => {
    const spoken: string[] = [];
    expect(speakText('   ', {}, ttsWindow(spoken))).toBe(false);
    expect(spoken).toHaveLength(0);
  });

  it('stopSpeaking cancels without throwing', () => {
    const cancel = vi.fn();
    stopSpeaking({ speechSynthesis: { cancel, speak: () => undefined, speaking: true } } as unknown as VoiceWindow);
    expect(cancel).toHaveBeenCalled();
    expect(() => stopSpeaking({} as VoiceWindow)).not.toThrow();
  });
});

describe('summarizeForSpeech', () => {
  it('keeps short text intact', () => {
    expect(summarizeForSpeech('Short answer.', 500)).toBe('Short answer.');
  });

  it('truncates long text at a sentence boundary', () => {
    const long = 'First sentence. ' + 'x'.repeat(600);
    const out = summarizeForSpeech(long, 100);
    expect(out.startsWith('First sentence.')).toBe(true);
    expect(out).toContain('truncated for speech');
  });

  it('falls back to hard cut when no sentence boundary', () => {
    const out = summarizeForSpeech('z'.repeat(600), 100);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain('truncated for speech');
  });
});

describe('stripForSpeech', () => {
  it('removes code fences, inline code, links, headings', () => {
    const md = '## Title\nHere is `code` and ```\nblock()\n``` plus [link](https://x).';
    const out = stripForSpeech(md);
    expect(out).not.toContain('```');
    expect(out).not.toContain('https://x');
    expect(out).toContain('Title');
    expect(out).toContain('code');
    expect(out).toContain('[code block]');
  });
});

describe('voice config defaults', () => {
  it('both voice features default to off, language to en-US', () => {
    expect(VOICE_CONFIG_DEFAULTS).toEqual({
      inputEnabled: false,
      outputEnabled: false,
      language: 'en-US',
    });
  });
});

describe('recognizer options (Group D spec)', () => {
  it('uses interim results, non-continuous recognition', () => {
    const { ctor, instances } = makeFakeCtor();
    const r = new VoiceRecognizer(ctor, cb());
    expect(r.start()).toBe(true);
    const rec = instances[0] as SpeechRecognitionLike;
    expect(rec.interimResults).toBe(true);
    expect(rec.continuous).toBe(false);
    expect(rec.maxAlternatives).toBe(1);
  });

  it('defaults the recognition language to en-US', () => {
    const { ctor, instances } = makeFakeCtor();
    const r = new VoiceRecognizer(ctor, cb());
    r.start();
    expect((instances[0] as SpeechRecognitionLike).lang).toBe('en-US');
  });

  it('honors an explicit language tag', () => {
    const { ctor, instances } = makeFakeCtor();
    const r = new VoiceRecognizer(ctor, cb());
    r.start('hi-IN');
    expect((instances[0] as SpeechRecognitionLike).lang).toBe('hi-IN');
  });
});
