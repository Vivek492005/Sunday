// mini-sundayd.mjs — hermetic fake sundayd for ext-agent tests.
// Speaks NDJSON JSON-RPC on stdio. No dependencies, no network.
//
// Flags:
//   --protocol-version N   hello answers with this version (default 1)
//   --silent               accept input, never respond (timeout tests)
//   --exit-after-ms N      exit with --exit-code after N ms (crash tests)
//   --exit-code N          (default 1)
//   --no-chat-events       chat/send responds but emits no chat/event stream
//   --bad-hello-shape      hello responds with a wrong result shape
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const PROTOCOL_VERSION = Number(opt('--protocol-version', '1'));
const SILENT = has('--silent');
const EXIT_AFTER_MS = opt('--exit-after-ms', null);
const EXIT_CODE = Number(opt('--exit-code', '1'));
const NO_CHAT_EVENTS = has('--no-chat-events');
const BAD_HELLO_SHAPE = has('--bad-hello-shape');

if (has('--greet-garbage')) {
  process.stdout.write('this is not json-rpc\n');
}
const stderrGreet = opt('--stderr-greet', null);
if (stderrGreet !== null) {
  process.stderr.write(stderrGreet + '\n');
}

if (EXIT_AFTER_MS !== null) {
  setTimeout(() => process.exit(EXIT_CODE), Number(EXIT_AFTER_MS));
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (SILENT || !line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore malformed input
  }
  const { id, method, params } = msg;
  switch (method) {
    case 'sunday/hello':
      if (BAD_HELLO_SHAPE) ok(id, { nope: true });
      else
        ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          negotiated: params?.protocolVersion === PROTOCOL_VERSION,
          server: { name: 'sundayd', version: '9.9.9-test' },
        });
      break;
    case 'sunday/ping':
      ok(id, { ok: true, time: new Date().toISOString() });
      break;
    case 'sunday/shutdown':
      ok(id, { ok: true });
      setTimeout(() => process.exit(0), 50); // let the response flush
      break;
    case 'session/create':
      ok(id, {
        session: {
          id: 'sess-test-1',
          title: params?.title ?? '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      break;
    case 'session/list':
      ok(id, { sessions: [] });
      break;
    case 'session/close':
      ok(id, { ok: true });
      break;
    case 'chat/send': {
      const turnId = 'turn-test-1';
      ok(id, { turnId });
      if (!NO_CHAT_EVENTS) {
        setTimeout(
          () => notify('chat/event', { turnId, sessionId: params?.sessionId ?? 's', event: { type: 'text-delta', delta: 'hi' } }),
          10,
        );
        setTimeout(
          () =>
            notify('chat/event', {
              turnId,
              sessionId: params?.sessionId ?? 's',
              event: { type: 'turn-end', finishReason: 'stop' },
            }),
          30,
        );
      }
      break;
    }
    case 'chat/cancel':
      ok(id, { ok: true });
      break;
    case 'tools/list':
      ok(id, { tools: [] });
      break;
    case 'models/list':
      ok(id, { models: [] });
      break;
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  }
});
