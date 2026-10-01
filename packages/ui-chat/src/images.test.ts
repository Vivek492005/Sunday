// Unit tests for image paste helpers. No DOM here, so the downscale path is
// the headless guard: it must return the input data URL untouched.
import { describe, expect, it } from 'vitest';
import {
  JPEG_QUALITY,
  MAX_IMAGE_DIM,
  makeAttachment,
  maybeDownscaleImage,
  toWireAttachments,
} from './images.js';

describe('images', () => {
  it('exposes the downscale policy constants', () => {
    expect(MAX_IMAGE_DIM).toBe(1568);
    expect(JPEG_QUALITY).toBe(0.85);
  });

  it('maybeDownscaleImage returns the input unchanged without a DOM', async () => {
    const url = 'data:image/png;base64,iVBORw0KGgo';
    await expect(maybeDownscaleImage(url)).resolves.toBe(url);
  });

  it('makeAttachment assigns ids and keeps name/dataUrl', () => {
    const a = makeAttachment('shot.png', 'data:image/png;base64,AAA');
    const b = makeAttachment('shot.png', 'data:image/png;base64,AAA');
    expect(a.id).not.toBe(b.id);
    expect(a.name).toBe('shot.png');
    expect(a.dataUrl).toBe('data:image/png;base64,AAA');
  });

  it('toWireAttachments maps to the wire shape', () => {
    const out = toWireAttachments([makeAttachment('a.png', 'data:image/png;base64,AAA')]);
    expect(out).toEqual([{ name: 'a.png', dataUrl: 'data:image/png;base64,AAA' }]);
  });
});
