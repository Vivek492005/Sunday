/**
 * @sunday/protocol — secret detection + redaction primitives.
 *
 * Moved here (from @sunday/skills) so every package — including ext-agent,
 * which does not depend on @sunday/skills — can redact secrets from outbound
 * prompts (S6). @sunday/skills re-exports these for backward compatibility.
 *
 * Labels are safe to surface; the matched text never is.
 */

export interface SecretPattern {
  label: string;
  re: RegExp;
  /**
   * When true the pattern only matches the *label* of an assignment
   * (`password=`, `api_key:` …) — redaction then also swallows the value
   * that follows it.
   */
  includeValue?: boolean;
}

/** Thrown by `assertNoSecrets` when the text looks like it contains a secret. */
export class SecretRefusedError extends Error {
  /** The label of the secret pattern that matched (never the secret itself). */
  readonly pattern: string;

  constructor(pattern: string) {
    super(
      `Refusing to remember: text matches secret pattern "${pattern}". ` +
        'Memory must never store credentials or secrets.',
    );
    this.name = 'SecretRefusedError';
    this.pattern = pattern;
  }
}

/**
 * Common secret shapes. Labels are safe to surface; the matched text never is.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  { label: 'openai-key', re: /\bsk-[A-Za-z0-9]{8,}\b/ },
  { label: 'openai-proj-key', re: /\bsk-proj-[A-Za-z0-9_-]{8,}\b/ },
  { label: 'github-pat', re: /\bghp_[A-Za-z0-9]{8,}\b/ },
  { label: 'github-oauth', re: /\bgho_[A-Za-z0-9]{8,}\b/ },
  { label: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{8,}\b/ },
  { label: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'aws-secret-key', re: /\baws_secret_access_key\s*[:=]/i, includeValue: true },
  { label: 'private-key-block', re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'password-assignment', re: /\bpassword\s*[:=]/i, includeValue: true },
  { label: 'passwd-assignment', re: /\bpasswd\s*[:=]/i, includeValue: true },
  { label: 'secret-assignment', re: /\bclient_secret\s*[:=]/i, includeValue: true },
  { label: 'api-key-assignment', re: /\bapi[_-]?key\s*[:=]/i, includeValue: true },
  { label: 'bearer-token', re: /\bbearer\s+[A-Za-z0-9\-._~+/]{16,}={0,3}\b/i },
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/ },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z\-_]{20,}\b/ },
  { label: 'generic-token-assignment', re: /\btoken\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]{16,}["']?/i },
  { label: 'groq-key', re: /\bgsk_[A-Za-z0-9]{8,}\b/ },
  { label: 'openrouter-key', re: /\bsk-or-v1-[A-Za-z0-9]{8,}\b/ },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { label: 'sunday-env', re: /SUNDAY_[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\s*[:=]/i, includeValue: true },
  { label: 'groq-env', re: /GROQ_[A-Z0-9_]*(?:TOKEN|KEY|SECRET)\s*[:=]/i, includeValue: true },
  { label: 'openrouter-env', re: /OPENROUTER_[A-Z0-9_]*(?:TOKEN|KEY|SECRET)\s*[:=]/i, includeValue: true },
  { label: 'high-entropy-assignment', re: /\b[A-Za-z0-9_.-]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_.-]*\s*[:=]\s*["']?[A-Za-z0-9\-._~+/=]{20,}["']?/i, includeValue: true },
];

/** Throw `SecretRefusedError` when `text` matches any known secret pattern. */
export function assertNoSecrets(text: string): void {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) throw new SecretRefusedError(p.label);
  }
}

/** Replacement marker used by {@link redactSecrets} — the label, never the value. */
export function redactionMarker(label: string): string {
  return `[REDACTED:${label}]`;
}

/** A full PEM private-key block (header … footer), redacted as one unit. */
const PEM_BLOCK_RE =
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g;

/** Value tail appended to label-only assignment patterns during redaction. */
const ASSIGNMENT_VALUE_SUFFIX = '\\s*["\']?[^\\s"\']+["\']?';

function withGlobalFlags(re: RegExp): string {
  return re.flags.includes('g') ? re.flags : `${re.flags}g`;
}

/**
 * Redact every known secret shape in `text` (§15.4 "Secrets leakage to model
 * providers"). Each match is replaced with `[REDACTED:<label>]` — the label
 * is safe to surface (it names the pattern, not the value). Assignment-style
 * patterns (`password=…`) redact the value too, and PEM blocks are redacted
 * whole. Use before tool results, errors, or log lines reach a prompt or a
 * log sink.
 */
export function redactSecrets(text: string): string {
  let out = text.replace(PEM_BLOCK_RE, () => redactionMarker('private-key-block'));
  for (const p of SECRET_PATTERNS) {
    const source = p.includeValue === true ? `${p.re.source}${ASSIGNMENT_VALUE_SUFFIX}` : p.re.source;
    out = out.replace(new RegExp(source, withGlobalFlags(p.re)), () =>
      redactionMarker(p.label),
    );
  }
  return out;
}
