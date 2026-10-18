import { describe, expect, it, vi } from 'vitest';
import {
  toggleBreakpoint,
  getBreakpoints,
  getAllBreakpoints,
  clearBreakpoints,
  onBreakpointsChanged,
} from './debugService';

describe('debugService breakpoints', () => {
  it('toggles a breakpoint on and off', () => {
    clearBreakpoints();
    expect(toggleBreakpoint('/a/b.ts', 10)).toBe(true);
    expect(getBreakpoints('/a/b.ts')).toEqual([10]);
    expect(toggleBreakpoint('/a/b.ts', 10)).toBe(false);
    expect(getBreakpoints('/a/b.ts')).toEqual([]);
  });

  it('keeps lines sorted and per-file', () => {
    clearBreakpoints();
    toggleBreakpoint('/a/b.ts', 30);
    toggleBreakpoint('/a/b.ts', 5);
    toggleBreakpoint('/a/c.ts', 1);
    expect(getBreakpoints('/a/b.ts')).toEqual([5, 30]);
    expect(getAllBreakpoints().map((b) => b.filePath)).toEqual(['/a/b.ts', '/a/c.ts']);
  });

  it('notifies listeners on change', () => {
    clearBreakpoints();
    const cb = vi.fn();
    const off = onBreakpointsChanged(cb);
    toggleBreakpoint('/a/b.ts', 3);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    toggleBreakpoint('/a/b.ts', 4);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('clears per-file or everything', () => {
    clearBreakpoints();
    toggleBreakpoint('/a/b.ts', 1);
    toggleBreakpoint('/a/c.ts', 2);
    clearBreakpoints('/a/b.ts');
    expect(getBreakpoints('/a/b.ts')).toEqual([]);
    expect(getBreakpoints('/a/c.ts')).toEqual([2]);
    clearBreakpoints();
    expect(getAllBreakpoints()).toEqual([]);
  });
});
