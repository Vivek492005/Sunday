import type { ReactNode } from 'react';

export function StopButton({
  visible,
  onStop,
}: {
  visible: boolean;
  onStop: () => void;
}): ReactNode {
  if (!visible) return null;
  return (
    <button className="stop-btn" onClick={onStop} aria-label="Stop the active turn">
      ■ Stop
    </button>
  );
}
