import { useState } from 'react';

interface KeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
}

export function Composer({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
}): JSX.Element {
  const [text, setText] = useState('');

  const submit = (): void => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  };

  const onKeyDown = (e: KeyEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e: { target: { value: string } }) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask Sunday… (Enter to send, Shift+Enter for newline)"
        rows={3}
        disabled={disabled}
        aria-label="Chat input"
      />
      <button className="send-btn" onClick={submit} disabled={disabled || !text.trim()} aria-label="Send">
        ↑
      </button>
    </div>
  );
}
