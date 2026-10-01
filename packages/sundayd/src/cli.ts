#!/usr/bin/env node
import { SundayDaemon } from './daemon.js';

// sundayd entrypoint: JSON-RPC over stdio. Logs go to stderr so the NDJSON
// frame stream on stdout stays clean.
const daemon = new SundayDaemon();
daemon.start().catch((e) => {
  console.error(`sundayd failed to start: ${(e as Error).message}`);
  process.exit(1);
});
