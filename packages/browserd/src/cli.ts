#!/usr/bin/env node
import { BrowserdServer } from './server.js';

// browserd entrypoint: `browser/*` JSON-RPC over stdio. Logs go to stderr so
// the NDJSON frame stream on stdout stays clean.
//
// Configuration (environment):
//   SUNDAY_WORKSPACE_ROOT              workspace root (profile dir hashing)
//   SUNDAY_BROWSER_APPROVED_DOMAINS    comma-separated user-approved domains
//   SUNDAY_BROWSER_ALLOW_EVAL=1        enable the restricted browser/eval
//   SUNDAY_BROWSER_HEADLESS=0          run headed (default headless)

function parseDomains(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const server = new BrowserdServer({
  workspaceRoot: process.env.SUNDAY_WORKSPACE_ROOT || undefined,
  approvedDomains: parseDomains(process.env.SUNDAY_BROWSER_APPROVED_DOMAINS),
  allowEval: process.env.SUNDAY_BROWSER_ALLOW_EVAL === '1',
  headless: process.env.SUNDAY_BROWSER_HEADLESS !== '0',
});
server.start();
