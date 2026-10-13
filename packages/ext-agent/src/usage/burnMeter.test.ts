// Tests for usage/burnMeter.ts — pure text/tooltip rendering.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { createStatusBarItem: vi.fn() },
  commands: { registerCommand: vi.fn() },
  StatusBarAlignment: { Right: 2 },
}));

import { burnMeterText, burnMeterTooltip } from './burnMeter.js';

describe('burnMeterText', () => {
  it('shows used/limit', () => {
    expect(burnMeterText(58, 200, undefined)).toBe('$(dashboard) 58/200');
  });
  it('omits the limit when unknown', () => {
    expect(burnMeterText(58, undefined, undefined)).toBe('$(dashboard) 58');
  });
  it('appends current task spend', () => {
    expect(burnMeterText(58, 200, 12)).toBe('$(dashboard) 58/200 · task 12');
  });
  it('clamps negatives to zero', () => {
    expect(burnMeterText(-5, 200, undefined)).toBe('$(dashboard) 0/200');
  });
});

describe('burnMeterTooltip', () => {
  it('shows remaining, reset and task spend', () => {
    const t = burnMeterTooltip(58, 200, '00:00 UTC', 12);
    expect(t).toMatch(/142 of 200 daily requests remaining/);
    expect(t).toMatch(/Resets 00:00 UTC/);
    expect(t).toMatch(/Current task: 12 requests/);
  });
  it('degrades gracefully without a limit', () => {
    const t = burnMeterTooltip(58, undefined, '00:00 UTC', undefined);
    expect(t).toMatch(/58 requests used today/);
    expect(t).not.toMatch(/Current task/);
  });
});
