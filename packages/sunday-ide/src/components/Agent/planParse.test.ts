import { describe, expect, it } from 'vitest';
import { parsePlanFromText } from './planParse';

describe('parsePlanFromText', () => {
  it('extracts a markdown task list with done states', () => {
    const text = [
      'Here is what I will do:',
      '',
      '- [x] Read the failing test',
      '- [ ] Fix the parser',
      '- [ ] Run the suite',
      '',
      'Starting now.',
    ].join('\n');
    const plan = parsePlanFromText(text);
    expect(plan).not.toBeNull();
    expect(plan?.steps).toEqual([
      { text: 'Read the failing test', done: true },
      { text: 'Fix the parser', done: false },
      { text: 'Run the suite', done: false },
    ]);
    expect(plan?.rest).toContain('Here is what I will do:');
    expect(plan?.rest).toContain('Starting now.');
    expect(plan?.rest).not.toContain('Fix the parser');
  });

  it('extracts a numbered plan under a Plan heading', () => {
    const text = [
      '## Plan',
      '1. Inspect the repo layout',
      '2. Add the IPC handler',
      '3. Wire the renderer',
      '4. Run typecheck',
      '',
      'Notes: this touches three files.',
    ].join('\n');
    const plan = parsePlanFromText(text);
    expect(plan?.steps.map((s) => s.text)).toEqual([
      'Inspect the repo layout',
      'Add the IPC handler',
      'Wire the renderer',
      'Run typecheck',
    ]);
    expect(plan?.steps.every((s) => !s.done)).toBe(true);
    expect(plan?.rest).toContain('Notes: this touches three files.');
  });

  it('extracts a bulleted plan under a bold Plan: line', () => {
    const text = ['**Plan:**', '- Step one', '- Step two', '- Step three'].join('\n');
    const plan = parsePlanFromText(text);
    expect(plan?.steps).toHaveLength(3);
  });

  it('returns null for ordinary prose', () => {
    expect(parsePlanFromText('The function returns early when the input is empty.')).toBeNull();
    expect(parsePlanFromText('- just one bullet\n- and a grocery list\n- eggs, milk')).toBeNull();
  });

  it('returns null for a single task item', () => {
    expect(parsePlanFromText('- [ ] only one thing')).toBeNull();
  });

  it('caps the number of steps', () => {
    const many = Array.from({ length: 40 }, (_, i) => `- [ ] step ${i}`).join('\n');
    const plan = parsePlanFromText(many);
    expect(plan?.steps.length).toBeLessThanOrEqual(20);
  });
});
