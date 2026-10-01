// Image paste helpers for the chat composer. Framework-free; canvas use is
// guarded so the module imports safely in headless test environments (no
// document → downscaling is a no-op that returns the original data URL).

/** Wire shape of an image attachment (webview → extension). */
export interface ImageWire {
  dataUrl: string;
  name?: string;
}

/** Max side length after downscaling; larger images are shrunk to fit. */
export const MAX_IMAGE_DIM = 1568;
/** JPEG quality used when re-encoding a downscaled image. */
export const JPEG_QUALITY = 0.85;

export interface AttachedImage {
  id: string;
  name: string;
  dataUrl: string;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `img-${Date.now().toString(36)}-${idCounter}`;
}

export function makeAttachment(name: string, dataUrl: string): AttachedImage {
  return { id: nextId(), name: name || 'pasted image', dataUrl };
}

/** Read a pasted image File as a data: URL. */
export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const reader = new FileReader();
    reader.onload = () => resolvePromise(String(reader.result));
    reader.onerror = () => rejectPromise(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolvePromise, rejectPromise) => {
    const img = new Image();
    img.onload = () => resolvePromise(img);
    img.onerror = () => rejectPromise(new Error('could not decode image'));
    img.src = dataUrl;
  });
}

/**
 * Downscale a data-URL image so its longest side is ≤ MAX_IMAGE_DIM,
 * re-encoded as JPEG at JPEG_QUALITY. Returns the original data URL when:
 * the image is already small enough, the DOM/canvas APIs are unavailable
 * (headless tests), or anything fails (never break a paste).
 */
export async function maybeDownscaleImage(dataUrl: string): Promise<string> {
  try {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return dataUrl;
    const img = await loadImage(dataUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h || Math.max(w, h) <= MAX_IMAGE_DIM) return dataUrl;
    const scale = MAX_IMAGE_DIM / Math.max(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch {
    return dataUrl;
  }
}

/** Shape sent to the extension on `sunday/chat/send`. */
export function toWireAttachments(images: AttachedImage[]): ImageWire[] {
  return images.map((i) => ({ name: i.name, dataUrl: i.dataUrl }));
}
