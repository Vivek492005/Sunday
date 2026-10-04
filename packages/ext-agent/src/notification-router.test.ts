import { describe, expect, it } from 'vitest';
import {
  isForThisWindow,
  parseNotificationLevel,
  shouldSurfaceNotification,
} from './notification-router.js';

describe('parseNotificationLevel', () => {
  it('defaults to all', () => {
    expect(parseNotificationLevel(undefined)).toBe('all');
    expect(parseNotificationLevel('bogus')).toBe('all');
    expect(parseNotificationLevel('all')).toBe('all');
  });

  it('parses important/none', () => {
    expect(parseNotificationLevel('important')).toBe('important');
    expect(parseNotificationLevel('none')).toBe('none');
  });
});

describe('shouldSurfaceNotification', () => {
  const textDelta = { method: 'chat/event', params: { event: { type: 'text-delta' } } };
  const turnError = { method: 'chat/event', params: { event: { type: 'turn-error' } } };
  const relay = {
    method: 'chat/event',
    params: { event: { type: 'text-delta' }, via: 'relay' },
  };

  it('all surfaces everything', () => {
    expect(shouldSurfaceNotification(textDelta, 'all')).toBe(true);
    expect(shouldSurfaceNotification(turnError, 'all')).toBe(true);
  });

  it('none suppresses everything', () => {
    expect(shouldSurfaceNotification(textDelta, 'none')).toBe(false);
    expect(shouldSurfaceNotification(turnError, 'none')).toBe(false);
    expect(shouldSurfaceNotification(relay, 'none')).toBe(false);
  });

  it('important surfaces errors and relays only', () => {
    expect(shouldSurfaceNotification(textDelta, 'important')).toBe(false);
    expect(shouldSurfaceNotification(turnError, 'important')).toBe(true);
    expect(shouldSurfaceNotification(relay, 'important')).toBe(true);
  });
});

describe('isForThisWindow', () => {
  it('fail-open when the daemon did not stamp a workspace', () => {
    expect(isForThisWindow(undefined, ['/home/u/proj'])).toBe(true);
  });

  it('matches the workspace itself and nested children', () => {
    expect(isForThisWindow('/home/u/proj', ['/home/u/proj'])).toBe(true);
    expect(isForThisWindow('/home/u/proj/sub', ['/home/u/proj'])).toBe(true);
  });

  it('rejects other workspaces and prefix collisions', () => {
    expect(isForThisWindow('/home/u/other', ['/home/u/proj'])).toBe(false);
    expect(isForThisWindow('/home/u/proj2', ['/home/u/proj'])).toBe(false);
  });

  it('is case- and separator-insensitive', () => {
    expect(isForThisWindow('C:\\Users\\u\\proj', ['c:/users/u/proj'])).toBe(true);
  });
});
