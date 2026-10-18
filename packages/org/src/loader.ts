/**
 * @sunday/org — F15: loader.
 *
 * Loads `sunday-org.json` from disk, validates it, and verifies the ed25519
 * signature against a trusted public key. Unsigned or tampered bundles are
 * rejected by default — the whole point of the org bundle is that members
 * can trust it came from their admin.
 *
 * Trusted keys resolve in this order:
 *   1. explicit `publicKey` option
 *   2. `SUNDAY_ORG_PUBLIC_KEY` env (PEM text)
 *   3. `~/.sunday/org-keys/<keyId>.pem` (keyId from the bundle signature)
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseOrgBundle, type OrgBundle } from './schema.js';
import { OrgSignatureError, verifyOrgBundle } from './signing.js';

export interface LoadOrgPolicyOptions {
  /** Trusted PEM public key. Overrides env + key-dir lookup. */
  publicKey?: string;
  /** Allow bundles with no signature block (dev only — never in prod). */
  allowUnsigned?: boolean;
  /** Override home dir for the org-keys lookup (tests). */
  homeDir?: string;
}

export interface LoadedOrgPolicy {
  bundle: OrgBundle;
  /** The keyId whose public key verified this bundle. */
  verifiedKeyId: string | null;
  /** Where the bundle was loaded from. */
  path: string;
}

export class OrgLoadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OrgLoadError';
    this.code = code;
  }
}

function publicKeyFromEnv(): string | null {
  const pem = process.env.SUNDAY_ORG_PUBLIC_KEY;
  return pem && pem.includes('BEGIN PUBLIC KEY') ? pem : null;
}

function publicKeyFromDir(keyId: string, homeDir: string): string | null {
  const p = join(homeDir, '.sunday', 'org-keys', `${keyId}.pem`);
  if (!existsSync(p)) return null;
  const pem = readFileSync(p, 'utf8');
  return pem.includes('BEGIN PUBLIC KEY') ? pem : null;
}

/**
 * Load + validate + verify a sunday-org.json bundle.
 * Throws OrgLoadError on IO/parse problems, OrgSignatureError on
 * signature problems.
 */
export function loadOrgPolicy(bundlePath: string, opts: LoadOrgPolicyOptions = {}): LoadedOrgPolicy {
  let raw: string;
  try {
    raw = readFileSync(bundlePath, 'utf8');
  } catch (e) {
    throw new OrgLoadError('ORG_NOT_FOUND', `cannot read org bundle at ${bundlePath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new OrgLoadError('ORG_BAD_JSON', `org bundle is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Unsigned bundles: only when the caller explicitly opts in.
  const hasSignature =
    typeof json === 'object' && json !== null && 'signature' in (json as Record<string, unknown>);
  const bundle = parseOrgBundle(json);
  if (!hasSignature || !bundle.signature) {
    if (!opts.allowUnsigned) {
      throw new OrgSignatureError('org bundle has no signature — refusing to load unsigned policy');
    }
    return { bundle, verifiedKeyId: null, path: bundlePath };
  }
  const homeDir = opts.homeDir ?? homedir();

  const publicKey =
    opts.publicKey ??
    publicKeyFromEnv() ??
    publicKeyFromDir(bundle.signature.keyId, homeDir);

  if (!publicKey) {
    throw new OrgSignatureError(
      `no trusted public key for keyId "${bundle.signature.keyId}" — set SUNDAY_ORG_PUBLIC_KEY or place the PEM at ~/.sunday/org-keys/${bundle.signature.keyId}.pem`,
    );
  }

  verifyOrgBundle(bundle, publicKey);
  return { bundle, verifiedKeyId: bundle.signature.keyId, path: bundlePath };
}

/** Convenience: find the org bundle for a workspace (walks up for sunday-org.json). */
export function findOrgBundle(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, 'sunday-org.json');
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}
