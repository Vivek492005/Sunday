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
          <option key={m.id} value={m.id} title={m.provider}>
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
