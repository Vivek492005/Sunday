// Tests for the orchestration entitlement caps: pool-size clamping,
// parallel forcing, the cap note, and the caps object forwarded to the
// daemon. Pure — no vscode, no network.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PARALLEL,
  MAX_PARALLEL_CEILING,
  resolveOrchestrationCaps,
} from './orchestrationGating.js';
import { makeView } from './testFixtures.js';

describe('resolveOrchestrationCaps', () => {
  it('fails open when entitlements are unknown', () => {
    const r = resolveOrchestrationCaps({
      requestedParallel: true,
      requestedMaxParallel: 5,
      view: undefined,
    });
    expect(r).toMatchObject({ parallel: true, maxParallel: 5, capped: false });
    expect(r.capNote).toBeUndefined();
    expect(r.entitlementCaps).toBeUndefined();
  });

  it('clamps the pool to max_feature_agents and notes the cap', () => {
    const r = resolveOrchestrationCaps({
      requestedParallel: true,
      requestedMaxParallel: 4,
      view: makeView({ 'orchestration.max_feature_agents': 2, 'orchestration.parallel': true }),
    });
    expect(r).toMatchObject({ parallel: true, maxParallel: 2, capped: true });
    expect(r.capNote).toBe('Capped at 2 agents on your plan');
    expect(r.entitlementCaps).toEqual({ maxFeatureAgents: 2, parallelAllowed: true });
  });

  it('forces parallel off when the plan denies it, even with parallel requested', () => {
    const r = resolveOrchestrationCaps({
      requestedParallel: true,
      requestedMaxParallel: 2,
      view: makeView({ 'orchestration.max_feature_agents': 2, 'orchestration.parallel': false }),
    });
    expect(r.parallel).toBe(false);
    expect(r.maxParallel).toBe(2);
    expect(r.capped).toBe(false);
  });

  it('passes parallel through when the plan allows it and nothing is capped', () => {
    const r = resolveOrchestrationCaps({
      requestedParallel: true,
      requestedMaxParallel: 2,
      view: makeView({ 'orchestration.max_feature_agents': 4, 'orchestration.parallel': true }),
    });
    expect(r).toMatchObject({ parallel: true, maxParallel: 2, capped: false });
    expect(r.capNote).toBeUndefined();
  });

  it('defaults the requested pool to 3 and never exceeds the hard ceiling', () => {
    const view = makeView({ 'orchestration.max_feature_agents': 99, 'orchestration.parallel': true });
    expect(
      resolveOrchestrationCaps({ requestedParallel: true, view }).maxParallel,
    ).toBe(DEFAULT_MAX_PARALLEL);
    expect(
      resolveOrchestrationCaps({ requestedParallel: true, requestedMaxParallel: 99, view })
        .maxParallel,
    ).toBe(MAX_PARALLEL_CEILING);
  });

  it('floors degenerate inputs at one agent', () => {
    const r = resolveOrchestrationCaps({
      requestedParallel: false,
      requestedMaxParallel: 0,
      view: makeView({ 'orchestration.max_feature_agents': 0 }),
    });
    expect(r.maxParallel).toBe(1);
    expect(r.entitlementCaps).toEqual({ maxFeatureAgents: 1, parallelAllowed: false });
  });
});
