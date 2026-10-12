/**
 * Single source of truth for the Sunday gateway URL.
 *
 * All modules must import DEFAULT_GATEWAY_URL from here — do NOT define
 * local copies (see Phase 4 P1 fix: 3 duplicated constants consolidated).
 */

/** Baked-in default gateway URL when no config/env override is set. */
export const DEFAULT_GATEWAY_URL = 'https://sunday-final-ide.onrender.com';
