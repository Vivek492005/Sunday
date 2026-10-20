/**
 * Design Mode context chip — an element picked in the Ops → Browser
 * Design Mode preview, attached to the next Agent message.
 *
 * The chip is renderer-local state (localStorage + CustomEvent), exactly
 * like the agent history: the Browser panel sets it, the Agent panel
 * reads it and prepends it to the outgoing prompt as structured context.
 */

export interface DesignChip {
  /** CSS selector path that uniquely identifies the element on the page. */
  selector: string;
  /** Lowercase tag name, e.g. 'button'. */
  tag: string;
  /** Visible text of the element (truncated at pick time). */
  text: string;
  /** Page URL the element was picked on. */
  url: string;
  /** Epoch ms when the element was picked. */
  pickedAt: number;
}

const KEY = 'sunday.design.chip.v1';
export const DESIGN_CHIP_EVENT = 'sunday:design-chip';

export function getDesignChip(): DesignChip | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DesignChip;
    if (typeof parsed?.selector !== 'string' || typeof parsed?.tag !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setDesignChip(chip: DesignChip): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(chip));
  } catch {
    // storage unavailable — the event below still delivers the chip
  }
  window.dispatchEvent(new CustomEvent<DesignChip>(DESIGN_CHIP_EVENT, { detail: chip }));
}

export function clearDesignChip(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // non-fatal
  }
  window.dispatchEvent(new CustomEvent<DesignChip | null>(DESIGN_CHIP_EVENT, { detail: null }));
}

/** Subscribe to chip changes. Returns an unsubscribe function. */
export function onDesignChipChange(cb: (chip: DesignChip | null) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<DesignChip | null>).detail;
    cb(detail ?? getDesignChip());
  };
  window.addEventListener(DESIGN_CHIP_EVENT, handler);
  return () => window.removeEventListener(DESIGN_CHIP_EVENT, handler);
}

/** The prompt prefix prepended to the agent message when a chip is attached. */
export function designChipPromptPrefix(chip: DesignChip): string {
  return [
    '[Design Mode context — the user picked this element in the page preview]',
    `Page: ${chip.url}`,
    `Element: <${chip.tag}>`,
    `Selector: ${chip.selector}`,
    chip.text ? `Text: "${chip.text}"` : '',
    'Apply the request below to this element.',
    '---',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}
