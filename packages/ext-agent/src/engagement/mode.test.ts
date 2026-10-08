// Tests for engagement/mode.ts — two-mode engagement detection.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetAgentUsedFlag,
  getEngagementMode,
  hasUsedAgentThisSession,
  isFullEngagementAllowed,
  markAgentUsed,
  parseQuietModeSetting,
} from './mode.js';

describe('two-mode engagement', () => {
  beforeEach(() => {
    __resetAgentUsedFlag();
  });

  it('starts in passive mode (auto-detect default)', () => {
    expect(hasUsedAgentThisSession()).toBe(false);
    expect(getEngagementMode('auto')).toBe('passive');
    expect(getEngagementMode()).toBe('passive');
  });

  it('flips to active after the first AI agent interaction', () => {
    markAgentUsed();
    expect(hasUsedAgentThisSession()).toBe(true);
    expect(getEngagementMode('auto')).toBe('active');
  });

  it('markAgentUsed is idempotent', () => {
    markAgentUsed();
    markAgentUsed();
    expect(getEngagementMode('auto')).toBe('active');
  });

  it('quietMode=passive forces passive even after agent use', () => {
    markAgentUsed();
    expect(getEngagementMode('passive')).toBe('passive');
  });

  it('quietMode=active forces active even with no agent use', () => {
    expect(getEngagementMode('active')).toBe('active');
  });

  it('isFullEngagementAllowed gates future quest/achievement/XP UI', () => {
    // Passive → quests/achievements/XP must stay silent.
    expect(isFullEngagementAllowed('auto')).toBe(false);
    expect(isFullEngagementAllowed('passive')).toBe(false);
    markAgentUsed();
    expect(isFullEngagementAllowed('auto')).toBe(true);
    expect(isFullEngagementAllowed('active')).toBe(true);
  });

  it('parseQuietModeSetting falls back to auto on garbage', () => {
    expect(parseQuietModeSetting('auto')).toBe('auto');
    expect(parseQuietModeSetting('passive')).toBe('passive');
    expect(parseQuietModeSetting('active')).toBe('active');
    expect(parseQuietModeSetting('LOUD')).toBe('auto');
    expect(parseQuietModeSetting(undefined)).toBe('auto');
    expect(parseQuietModeSetting(42)).toBe('auto');
  });
});
