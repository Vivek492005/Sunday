// sunday-agent — skills marketplace registry (D4).
//
// Pure registry parsing/validation. The registry is a JSON document:
//   { "skills": [{ "name", "description", "author", "version",
//                  "downloadUrl", "hash?" }] }
// Malformed entries are REJECTED (reported, never installed). Unknown extra
// fields (e.g. "example": true) are tolerated.

/** One validated registry entry. */
export interface RegistrySkill {
  name: string;
  description: string;
  author: string;
  version: string;
  downloadUrl: string;
  /** Optional integrity pin, "sha256:<hex>". */
  hash?: string;
}

export interface RejectedEntry {
  index: number;
  reason: string;
}

export interface ParsedRegistry {
  skills: RegistrySkill[];
  rejected: RejectedEntry[];
}

/** Skill-name allowlist: lowercase alphanumerics + dash, 1–64 chars. */
const NAME_RE = /^[a-z0-9-]{1,64}$/;
/** Loose semver: 1.2.3, optionally with prerelease/build. */
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
/** "sha256:<64 hex chars>". */
const HASH_RE = /^sha256:[0-9a-fA-F]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
}

/**
 * Sanitize a skill name for use as a directory name. Returns the name when
 * it matches the allowlist, otherwise undefined (reject — this also kills
 * path traversal: no slashes, dots, or ".." can pass).
 */
export function sanitizeSkillName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  return NAME_RE.test(name) ? name : undefined;
}

/**
 * A download URL is safe when it is an absolute HTTPS URL without embedded
 * credentials. (HTTP is rejected — skills must come over TLS.)
 */
export function isSafeDownloadUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
}

function validateEntry(raw: unknown, index: number): RegistrySkill | RejectedEntry {
  const bad = (reason: string): RejectedEntry => ({ index, reason });
  if (!isRecord(raw)) return bad('entry must be an object');
  const name = sanitizeSkillName(raw.name);
  if (!name) return bad('name must match [a-z0-9-]{1,64} (lowercase, dash-separated)');
  const description = str(raw.description, 500);
  if (!description) return bad('description must be a non-empty string (<=500 chars)');
  const author = str(raw.author, 120);
  if (!author) return bad('author must be a non-empty string (<=120 chars)');
  const version = str(raw.version, 40);
  if (!version || !VERSION_RE.test(version)) return bad('version must be semver (x.y.z)');
  if (!isSafeDownloadUrl(raw.downloadUrl)) return bad('downloadUrl must be an absolute https: URL');
  let hash: string | undefined;
  if (raw.hash !== undefined) {
    if (typeof raw.hash !== 'string' || !HASH_RE.test(raw.hash)) {
      return bad('hash must look like "sha256:<64 hex chars>"');
    }
    hash = raw.hash.toLowerCase();
  }
  return {
    name,
    description,
    author,
    version,
    downloadUrl: raw.downloadUrl as string,
    ...(hash ? { hash } : {}),
  };
}

/**
 * Parse + strictly validate a registry document. Malformed entries are
 * rejected individually (reported in `rejected`); a malformed top-level
 * shape yields zero skills and one rejection.
 */
export function parseRegistry(doc: unknown): ParsedRegistry {
  const skills: RegistrySkill[] = [];
  const rejected: RejectedEntry[] = [];
  if (!isRecord(doc) || !Array.isArray(doc.skills)) {
    rejected.push({ index: -1, reason: 'registry must be an object with a "skills" array' });
    return { skills, rejected };
  }
  const seen = new Set<string>();
  doc.skills.forEach((raw, index) => {
    const entry = validateEntry(raw, index);
    if ('reason' in entry) {
      rejected.push(entry);
      return;
    }
    if (seen.has(entry.name)) {
      rejected.push({ index, reason: `duplicate skill name "${entry.name}"` });
      return;
    }
    seen.add(entry.name);
    skills.push(entry);
  });
  return { skills, rejected };
}
