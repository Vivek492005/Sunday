#!/usr/bin/env node
// Fake sundayd for live-baseline adapter tests.
//
// Speaks the CURRENT wire protocol over stdio NDJSON (nested chat/event
// params, hello handshake, session/create result shape). Emits a scripted
// turn: one successful tool call, one failed tool call, a usage event, then
// turn-end.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof msg.id !== 'number') return;
  if (msg.method === 'sunday/hello') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        negotiated: true,
        server: { name: 'sundayd', version: '0.0.0-test' },
      },
    });
  } else if (msg.method === 'session/create') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        session: {
          id: 'sess-1',
          title: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });
  } else if (msg.method === 'chat/send') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turnId: 'turn-1' } });
    const notif = (event) =>
      send({
        jsonrpc: '2.0',
        method: 'chat/event',
        params: { turnId: 'turn-1', sessionId: 'sess-1', event },
      });
    notif({ type: 'tool-call', call: { id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } } });
    notif({
      type: 'tool-result',
      result: {
        toolCallId: 'c1',
        content: [{ type: 'text', text: 'hello' }],
        isError: false,
      },
    });
    notif({ type: 'tool-call', call: { id: 'c2', name: 'run_command', arguments: { command: 'false' } } });
    notif({
      type: 'tool-result',
      result: { toolCallId: 'c2', content: [{ type: 'text', text: 'boom' }], isError: true },
    });
    notif({ type: 'usage', usage: { inputTokens: 100, outputTokens: 25 } });
    notif({ type: 'turn-end', finishReason: 'stop' });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method: ${msg.method}` } });
  }
});
