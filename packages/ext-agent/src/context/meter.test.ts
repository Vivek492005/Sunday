// Tests for context/meter.ts — segment accounting is correct.
import { describe, expect, it } from 'vitest';
import { ContextMeter } from './meter.js';

describe('ContextMeter', () => {
  it('starts empty', () => {
    const m = new ContextMeter({ limit: 1000 });
    const u = m.getContextUsage();
    expect(u.used).toBe(0);
    expect(u.percent).toBe(0);
    expect(u.remaining).toBe(1000);
  });

  it('tracks tokens by segment kind', () => {
    const m = new ContextMeter({ limit: 1000 });
    m.setSegment('system', 'a'.repeat(400)); // 100 tokens
    m.setSegment('rules', 'b'.repeat(200)); // 50 tokens
    const u = m.getContextUsage();
    expect(u.breakdown.system).toBe(100);
    expect(u.breakdown.rules).toBe(50);
    expect(u.used).toBe(150);
    expect(u.percent).toBeCloseTo(0.15);
  });

  it('upserts by id and can remove segments', () => {
    const m = new ContextMeter({ limit: 1000 });
    const id = m.setSegment('files', 'x'.repeat(400));
    expect(m.getContextUsage().used).toBe(100);
    m.setSegment('files', 'y'.repeat(800), id); // upsert same id
    expect(m.getContextUsage().used).toBe(200);
    expect(m.removeSegment(id)).toBe(true);
    expect(m.getContextUsage().used).toBe(0);
  });

  it('resolves model limits and allows override', () => {
    expect(new ContextMeter({ modelId: 'qwen-2.5-coder-32b' }).getLimit()).toBe(32768);
    expect(new ContextMeter({ modelId: 'auto' }).getLimit()).toBe(128000);
    const m = new ContextMeter({ limit: 500 });
    m.setLimit(2000);
    expect(m.getLimit()).toBe(2000);
  });

  it('clears a whole kind', () => {
    const m = new ContextMeter({ limit: 10000 });
    m.setSegment('toolOutputs', 'a'.repeat(400));
    m.setSegment('toolOutputs', 'b'.repeat(400));
    m.clearKind('toolOutputs');
    expect(m.getContextUsage().breakdown.toolOutputs).toBe(0);
  });
});
