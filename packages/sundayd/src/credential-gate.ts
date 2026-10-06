/**
 * credential-gate.ts — SEC-10: Ask-gating for credential file reads.
 *
 * Before the agent reads a file that likely contains secrets (.env, *.pem,
 * credentials.json, etc.), the read is flagged for manual approval. This is
 * defense-in-depth on top of SEC-03 (output redaction): redaction contains the
 * blast radius after the fact; gating prevents the read in the first place
 * unless the user explicitly allows it.
 */

/** Filename patterns that likely contain credentials. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)credentials?\.(json|ya?ml|toml)$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml)$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)id_rsa$/i,
  /(^|\/)id_ed25519$/i,
];

/**
 * Returns true if the given file path looks like it contains credentials
 * and should be ask-gated before reading.
 */
export function isCredentialFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return CREDENTIAL_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Decide whether reading this file needs manual approval (SEC-10).
 * Returns a reason string if gating is needed, null otherwise.
 */
export function credentialGateReason(filePath: string): string | null {
  if (!isCredentialFile(filePath)) return null;
  return (
    `Credential gate (SEC-10): '${filePath}' looks like it contains secrets. ` +
    `Manual approval required before reading.`
  );
}
