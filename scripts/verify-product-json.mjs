#!/usr/bin/env node
// scripts/verify-product-json.mjs
//
// Permanent guard for vscode/product.json critical keys.
//
// Incident: commit dd29d944 ("IDE: remove defaultChatAgent") deleted the ENTIRE
// `defaultChatAgent` block (69 lines) from vscode/product.json. The build stayed
// green and the packaged IDE opened to a black/loading screen on every machine
// (Beta.1/Beta.2/Beta.3, incl. an extension-free Beta.4 diagnostic). The cause was
// only found after the user re-tested repeatedly and issued a 100%-or-dissatisfied
// ultimatum. The fix (4730690f) restored the exact original block.
//
// This script fails the IDE build in seconds if a future cleanup deletes or
// corrupts any critical product.json key, instead of shipping another black
// screen. Run it as the FIRST step of the build-ide job (see sunday-ide.yml).
//
// Rules:
//   - vscode/product.json must parse as JSON.
//   - Every REQUIRED_TOP_LEVEL key must exist.
//   - defaultChatAgent must be an object containing every REQUIRED_CHAT_AGENT key.
//     (Deletions fail; ADDITIONS are allowed so product.json can still evolve.)
//   - String-valued critical keys must be non-empty strings.
//
// If product.json legitimately changes shape, update the lists below IN THE SAME
// COMMIT so the diff shows reviewers exactly what moved.
//
// Usage: node scripts/verify-product-json.mjs [path/to/product.json]
//   Defaults to <repo-root>/vscode/product.json. Exits 0 on pass, 1 on failure.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Top-level keys the desktop IDE build / runtime cannot live without.
// (Branding identity, OS installer identity, protocol handler, extension gallery.)
const REQUIRED_TOP_LEVEL = [
  'nameShort',
  'nameLong',
  'applicationName',
  'dataFolderName',
  'darwinBundleIdentifier',
  'urlProtocol',
  'win32AppUserModelId',
  'win32DirName',
  'win32MutexName',
  'win32x64AppId',
  'win32x64UserAppId',
  'win32arm64AppId',
  'win32arm64UserAppId',
  'extensionsGallery',
  'licenseName',
  'reportIssueUrl',
  'defaultChatAgent',
];

// Sub-keys of defaultChatAgent that MUST be present. This is the exact set
// restored by the black-screen fix (commit 4730690f); deleting any of them
// risks breaking workbench initialization again.
const REQUIRED_CHAT_AGENT = [
  'extensionId',
  'chatExtensionId',
  'chatExtensionOutputId',
  'chatExtensionOutputExtensionStateCommand',
  'documentationUrl',
  'termsStatementUrl',
  'privacyStatementUrl',
  'skusDocumentationUrl',
  'optimizeUsageDocumentationUrl',
  'publicCodeMatchesUrl',
  'managePlanUrl',
  'upgradePlanUrl',
  'signUpUrl',
  'provider',
  'providerExtensionId',
  'providerUriSetting',
  'providerScopes',
  'entitlementUrl',
  'entitlementSignupLimitedUrl',
  'chatQuotaExceededContext',
  'completionsQuotaExceededContext',
  'walkthroughCommand',
  'completionsMenuCommand',
  'chatRefreshTokenCommand',
  'generateCommitMessageCommand',
  'resolveMergeConflictsCommand',
  'completionsAdvancedSetting',
  'completionsEnablementSetting',
  'nextEditSuggestionsSetting',
  'tokenEntitlementUrl',
  'mcpRegistryDataUrl',
  'mcpConnectorsUrl',
  'managedSettingsUrl',
];

function fail(errors) {
  console.error('verify-product-json: FAILED');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  console.error('Refusing to build: a broken product.json ships a black-screen IDE.');
  console.error('See incident dd29d944 -> fix 4730690f. If this change is intentional,');
  console.error('update REQUIRED_TOP_LEVEL / REQUIRED_CHAT_AGENT in scripts/verify-product-json.mjs');
  console.error('in the same commit.');
  process.exit(1);
}

function main() {
  const target = resolve(process.argv[2] || `${REPO_ROOT}/vscode/product.json`);
  const errors = [];

  let raw;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (err) {
    fail([`cannot read ${target}: ${err.message}`]);
  }

  let product;
  try {
    product = JSON.parse(raw);
  } catch (err) {
    fail([`${target} is not valid JSON: ${err.message}`]);
  }

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in product)) {
      errors.push(`missing top-level key "${key}"`);
    }
  }

  const stringKeys = ['nameShort', 'nameLong', 'applicationName', 'dataFolderName'];
  for (const key of stringKeys) {
    if (key in product && (typeof product[key] !== 'string' || product[key].length === 0)) {
      errors.push(`top-level key "${key}" must be a non-empty string`);
    }
  }

  if ('defaultChatAgent' in product) {
    const dca = product.defaultChatAgent;
    if (dca === null || typeof dca !== 'object' || Array.isArray(dca)) {
      errors.push('"defaultChatAgent" must be an object');
    } else {
      for (const key of REQUIRED_CHAT_AGENT) {
        if (!(key in dca)) {
          errors.push(`missing defaultChatAgent sub-key "${key}"`);
        }
      }
      if (!dca.extensionId || typeof dca.extensionId !== 'string') {
        errors.push('"defaultChatAgent.extensionId" must be a non-empty string');
      }
    }
  }

  if (errors.length > 0) fail(errors);

  console.log(
    `verify-product-json: OK — ${REQUIRED_TOP_LEVEL.length} top-level keys, ` +
    `defaultChatAgent with ${REQUIRED_CHAT_AGENT.length} required sub-keys (+${Object.keys(product.defaultChatAgent).length - REQUIRED_CHAT_AGENT.length} extra)`
  );
}

main();
