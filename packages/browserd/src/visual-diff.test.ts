// F11 visual diff — unit tests with seeded UI bugs.
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { drawRect, solidPng, visualDiff } from './visual-diff.js';

describe('visualDiff', () => {
  it('reports zero diff for identical screenshots', () => {
    const a = solidPng(64, 48, 255, 255, 255);
    const b = solidPng(64, 48, 255, 255, 255);
    const d = visualDiff(a, b);
    expect(d.width).toBe(64);
    expect(d.height).toBe(48);
    expect(d.diffPixels).toBe(0);
    expect(d.totalPixels).toBe(64 * 48);
    expect(d.diffRatio).toBe(0);
    // diff PNG itself is a valid PNG of the same size
    const out = PNG.sync.read(d.diffPng);
    expect(out.width).toBe(64);
    expect(out.height).toBe(48);
  });

  it('detects a single changed pixel', () => {
    const a = solidPng(32, 32, 255, 255, 255);
    const img = PNG.sync.read(a);
    img.data[0] = 0; // one black pixel
    const b: Buffer = PNG.sync.write(img);
    const d = visualDiff(a, b);
    expect(d.diffPixels).toBe(1);
    expect(d.diffRatio).toBeCloseTo(1 / 1024, 6);
  });

  it('seeded UI bug: misaligned button produces a localized diff', () => {
    // "Before": button rect at x=20. "After": same button shifted to x=60.
    const bg = solidPng(200, 100, 240, 240, 240);
    const before = drawRect(bg, 20, 30, 80, 24, 245, 185, 66); // Sunday yellow button
    const after = drawRect(bg, 60, 30, 80, 24, 245, 185, 66);
    const d = visualDiff(before, after);
    expect(d.diffPixels).toBeGreaterThan(0);
    // Only the two button footprints differ: left strip (20..60) + right strip (100..140)
    // each 40 wide × 24 tall → 2*40*24 = 1920 changed pixels.
    expect(d.diffPixels).toBe(2 * 40 * 24);
    expect(d.diffRatio).toBeCloseTo(1920 / 20000, 6);
  });

  it('threshold=1 ignores tiny anti-aliasing-style shifts', () => {
    const a = solidPng(16, 16, 100, 100, 100);
    const img = PNG.sync.read(a);
    img.data[0] = 101; // 1-step change
    img.data[1] = 101;
    img.data[2] = 101;
    const b: Buffer = PNG.sync.write(img);
    const strict = visualDiff(a, b, 0);
    const loose = visualDiff(a, b, 1);
    expect(strict.diffPixels).toBe(1);
    expect(loose.diffPixels).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    const a = solidPng(32, 32, 0, 0, 0);
    const b = solidPng(64, 32, 0, 0, 0);
    expect(() => visualDiff(a, b)).toThrow(/dimension mismatch/);
  });

  it('throws on undecodable input', () => {
    const good = solidPng(8, 8, 0, 0, 0);
    expect(() => visualDiff(Buffer.from('not-a-png'), good)).toThrow(/could not decode beforePng/);
    expect(() => visualDiff(good, Buffer.from('not-a-png'))).toThrow(/could not decode afterPng/);
  });
});
