// @sunday/browserd — F11 visual diff (before/after screenshot pixel comparison).
//
// Pure image computation: decode two PNGs with pngjs, compare with pixelmatch,
// emit a highlighted diff PNG. No browser needed — the server calls this with
// screenshot bytes captured before/after a UI fix.

import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface VisualDiffResult {
  width: number;
  height: number;
  diffPixels: number;
  totalPixels: number;
  /** diffPixels / totalPixels, 0..1. */
  diffRatio: number;
  /** Highlighted diff PNG bytes (red = changed pixels). */
  diffPng: Buffer;
}

/**
 * Compare two PNG screenshots pixel-by-pixel.
 *
 * @throws when either buffer is not a decodable PNG, or the dimensions differ
 * (a size change is itself a layout signal — the caller should re-capture at
 * a fixed viewport instead of silently scaling).
 */
export function visualDiff(beforePng: Buffer, afterPng: Buffer, threshold = 0.1): VisualDiffResult {
  let img1: PNG;
  let img2: PNG;
  try {
    img1 = PNG.sync.read(beforePng);
  } catch (e) {
    throw new Error(`visual_diff: could not decode beforePng: ${(e as Error).message}`);
  }
  try {
    img2 = PNG.sync.read(afterPng);
  } catch (e) {
    throw new Error(`visual_diff: could not decode afterPng: ${(e as Error).message}`);
  }
  if (img1.width !== img2.width || img1.height !== img2.height) {
    throw new Error(
      `visual_diff: dimension mismatch ${img1.width}x${img1.height} vs ${img2.width}x${img2.height} — re-capture both at the same viewport`,
    );
  }
  const { width, height } = img1;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold });
  const totalPixels = width * height;
  return {
    width,
    height,
    diffPixels,
    totalPixels,
    diffRatio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    diffPng: PNG.sync.write(diff),
  };
}

/** Build a solid-color PNG (test helper / seeded-bug fixtures). */
export function solidPng(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

/**
 * Draw a filled rectangle into a PNG buffer (test helper — simulates a UI
 * element such as a button at a given position).
 */
export function drawRect(
  pngBuf: Buffer,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
): Buffer {
  const img = PNG.sync.read(pngBuf);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const i = (py * img.width + px) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}
