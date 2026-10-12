// sunday-agent — sundayModels tests (Phase 3: single source of truth).
import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { SUNDAY_MODELS, findSundayModel } from './sundayModels.js';
import { SUNDAY_LM_MODELS } from './sundayModelProvider.js';
import { SUNDAY_PARTICIPANT_MODELS } from './lmProvider.js';

describe('sundayModels (canonical list)', () => {
  it('has exactly 4 models', () => {
    expect(SUNDAY_MODELS).toHaveLength(4);
  });

  it('has unique ids', () => {
    const ids = SUNDAY_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every model has a gateway ref and label', () => {
    for (const m of SUNDAY_MODELS) {
      expect(m.ref).toMatch(/^(sunday|groq|openrouter):/);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.tooltip.length).toBeGreaterThan(0);
    }
  });

  it('findSundayModel falls back to auto for unknown ids', () => {
    expect(findSundayModel('nope').id).toBe('auto');
    expect(findSundayModel(undefined).id).toBe('auto');
    expect(findSundayModel('qwen-2.5-coder-32b').id).toBe('qwen-2.5-coder-32b');
  });

  it('sundayModelProvider re-exports the canonical list (no drift)', () => {
    expect(SUNDAY_LM_MODELS.map((m) => m.id)).toEqual(SUNDAY_MODELS.map((m) => m.id));
  });

  it('lmProvider participant models match the canonical list (no drift)', () => {
    expect(SUNDAY_PARTICIPANT_MODELS.map((m) => m.id)).toEqual(SUNDAY_MODELS.map((m) => m.id));
    expect(SUNDAY_PARTICIPANT_MODELS.map((m) => m.ref)).toEqual(SUNDAY_MODELS.map((m) => m.ref));
  });
});
