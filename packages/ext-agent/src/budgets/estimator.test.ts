// Tests for budgets/estimator.ts — pre-run task estimates are sane ranges.
import { describe, expect, it } from 'vitest';
import { estimateTask, formatEstimate } from './estimator.js';

describe('estimateTask', () => {
  it('returns a valid range for a simple message', () => {
    const e = estimateTask('hello');
    expect(e.minRequests).toBeGreaterThanOrEqual(2);
    expect(e.maxRequests).toBeGreaterThan(e.minRequests);
    expect(e.pointRequests).toBeGreaterThanOrEqual(e.minRequests);
    expect(e.pointRequests).toBeLessThanOrEqual(e.maxRequests);
  });

  it('is low confidence for very short messages', () => {
    expect(estimateTask('hi').confidence).toBe('low');
  });

  it('scales up with code blocks', () => {
    const plain = estimateTask('fix the bug in auth');
    const withCode = estimateTask('fix the bug in auth\n```ts\nconst x = 1;\n```');
    expect(withCode.pointRequests).toBeGreaterThan(plain.pointRequests);
  });

  it('adds for execution intent (test/run/fix)', () => {
    const plain = estimateTask('look at the config');
    const exec = estimateTask('run the tests and fix failures');
    expect(exec.pointRequests).toBeGreaterThan(plain.pointRequests);
    expect(exec.rationale).toMatch(/run\/test\/fix loop/);
  });

  it('adds for multi-file build intent', () => {
    const plain = estimateTask('look at the config');
    const build = estimateTask('refactor the auth module into services');
    expect(build.pointRequests).toBeGreaterThan(plain.pointRequests);
  });

  it('adds for research intent', () => {
    const plain = estimateTask('open the file');
    const research = estimateTask('explain how the router works and why it retries');
    expect(research.pointRequests).toBeGreaterThan(plain.pointRequests);
  });

  it('blends with past average and raises confidence', () => {
    const e = estimateTask('do the thing', { pastAvgRequests: 40 });
    expect(e.confidence).toBe('high');
    expect(e.pointRequests).toBeGreaterThan(estimateTask('do the thing').pointRequests);
    expect(e.rationale).toMatch(/history/);
  });

  it('handles empty/undefined-ish input without crashing', () => {
    const e = estimateTask('');
    expect(e.minRequests).toBeGreaterThanOrEqual(2);
    expect(e.maxRequests).toBeGreaterThan(e.minRequests);
  });

  it('formatEstimate renders the range', () => {
    const e = estimateTask('implement the feature with tests');
    expect(formatEstimate(e)).toMatch(/^~\d+–\d+ requests$/);
  });
});
