// Tests for the model-picker gates: managed-model exclusion, daily-limit
// greying, and the selection block message. All pure — no vscode, no network.
import { describe, expect, it } from 'vitest';
import {
  DAILY_LIMIT_HINT,
  gateModelList,
  isManagedModel,
  modelSelectionBlock,
  MANAGED_PROVIDER_ID,
} from './modelGating.js';
import { makeView } from './testFixtures.js';

const MODELS = [
  { id: 'sunday:flash', provider: 'sunday', label: 'Sunday Flash' },
  { id: 'openrouter:llama', provider: 'openrouter', label: 'Llama 3.3' },
  { id: 'groq:llama', provider: 'groq', label: 'Groq Llama' },
];

describe('isManagedModel', () => {
  it('treats the sunday provider as managed', () => {
    expect(isManagedModel({ provider: MANAGED_PROVIDER_ID })).toBe(true);
    expect(isManagedModel({ provider: 'groq' })).toBe(false);
  });
});

describe('gateModelList', () => {
  it('fails open when entitlements are unknown', () => {
    expect(gateModelList(MODELS, undefined, 999)).toEqual(MODELS);
  });

  it('excludes managed models when managed_models.enabled is false', () => {
    const view = makeView({ 'managed_models.enabled': false });
    const gated = gateModelList(MODELS, view, 0);
    expect(gated.map((m) => m.id)).toEqual(['openrouter:llama', 'groq:llama']);
  });

  it('keeps managed models selectable when under the daily limit', () => {
    const view = makeView({ 'managed_models.enabled': true, 'managed_models.daily_requests': 200 });
    const gated = gateModelList(MODELS, view, 199);
    expect(gated.find((m) => m.id === 'sunday:flash')?.disabled).toBeUndefined();
  });

  it('greys managed models with the upgrade hint when the daily limit is reached', () => {
    const view = makeView({ 'managed_models.enabled': true, 'managed_models.daily_requests': 200 });
    const gated = gateModelList(MODELS, view, 200);
    const managed = gated.find((m) => m.id === 'sunday:flash');
    const byok = gated.find((m) => m.id === 'groq:llama');
    expect(managed).toMatchObject({ disabled: true, hint: DAILY_LIMIT_HINT });
    expect(byok?.disabled).toBeUndefined();
    // nothing is dropped — the user can still see what they're missing
    expect(gated).toHaveLength(3);
  });

  it('treats a zero daily limit as unlimited (not exhausted)', () => {
    const view = makeView({ 'managed_models.enabled': true, 'managed_models.daily_requests': 0 });
    const gated = gateModelList(MODELS, view, 10_000);
    expect(gated.every((m) => !m.disabled)).toBe(true);
  });
});

describe('modelSelectionBlock', () => {
  it('allows unlisted/unknown models (fail open)', () => {
    expect(modelSelectionBlock([], 'sunday:flash')).toBeUndefined();
    expect(modelSelectionBlock(gateModelList(MODELS, undefined, 0), undefined)).toBeUndefined();
  });

  it('blocks a model excluded from the gated list', () => {
    const view = makeView({ 'managed_models.enabled': false });
    const gated = gateModelList(MODELS, view, 0);
    expect(modelSelectionBlock(gated, 'sunday:flash')).toMatch(/not available on your plan/);
  });

  it('blocks a greyed model with its hint', () => {
    const view = makeView({ 'managed_models.enabled': true, 'managed_models.daily_requests': 1 });
    const gated = gateModelList(MODELS, view, 1);
    const reason = modelSelectionBlock(gated, 'sunday:flash');
    expect(reason).toContain('Sunday Flash');
    expect(reason).toContain(DAILY_LIMIT_HINT);
  });

  it('allows a selectable model', () => {
    const view = makeView({ 'managed_models.enabled': true });
    const gated = gateModelList(MODELS, view, 0);
    expect(modelSelectionBlock(gated, 'sunday:flash')).toBeUndefined();
    expect(modelSelectionBlock(gated, 'groq:llama')).toBeUndefined();
  });
});
