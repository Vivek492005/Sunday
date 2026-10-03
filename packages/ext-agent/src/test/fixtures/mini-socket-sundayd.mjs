// mini-socket-sundayd.mjs — hermetic fake sundayd for socket-mode tests.
// Speaks NDJSON JSON-RPC over a unix socket (or Windows named pipe).
// No dependencies, no network.
//
// Flags:
//   --socket <path>        listen path (required)
//   --protocol-version N   hello answers with this version (default 1)
//   --no-shutdown-exit     sunday/shutdown responds but does not exit
import net from 'node:net';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

const SOCKET_PATH = opt('--socket', null);
if (!SOCKET_PATH) {
  console.error('mini-socket-sundayd: --socket <path> required');
  process.exit(2);
}
const PROTOCOL_VERSION = Number(opt('--protocol-version', '1'));
const NO_SHUTDOWN_EXIT = has('--no-shutdown-exit');

function send(sock, obj) {
  sock.write(JSON.stringify(obj) + '\n');
}

const server = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send(sock, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      if (msg.id === undefined) continue; // notifications: ignore
      if (msg.method === 'sunday/hello') {
        send(sock, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            negotiated: msg.params?.protocolVersion === PROTOCOL_VERSION,
            server: { name: 'sundayd', version: '9.9.9-test' },
          },
        });
      } else if (msg.method === 'sunday/ping') {
        send(sock, { jsonrpc: '2.0', id: msg.id, result: { ok: true } });
      } else if (msg.method === 'sunday/shutdown') {
        send(sock, { jsonrpc: '2.0', id: msg.id, result: { ok: true } });
        if (!NO_SHUTDOWN_EXIT) setTimeout(() => process.exit(0), 50);
      } else {
        send(sock, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } });
      }
    }
  });
});

server.removeAllListeners('error');
// Stale socket recovery, mirroring the real cli.ts behaviour.
function listen() {
  server.listen(SOCKET_PATH, () => {
    // Ready — the connector polls until connect succeeds.
  });
}
server.once('error', (err) => {
  if (err.code === 'EADDRINUSE' && !SOCKET_PATH.startsWith('\\\\')) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      /* ignore */
    }
    listen();
    return;
  }
  console.error(`mini-socket-sundayd: ${err.message}`);
  process.exit(1);
});
listen();
