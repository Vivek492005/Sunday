#!/usr/bin/env node
/**
 * gen-sbom.mjs — generate docs/sbom.json (CycloneDX 1.5) from pnpm-lock.yaml.
 *
 * Parses the lockfile WITHOUT any YAML dependency (a minimal line-based
 * parser targeting pnpm lockfileVersion 9's `packages:` section) and without
 * running `pnpm install`. Reproducible: `node scripts/gen-sbom.mjs
 * [lockfile] [out]`.
 *
 * Usage:
 *   node scripts/gen-sbom.mjs                    # pnpm-lock.yaml -> docs/sbom.json
 *   node scripts/gen-sbom.mjs pnpm-lock.yaml /tmp/sbom.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const lockPath = resolve(process.cwd(), process.argv[2] ?? join(root, 'pnpm-lock.yaml'));
const outPath = resolve(process.cwd(), process.argv[3] ?? join(root, 'docs', 'sbom.json'));

const text = readFileSync(lockPath, 'utf8');
const lockVersion = (text.match(/^lockfileVersion:\s*'([^']+)'/m) ?? [])[1] ?? 'unknown';
if (!lockVersion.startsWith('9.')) {
  console.warn(`warning: expected pnpm lockfileVersion 9.x, found ${lockVersion}; parse may be off`);
}

/**
 * Minimal parse of the top-level `packages:` section.
 * Entry keys look like `'name@version'` or `'@scope/name@version(peer@x)'`.
 */
function parsePackages(src) {
  const lines = src.split('\n');
  const entries = [];
  let inPackages = false;
  let current = null;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^[^ ]/.test(line)) break; // next top-level section
    if (!inPackages) continue;
    // Entry keys are quoted only when they need it (scoped names etc.):
    //   '@scope/name@1.2.3':        or        zod@3.25.76:
    const keyMatch = line.match(/^  (?:(['"])(.+?)\1|([A-Za-z0-9@][^:]*)):\s*$/);
    if (keyMatch) {
      current = { key: keyMatch[2] ?? keyMatch[3], integrity: null };
      entries.push(current);
      continue;
    }
    if (current) {
      const integ = line.match(/resolution:\s*\{integrity:\s*([^}\s]+)\s*\}/);
      if (integ) current.integrity = integ[1];
    }
  }
  return entries;
}

/** Split `name@version(peer…)` into {name, version}. */
function splitNameVersion(key) {
  const noPeers = key.replace(/\(.*\)$/, '');
  const at = noPeers.lastIndexOf('@');
  if (at <= 0) return { name: noPeers, version: 'unknown' };
  return { name: noPeers.slice(0, at), version: noPeers.slice(at + 1) };
}

function purl(name, version) {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

function hashes(integrity) {
  if (!integrity) return undefined;
  const m = integrity.match(/^(sha512|sha384|sha256|sha1)-(.+)$/);
  if (!m) return undefined;
  const alg = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[m[1]];
  return [{ alg, content: m[2] }];
}

const entries = parsePackages(text);
const seen = new Set();
const components = [];
for (const e of entries) {
  const { name, version } = splitNameVersion(e.key);
  const ref = purl(name, version);
  if (seen.has(ref)) continue;
  seen.add(ref);
  const component = { type: 'library', 'bom-ref': ref, name, version, purl: ref };
  const h = hashes(e.integrity);
  if (h) component.hashes = h;
  components.push(component);
}
components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

let rootVersion = '0.0.0';
try {
  rootVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? rootVersion;
} catch {
  /* keep default */
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'Sunday', name: 'scripts/gen-sbom.mjs', version: '1.0.0' }],
    component: {
      type: 'application',
      'bom-ref': 'pkg:npm/sunday@' + rootVersion,
      name: 'sunday',
      version: rootVersion,
    },
  },
  components,
};

writeFileSync(outPath, JSON.stringify(sbom, null, 2) + '\n');
console.log(`wrote ${outPath}: ${components.length} components (lockfile ${lockVersion})`);
