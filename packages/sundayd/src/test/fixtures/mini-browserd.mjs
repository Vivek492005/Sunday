// mini-browserd.mjs — hermetic fake browserd for sundayd tests.
// Speaks NDJSON JSON-RPC on stdio. No dependencies, no browser, no network.
//
// Flags:
//   --exit-after-ms N   exit with --exit-code N ms after start (crash tests)
//   --exit-code N       (default 1)
//   --silent            accept input, never respond (timeout tests)
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const EXIT_AFTER_MS = opt('--exit-after-ms', null);
const EXIT_CODE = Number(opt('--exit-code', '1'));
const SILENT = has('--silent');
const IGNORE_CLOSE = has('--ignore-close');

if (EXIT_AFTER_MS !== null) {
  setTimeout(() => process.exit(EXIT_CODE), Number(EXIT_AFTER_MS));
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function err(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (SILENT || !line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = msg;
  switch (method) {
    case 'browser/ping':
      ok(id, { ok: true, version: '0.0.1-test', driver: 'mini' });
      break;
    case 'browser/close':
      ok(id, { ok: true });
      if (!IGNORE_CLOSE) setImmediate(() => process.exit(0));
      break;
    case 'browser/open':
      err(id, -32000, 'blocked: private network address "10.0.0.1" is not user-approved');
      break;
    // Browser Agent UI phase (Worker 1) — session controls.
    case 'browser/takeover':
      ok(id, { ok: true, control: 'user' });
      break;
    case 'browser/release':
      ok(id, { ok: true, control: 'agent' });
      break;
    case 'browser/control':
      ok(id, { control: 'user' });
      break;
    case 'browser/screencast/start':
    case 'browser/screencast/stop':
      ok(id, { ok: true });
      break;
    case 'browser/frame/latest':
      ok(id, { data: 'ZmFrZS1mcmFtZQ==' });
      break;
    case 'browser/recording/start':
      ok(id, { ok: true });
      break;
    case 'browser/recording/stop':
      ok(id, { ok: true, videoPath: '/tmp/media/video.webm', tracePath: '/tmp/media/trace.zip' });
      break;
    default:
      ok(id, { ok: true, echo: method });
  }
});
