import type { ModelView } from './chatClient.js';

export function ModelPill({
  models,
  selected,
  onSelect,
}: {
  models: ModelView[];
  selected: string | undefined;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <label className="model-pill" title="Model for the next turn">
      <span className="model-pill-icon">◈</span>
      <select
        value={selected ?? ''}
        onChange={(e: { target: { value: string } }) => onSelect(e.target.value)}
        aria-label="Model"
        disabled={models.length === 0}
      >
        {models.length === 0 && <option value="">loading models…</option>}
        {models.map((m) => (
          <option
            key={m.id}
            value={m.id}
            // Task 7: plan-gated models render greyed with the upgrade hint;
            // the option is disabled so it can't be picked from the dropdown.
            title={m.hint ? `${m.provider} — ${m.hint}` : m.provider}
            disabled={m.disabled === true}
            aria-disabled={m.disabled === true}
          >
            {m.disabled && m.hint ? `${m.label} — ${m.hint}` : m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
