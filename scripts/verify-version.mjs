#!/usr/bin/env node
// scripts/verify-version.mjs
//
// Guard against the Beta.4/Beta.5 version incident: CI artifacts were
// internally versioned 1.0.0-beta.3 while being released as beta.4/beta.5
// (filenames renamed at upload time). This broke version detection and
// auto-update.
//
// This script verifies that packages/ext-agent/package.json `version`
// matches the version being built/released.
//
// Usage:
//   node scripts/verify-version.mjs [expected-version]
//   EXPECTED_VERSION env var is used if no arg is given.
//   If neither is provided, just prints the current version (exit 0).
//
// CI usage (add to sunday-ide.yml build job):
//   - name: Verify package version matches release
//     run: node scripts/verify-version.mjs "$SUNDAY_VERSION"
//     # (after the "Read Sunday version" step sets SUNDAY_VERSION)
//

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkgPath = resolve(REPO_ROOT, 'packages/ext-agent/package.json');
let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (err) {
  console.error(`verify-version: FAILED — cannot read ${pkgPath}: ${err.message}`);
  process.exit(1);
}

const actual = pkg.version;
if (typeof actual !== 'string' || !actual) {
  console.error('verify-version: FAILED — packages/ext-agent/package.json has no version');
  process.exit(1);
}

const expected = process.argv[2] || process.env.EXPECTED_VERSION || '';
if (!expected) {
  console.log(`verify-version: current version is ${actual} (no expected version given, OK)`);
  process.exit(0);
}

// Normalize: strip leading 'v', allow 'ide-v1.0.0-beta.5' tag format
const normalize = (v) =>
  v
    .trim()
    .replace(/^ide-v/i, '')
    .replace(/^v/i, '');

if (normalize(actual) !== normalize(expected)) {
  console.error(`verify-version: FAILED — package.json version "${actual}" != expected "${expected}"`);
  console.error('  Fix: bump "version" in packages/ext-agent/package.json before building.');
  process.exit(1);
}

console.log(`verify-version: OK — version ${actual} matches expected ${expected}`);
