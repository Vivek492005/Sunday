import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  IDLE_TIMEOUT_ENV,
  IdleShutdownManager,
  parseIdleTimeoutMinutes,
  type IdleShutdownOptions,
} from './idle-shutdown.js';

function makeManager(overrides: Partial<IdleShutdownOptions> = {}) {
  const calls: string[] = [];
  const timers = new Map<number, () => void>();
  let nextId = 1;
  let nowMs = 1_000_000;
  const manager = new IdleShutdownManager({
    idleTimeoutMinutes: 30,
    onIdleShutdown: (reason) => calls.push(reason),
    getClientCount: () => 0,
    getActiveSessionCount: () => 0,
    setIntervalFn: ((fn: () => void) => {
      const id = nextId++;
      timers.set(id, fn);
      return id as unknown as NodeJS.Timeout;
    }) as typeof setInterval,
    clearIntervalFn: ((id: unknown) => {
      timers.delete(id as number);
    }) as typeof clearInterval,
    now: () => nowMs,
    log: () => undefined,
    ...overrides,
  });
  return {
    manager,
    calls,
    timers,
    fireTimers: () => [...timers.values()].forEach((fn) => fn()),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('parseIdleTimeoutMinutes', () => {
  it('defaults to 30 when unset', () => {
    expect(parseIdleTimeoutMinutes({})).toBe(DEFAULT_IDLE_TIMEOUT_MINUTES);
    expect(parseIdleTimeoutMinutes({})).toBe(30);
  });

  it('parses the env var', () => {
    expect(parseIdleTimeoutMinutes({ [IDLE_TIMEOUT_ENV]: '10' })).toBe(10);
    expect(parseIdleTimeoutMinutes({ [IDLE_TIMEOUT_ENV]: '0' })).toBe(0);
  });

  it('falls back to default on garbage', () => {
    expect(parseIdleTimeoutMinutes({ [IDLE_TIMEOUT_ENV]: 'soon' })).toBe(30);
    expect(parseIdleTimeoutMinutes({ [IDLE_TIMEOUT_ENV]: '-5' })).toBe(30);
    expect(parseIdleTimeoutMinutes({ [IDLE_TIMEOUT_ENV]: '' })).toBe(30);
  });
});

describe('IdleShutdownManager', () => {
  it('fires after the timeout with 0 clients and 0 sessions', () => {
    const { manager, calls, fireTimers, advance } = makeManager({ idleTimeoutMinutes: 30 });
    manager.start();
    advance(29 * 60_000);
    fireTimers();
    expect(calls).toHaveLength(0);
    advance(2 * 60_000); // 31 min total
    fireTimers();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('idle for');
  });

  it('does not fire while clients are connected', () => {
    const { manager, calls, fireTimers, advance } = makeManager({
      idleTimeoutMinutes: 1,
      getClientCount: () => 2,
    });
    manager.start();
    advance(10 * 60_000);
    fireTimers();
    expect(calls).toHaveLength(0);
  });

  it('does not fire while sessions are active', () => {
    const { manager, calls, fireTimers, advance } = makeManager({
      idleTimeoutMinutes: 1,
      getActiveSessionCount: () => 3,
    });
    manager.start();
    advance(10 * 60_000);
    fireTimers();
    expect(calls).toHaveLength(0);
  });

  it('is disabled when idleTimeoutMinutes is 0', () => {
    const setIntervalSpy = vi.fn();
    const { manager, calls, fireTimers, advance } = makeManager({
      idleTimeoutMinutes: 0,
      setIntervalFn: setIntervalSpy as unknown as typeof setInterval,
    });
    manager.start();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    advance(24 * 60 * 60_000);
    fireTimers();
    expect(calls).toHaveLength(0);
  });

  it('recordActivity resets the clock', () => {
    const { manager, calls, fireTimers, advance } = makeManager({ idleTimeoutMinutes: 30 });
    manager.start();
    advance(29 * 60_000);
    manager.recordActivity();
    advance(29 * 60_000); // 29 min since last activity
    fireTimers();
    expect(calls).toHaveLength(0);
    advance(2 * 60_000); // 31 min since last activity
    fireTimers();
    expect(calls).toHaveLength(1);
  });

  it('fires only once', () => {
    const { manager, calls, fireTimers, advance } = makeManager({ idleTimeoutMinutes: 1 });
    manager.start();
    advance(5 * 60_000);
    fireTimers();
    fireTimers();
    expect(calls).toHaveLength(1);
  });

  it('stop() prevents firing', () => {
    const { manager, calls, fireTimers, advance } = makeManager({ idleTimeoutMinutes: 1 });
    manager.start();
    manager.stop();
    advance(5 * 60_000);
    fireTimers();
    expect(calls).toHaveLength(0);
  });
});
