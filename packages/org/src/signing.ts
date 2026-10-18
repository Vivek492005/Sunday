/**
 * @sunday/org — F15: signing.
 *
 * ed25519 signatures over a canonical JSON encoding of the bundle (minus the
 * signature field itself). Canonical form: object keys sorted recursively,
 * no whitespace, UTF-8. Node's built-in crypto — no new dependencies.
 *
 * IMPORTANT: signOrgBundle normalizes the unsigned input through the zod
 * schema first (defaults applied). The loader does the same on verify, so
 * the signed bytes always match what verification recomputes — even if the
 * admin omitted defaulted fields like `rules` or `hooks`.
 */

import { sign, verify, generateKeyPairSync } from 'node:crypto';
import { UnsignedOrgBundleSchema, type OrgBundle, type SignedOrgBundle, type UnsignedOrgBundle, type UnsignedOrgBundleInput } from './schema.js';

/** Deterministic JSON: recursively sorted keys, compact, UTF-8. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = canonicalize(v);
  }
  return out;
}

/** The exact bytes that get signed: canonical JSON of the unsigned bundle. */
export function bundleSignBytes(unsigned: UnsignedOrgBundle): Buffer {
  return Buffer.from(canonicalJson(unsigned), 'utf8');
}

export interface OrgKeyPair {
  /** PEM-encoded ed25519 public key (SPKI). Distribute to team members. */
  publicKey: string;
  /** PEM-encoded ed25519 private key (PKCS8). Keep with the org admin. */
  privateKey: string;
  /** Suggested keyId for the bundle signature block. */
  keyId: string;
}

/** Generate a fresh ed25519 key pair for signing org bundles. */
export function generateOrgKeyPair(keyId = 'org-key-1'): OrgKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId,
  };
}

/**
 * Sign an unsigned bundle. The input is normalized through the schema first
 * (defaults applied) so verification always recomputes identical bytes.
 * Returns the full OrgBundle with the signature block attached.
 */
export function signOrgBundle(
  unsigned: UnsignedOrgBundleInput,
  privateKeyPem: string,
  keyId: string,
): SignedOrgBundle {
  const normalized = UnsignedOrgBundleSchema.parse(unsigned);
  const sig = sign(null, bundleSignBytes(normalized), {
    key: privateKeyPem,
    format: 'pem',
  });
  return {
    ...normalized,
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: sig.toString('hex'),
    },
  };
}

/** Thrown when a bundle's signature does not verify. */
export class OrgSignatureError extends Error {
  readonly code = 'ORG_SIGNATURE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'OrgSignatureError';
  }
}

/**
 * Verify a signed bundle against a trusted PEM public key.
 * Returns true on success; throws OrgSignatureError on any failure
 * (missing signature, bad signature, malformed key, wrong key, tampered
 * contents).
 */
export function verifyOrgBundle(bundle: OrgBundle, publicKeyPem: string): true {
  const { signature, ...rest } = bundle;
  if (!signature || signature.algorithm !== 'ed25519') {
    throw new OrgSignatureError('bundle has no ed25519 signature — refusing to verify unsigned policy');
  }
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(signature.value, 'hex');
  } catch {
    throw new OrgSignatureError('signature value is not valid hex');
  }
  if (sigBytes.length !== 64) {
    throw new OrgSignatureError('signature must be 64 bytes (ed25519)');
  }
  // Re-normalize exactly like signOrgBundle did, so defaults can't be
  // exploited to change the verified bytes.
  const normalized = UnsignedOrgBundleSchema.parse(rest);
  let ok: boolean;
  try {
    ok = verify(null, bundleSignBytes(normalized), { key: publicKeyPem, format: 'pem' }, sigBytes);
  } catch (e) {
    throw new OrgSignatureError(
      `signature verification failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!ok) throw new OrgSignatureError('signature does not match bundle contents');
  return true;
}
