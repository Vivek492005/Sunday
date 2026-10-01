import type { MentionItem } from './mentionPopup.js';

/** Presentational @-mention popup list. All logic lives in mentionPopup.ts;
 *  this component only renders the items and the current highlight. */
export function MentionPopup({
  items,
  selected,
  onPick,
}: {
  items: MentionItem[];
  selected: number;
  onPick: (item: MentionItem) => void;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="mention-popup" id="mention-popup" role="listbox" aria-label="Mention suggestions">
      {items.map((item, i) => (
        <div
          key={item.kind}
          id={`mention-opt-${i}`}
          role="option"
          aria-selected={i === selected}
          className={'mention-item' + (i === selected ? ' selected' : '')}
          onMouseDown={(e) => {
            // mousedown (not click): apply before the textarea loses focus.
            e.preventDefault();
            onPick(item);
          }}
        >
          <span className="mention-label">{item.label}</span>
          {item.hint && <span className="mention-hint">{item.hint}</span>}
          <span className="mention-desc">{item.description}</span>
        </div>
      ))}
    </div>
  );
}
