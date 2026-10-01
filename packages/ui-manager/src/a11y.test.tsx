// A11y assertions for the manager webview (renderToStaticMarkup-based; no
// jsdom in devDependencies and no new test deps allowed).
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { App, unitCardKeyDown } from './App.js';

describe('manager inputs', () => {
  it('labels every text input (placeholders alone are not labels)', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('aria-label="Checkpoint label"');
    expect(html).toContain('aria-label="Worktree branch name"');
    expect(html).toContain('aria-label="Worktree path"');
  });

  it('renders labelled section landmarks for orchestration, agents, checkpoints, worktrees', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('Orchestration (0)');
    expect(html).toContain('Agents (0)');
    expect(html).toContain('Checkpoints (0)');
    expect(html).toContain('Worktrees (0)');
  });
});

describe('unitCardKeyDown', () => {
  const keyEvent = (key: string) => ({ key, preventDefault: vi.fn() });

  it('toggles on Enter', () => {
    const onToggle = vi.fn();
    const e = keyEvent('Enter');
    unitCardKeyDown(e, onToggle);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('toggles on Space', () => {
    const onToggle = vi.fn();
    const e = keyEvent(' ');
    unitCardKeyDown(e, onToggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const onToggle = vi.fn();
    for (const key of ['a', 'Tab', 'ArrowDown', 'Escape']) {
      const e = keyEvent(key);
      unitCardKeyDown(e, onToggle);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(onToggle).not.toHaveBeenCalled();
  });
});
