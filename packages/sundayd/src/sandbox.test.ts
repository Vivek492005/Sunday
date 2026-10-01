// @sunday/sundayd — sandbox config tests (env → SandboxConfig).
import { describe, expect, it } from 'vitest';
import {
  SANDBOX_DOCKER_IMAGE_ENV,
  SANDBOX_MODE_ENV,
  describeSandbox,
  parseSandboxMode,
  sandboxConfigFromEnv,
} from './sandbox.js';
import { DEFAULT_DOCKER_IMAGE } from '@sunday/tools';

describe('parseSandboxMode', () => {
  it('defaults to off', () => {
    expect(parseSandboxMode(undefined)).toBe('off');
    expect(parseSandboxMode('')).toBe('off');
    expect(parseSandboxMode('off')).toBe('off');
  });

  it('accepts docker and bubblewrap (case-insensitive, trimmed)', () => {
    expect(parseSandboxMode('docker')).toBe('docker');
    expect(parseSandboxMode('  BubbleWrap ')).toBe('bubblewrap');
  });

  it('throws on unknown modes — fail closed, never silently unsandboxed', () => {
    expect(() => parseSandboxMode('firejail')).toThrow(/invalid SUNDAY_SANDBOX_MODE/);
    expect(() => parseSandboxMode('firejail')).toThrow(/off, docker, bubblewrap/);
  });
});

describe('sandboxConfigFromEnv', () => {
  it('reads mode + image from the stamped env vars', () => {
    const cfg = sandboxConfigFromEnv({
      [SANDBOX_MODE_ENV]: 'docker',
      [SANDBOX_DOCKER_IMAGE_ENV]: 'node:22-alpine',
    });
    expect(cfg).toEqual({ mode: 'docker', dockerImage: 'node:22-alpine' });
  });

  it('falls back to the default image when unset', () => {
    const cfg = sandboxConfigFromEnv({ [SANDBOX_MODE_ENV]: 'docker' });
    expect(cfg.dockerImage).toBe(DEFAULT_DOCKER_IMAGE);
  });

  it('is off by default', () => {
    expect(sandboxConfigFromEnv({}).mode).toBe('off');
  });
});

describe('describeSandbox', () => {
  it('summarizes each mode', () => {
    expect(describeSandbox({ mode: 'off', dockerImage: 'x' })).toMatch(/sandbox=off/);
    expect(describeSandbox({ mode: 'docker', dockerImage: 'img' })).toMatch(/network disabled/);
    expect(describeSandbox({ mode: 'bubblewrap', dockerImage: 'x' })).toMatch(/read-only/);
  });
});
