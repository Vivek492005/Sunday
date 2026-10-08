import { useRef, useState } from 'react';
import {
  applyMentionInsert,
  filterMentionItems,
  mentionQueryAtCaret,
  moveSelection,
  type MentionItem,
  type PopupState,
} from './mentionQuery.js';
import {
  fileToDataUrl,
  makeAttachment,
  maybeDownscaleImage,
  type AttachedImage,
  type ImageWire,
} from './images.js';
import { MentionPopup } from './MentionPopup.js';
import { postToExtension } from './vscode.js';
import {
  VoiceRecognizer,
  getSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
  type VoiceInputState,
} from './voice.js';

/** Tooltip on the mic button when the Web Speech API is unavailable. */
export const VOICE_UNSUPPORTED_TOOLTIP = 'Voice input not supported in this browser';

interface KeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
}

interface PasteFile {
  type: string;
  name?: string;
}

export function Composer({
  onSend,
  disabled,
  voiceInputEnabled = false,
  voiceLanguage = 'en-US',
}: {
  /** Text plus image attachments (data: URLs) from pastes. */
  onSend: (text: string, images: ImageWire[]) => void;
  disabled: boolean;
  /** Show the microphone button (Web Speech API). Default off. */
  voiceInputEnabled?: boolean;
  /** BCP 47 language tag for SpeechRecognition.lang. Default en-US. */
  voiceLanguage?: string;
}): JSX.Element {
  const [text, setText] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceInputState>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [interim, setInterim] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recognizerRef = useRef<VoiceRecognizer | null>(null);

  const voiceSupported = voiceInputEnabled && isSpeechRecognitionSupported();

  const toggleVoice = (): void => {
    if (!voiceSupported) {
      // The button stays visible with an explanatory tooltip even when the
      // API is missing; the extension host shows a native info message.
      postToExtension({ type: 'sunday/voice/unsupported' });
      return;
    }
    if (recognizerRef.current?.state === 'listening') {
      recognizerRef.current.stop();
      return;
    }
    setVoiceError(null);
    setInterim('');
    const rec = new VoiceRecognizer(getSpeechRecognitionCtor(), {
      onTranscript: (t, isFinal) => {
        if (isFinal) {
          setText((prev) => (prev ? `${prev} ${t}` : t));
          setInterim('');
        } else {
          setInterim(t);
        }
      },
      onError: (msg) => {
        setVoiceError(msg);
        setVoiceState('error');
      },
      onEnd: () => {
        setVoiceState('idle');
        setInterim('');
      },
    });
    recognizerRef.current = rec;
    if (rec.start(voiceLanguage)) setVoiceState('listening');
    else setVoiceState('error');
  };

  const refreshPopup = (nextText: string, caret: number): void => {
    const q = mentionQueryAtCaret(nextText, caret);
    if (!q) {
      setPopup(null);
      return;
    }
    const items = filterMentionItems(q.query);
    setPopup((prev) => ({
      items,
      selected: prev && prev.anchor === q.start ? Math.min(prev.selected, Math.max(0, items.length - 1)) : 0,
      anchor: q.start,
    }));
  };

  const submit = (): void => {
    const t = text.trim();
    if ((!t && images.length === 0) || disabled) return;
    onSend(
      t,
      images.map((i) => ({ name: i.name, dataUrl: i.dataUrl })),
    );
    setText('');
    setImages([]);
    setPopup(null);
  };

  const acceptPopupItem = (item: MentionItem): void => {
    if (!popup) return;
    const caret = textareaRef.current?.selectionStart ?? text.length;
    const q = mentionQueryAtCaret(text, caret);
    if (!q) {
      setPopup(null);
      return;
    }
    const { text: next, caret: nextCaret } = applyMentionInsert(text, q.start, q.query.length, item);
    setText(next);
    setPopup(null);
    // Place the caret after the insertion once React re-renders (webview only).
    if (typeof document !== 'undefined' && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLTextAreaElement>('.composer textarea');
        if (el) {
          el.focus();
          el.setSelectionRange(nextCaret, nextCaret);
        }
      });
    }
  };

  const onKeyDown = (e: KeyEvent): void => {
    if (popup) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPopup((p) => (p ? moveSelection(p, 1) : p));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPopup((p) => (p ? moveSelection(p, -1) : p));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPopup(null);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const item = popup.items[popup.selected];
        if (item && !e.shiftKey) {
          e.preventDefault();
          acceptPopupItem(item);
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: {
    clipboardData?: { files?: ArrayLike<PasteFile & Blob> | null } | null;
    preventDefault(): void;
  }): void => {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    e.preventDefault();
    void (async () => {
      for (const file of imageFiles) {
        try {
          const dataUrl = await maybeDownscaleImage(await fileToDataUrl(file));
          setImages((prev) => [...prev, makeAttachment(file.name ?? 'pasted image', dataUrl)]);
        } catch {
          // Never break a paste: skip unreadable files.
        }
      }
    })();
  };

  const removeImage = (id: string): void => {
    setImages((prev) => prev.filter((i) => i.id !== id));
  };

  const selectedItem = popup && popup.items.length > 0 ? popup.items[popup.selected] : undefined;

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="attachment-row" role="group" aria-label="Attached images">
          {images.map((img) => (
            <span key={img.id} className="attachment-chip">
              <img src={img.dataUrl} alt={img.name} className="attachment-thumb" />
              <span className="attachment-name">{img.name}</span>
              <button
                type="button"
                className="attachment-remove"
                aria-label={`Remove ${img.name}`}
                onClick={() => removeImage(img.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-input-wrap">
        {popup && popup.items.length > 0 && selectedItem && (
          <MentionPopup items={popup.items} selected={popup.selected} onPick={acceptPopupItem} />
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e: { target: { value: string; selectionStart: number } }) => {
            setText(e.target.value);
            refreshPopup(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste as never}
          onClick={(e: { currentTarget: { selectionStart: number } }) =>
            refreshPopup(text, e.currentTarget.selectionStart)
          }
          placeholder="Ask Sunday… (Enter to send, Shift+Enter for newline)"
          rows={3}
          disabled={disabled}
          aria-label="Chat input"
          role="combobox"
          aria-expanded={popup !== null}
          aria-controls={popup ? 'mention-popup' : undefined}
          aria-activedescendant={popup ? `mention-opt-${popup.selected}` : undefined}
          aria-autocomplete="list"
        />
      </div>
      <button
        className="send-btn"
        onClick={submit}
        disabled={disabled || (!text.trim() && images.length === 0)}
        aria-label="Send"
      >
        ↑
      </button>
      {voiceInputEnabled && (
        <button
          type="button"
          className={`mic-btn${voiceState === 'listening' ? ' listening' : ''}${
            voiceSupported ? '' : ' unsupported'
          }`}
          onClick={toggleVoice}
          disabled={disabled}
          aria-label={
            voiceSupported
              ? voiceState === 'listening'
                ? 'Stop voice input'
                : 'Start voice input'
              : 'Voice input unavailable'
          }
          title={
            voiceSupported
              ? voiceState === 'listening'
                ? 'Stop listening'
                : 'Dictate with your microphone (processed on-device by your browser)'
              : VOICE_UNSUPPORTED_TOOLTIP
          }
        >
          {voiceState === 'listening' ? '⏹' : '🎤'}
        </button>
      )}
      {voiceState === 'listening' && (
        <span className="voice-status" role="status" aria-live="polite">
          Listening…{interim ? ` "${interim}"` : ''}
        </span>
      )}
      {voiceError && (
        <span className="voice-error" role="alert">
          {voiceError}
        </span>
      )}
    </div>
  );
}
