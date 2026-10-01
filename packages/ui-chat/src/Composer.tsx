import { useRef, useState } from 'react';
import {
  applyMentionInsert,
  filterMentionItems,
  mentionQueryAtCaret,
  moveSelection,
  type MentionItem,
  type PopupState,
} from './mentionPopup.js';
import {
  fileToDataUrl,
  makeAttachment,
  maybeDownscaleImage,
  type AttachedImage,
  type ImageWire,
} from './images.js';
import { MentionPopup } from './MentionPopup.js';

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
}: {
  /** Text plus image attachments (data: URLs) from pastes. */
  onSend: (text: string, images: ImageWire[]) => void;
  disabled: boolean;
}): JSX.Element {
  const [text, setText] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
        <div className="attachment-row" aria-label="Attached images">
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
    </div>
  );
}
