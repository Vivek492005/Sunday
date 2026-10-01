import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  McpHub,
  DEFAULT_MAX_TOOLS,
  namespacedName,
  sanitizeNamePart,
  createToolSearchTool,
  parseMcpConfig,
  mergeConfigs,
  resolveSecretRefs,
  NoSecretResolver,
  type McpConfig,
  type McpServerConfig,
  type SecretResolver,
} from './index.js';

// ---------------------------------------------------------------- helpers

interface FakeToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler?: (args: Record<string, unknown> | undefined) => CallToolResult | Promise<CallToolResult>;
}

function cfg(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    transport: 'stdio',
    command: ['node', 'fake.js'],
    enabled: true,
    defaultApproval: 'ask',
    ...overrides,
  };
}

function writeHubConfig(dir: string, servers: Record<string, McpServerConfig>): Promise<string> {
  const p = path.join(dir, 'mcp.json');
  return fs.writeFile(p, JSON.stringify({ servers })).then(() => p);
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sunday-mcp-test-'));
}

/** A hub wired to real in-process SDK Servers over in-memory transports.
 *  The factory spawns a FRESH server per start (the SDK forbids reconnecting). */
async function makeHubWithFakeServer(
  serverName: string,
  tools: FakeToolDef[],
  serverCfg: Partial<McpServerConfig> = {},
) {
  const liveServers: Server[] = [];
  const spawnFake = async (): Promise<Transport> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const t = tools.find((x) => x.name === req.params.name);
      if (!t) {
        return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true };
      }
      if (t.handler) return t.handler(req.params.arguments as Record<string, unknown> | undefined);
      return { content: [{ type: 'text', text: `ok:${req.params.name}` }] };
    });
    await server.connect(serverTransport);
    liveServers.push(server);
    return clientTransport;
  };

  const dir = await makeTempDir();
  const userConfigPath = await writeHubConfig(dir, { [serverName]: cfg(serverCfg) });
  const hub = new McpHub({
    userConfigPath,
    workspaceConfigPath: path.join(dir, 'no-workspace.json'),
  });
  await hub.loadConfig();
  const factory = () => spawnFake();
  const cleanup = async () => {
    await hub.stopAll().catch(() => undefined);
    for (const s of liveServers) await s.close().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  };
  return { hub, factory, dir, cleanup };
}

const mapResolver = (secrets: Record<string, string>): SecretResolver => ({
  resolve: async (key: string) => {
    if (!(key in secrets)) throw new Error(`no such secret: ${key}`);
    return secrets[key];
  },
});

// ---------------------------------------------------------------- config

describe('parseMcpConfig', () => {
  it('parses a valid config with defaults', () => {
    const c = parseMcpConfig(
      {
        servers: {
          fs: { transport: 'stdio', command: ['node', 's.js'] },
          remote: {
            transport: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'secret:MY_TOKEN' },
          },
        },
      },
      'test',
    );
    expect(c.servers.fs.enabled).toBe(true);
    expect(c.servers.fs.defaultApproval).toBe('ask');
    expect(c.servers.remote.url).toBe('https://example.com/mcp');
  });

  it('rejects invalid shapes with clear errors', () => {
    expect(() => parseMcpConfig({}, 't')).toThrow('"servers" must be an object');
    expect(() => parseMcpConfig({ servers: { s: { transport: 'grpc' } } }, 't')).toThrow(
      'transport must be "stdio" or "http"',
    );
    expect(() => parseMcpConfig({ servers: { s: { transport: 'stdio' } } }, 't')).toThrow(
      'command must be a non-empty string array',
    );
    expect(() => parseMcpConfig({ servers: { s: { transport: 'http' } } }, 't')).toThrow(
      'url must be a non-empty string',
    );
    expect(() =>
      parseMcpConfig({ servers: { s: { transport: 'stdio', command: ['x'], enabled: 'yes' } } }, 't'),
    ).toThrow('enabled must be a boolean');
  });
});

describe('mergeConfigs', () => {
  const user: McpConfig = { servers: { a: cfg(), b: cfg({ transport: 'http', url: 'https://u/x' }) } };
  const ws: McpConfig = { servers: { b: cfg({ defaultApproval: 'allow' }), c: cfg() } };

  it('merges with workspace overriding by name when trusted', () => {
    const { config, workspaceIgnored } = mergeConfigs(user, ws, true);
    expect(workspaceIgnored).toBe(false);
    expect(Object.keys(config.servers).sort()).toEqual(['a', 'b', 'c']);
    expect(config.servers.b.defaultApproval).toBe('allow');
    expect(config.servers.a.defaultApproval).toBe('ask');
  });

  it('ignores workspace config and flags it when untrusted', () => {
    const { config, workspaceIgnored } = mergeConfigs(user, ws, false);
    expect(workspaceIgnored).toBe(true);
    expect(Object.keys(config.servers).sort()).toEqual(['a', 'b']);
    expect(config.servers.b.defaultApproval).toBe('ask');
  });

  it('does not flag when there is no workspace config', () => {
    expect(mergeConfigs(user, null, false).workspaceIgnored).toBe(false);
  });
});

describe('resolveSecretRefs', () => {
  const resolver = mapResolver({ MY_TOKEN: 'tok-123', OTHER: 'o' });

  it('resolves ${secret:KEY}, secret:KEY, and ${env:NAME}', async () => {
    expect(await resolveSecretRefs('Bearer ${secret:MY_TOKEN}', resolver)).toBe('Bearer tok-123');
    expect(await resolveSecretRefs('secret:MY_TOKEN', resolver)).toBe('tok-123');
    process.env.SUNDAY_MCP_TEST_VAR = 'env-val';
    expect(await resolveSecretRefs('x=${env:SUNDAY_MCP_TEST_VAR}', resolver)).toBe('x=env-val');
    delete process.env.SUNDAY_MCP_TEST_VAR;
  });

  it('leaves plain values untouched', async () => {
    expect(await resolveSecretRefs('plain-value', resolver)).toBe('plain-value');
  });

  it('throws on missing env var and unresolvable secret', async () => {
    await expect(resolveSecretRefs('${env:DEFINITELY_NOT_SET_XYZ}', resolver)).rejects.toThrow(
      'not set',
    );
    await expect(resolveSecretRefs('secret:UNKNOWN', resolver)).rejects.toThrow('no such secret');
  });

  it('NoSecretResolver errors clearly', async () => {
    const stub = new NoSecretResolver();
    await expect(stub.resolve('K')).rejects.toThrow('no SecretResolver is configured');
    await expect(resolveSecretRefs('secret:K', stub)).rejects.toThrow(
      'no SecretResolver is configured',
    );
  });
});

// ---------------------------------------------------------------- lifecycle

describe('McpHub lifecycle', () => {
  it('starts, lists, stops, and restarts a server', async () => {
    const { hub, factory, cleanup } = await makeHubWithFakeServer('demo', [
      { name: 'greet', description: 'Says hi' },
    ]);
    try {
      expect(hub.serverStatus('demo').state).toBe('stopped');

      const states: string[] = [];
      hub.events.on('server-state', (p: { state: string }) => states.push(p.state));

      await hub.startServer('demo', factory);
      const st = hub.serverStatus('demo');
      expect(st.state).toBe('running');
      expect(st.toolCount).toBe(1);
      expect(st.transport).toBe('stdio');

      // restartServer reuses the remembered test factory (no explicit arg needed)
      await hub.restartServer('demo');
      expect(hub.serverStatus('demo').state).toBe('running');

      await hub.stopServer('demo');
      expect(hub.serverStatus('demo').state).toBe('stopped');
      expect(hub.listTools()).toEqual([]);

      expect(states).toContain('starting');
      expect(states).toContain('running');
      expect(states).toContain('stopped');
    } finally {
      await cleanup();
    }
  });

  it('emits tools-changed with the tool count', async () => {
    const { hub, factory, cleanup } = await makeHubWithFakeServer('demo', [
      { name: 'a' },
      { name: 'b' },
    ]);
    try {
      const events: Array<{ name: string; toolCount: number }> = [];
      hub.events.on('tools-changed', (p) => events.push(p));
      await hub.startServer('demo', factory);
      expect(events).toContainEqual({ name: 'demo', toolCount: 2 });
    } finally {
      await cleanup();
    }
  });

  it('startAll starts enabled servers and skips disabled ones', async () => {
    const dir = await makeTempDir();
    const liveServers: Server[] = [];
    const spawnFake = async (): Promise<Transport> => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const s = new Server({ name: 'f', version: '1' }, { capabilities: { tools: {} } });
      s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
      await s.connect(serverTransport);
      liveServers.push(s);
      return clientTransport;
    };
    try {
      const userConfigPath = await writeHubConfig(dir, {
        on: cfg(),
        off: cfg({ enabled: false }),
      });
      const hub = new McpHub({ userConfigPath, workspaceConfigPath: path.join(dir, 'ws.json') });
      await hub.loadConfig();
      // Remember a factory for 'on' via an explicit start, then stop it;
      // startAll must reuse the remembered factory and skip 'off'.
      await hub.startServer('on', spawnFake);
      await hub.stopServer('on');
      await hub.startAll();
      expect(hub.serverStatus('on').state).toBe('running');
      expect(hub.serverStatus('off').state).toBe('stopped');
      await hub.stopAll();
      expect(hub.serverStatus('on').state).toBe('stopped');
    } finally {
      for (const s of liveServers) await s.close().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to start a disabled server explicitly', async () => {
    const { hub, factory, cleanup } = await makeHubWithFakeServer('demo', [], { enabled: false });
    try {
      await expect(hub.startServer('demo', factory)).rejects.toThrow('disabled');
    } finally {
      await cleanup();
    }
  });

  it('records lastError and error state when a server fails to start', async () => {
    const dir = await makeTempDir();
    try {
      const userConfigPath = await writeHubConfig(dir, {
        // Nothing listens on port 9 — deterministic connection refused.
        bad: cfg({ transport: 'http', url: 'http://127.0.0.1:9/mcp' }),
      });
      const hub = new McpHub({
        userConfigPath,
        workspaceConfigPath: path.join(dir, 'ws.json'),
      });
      await hub.loadConfig();
      const seen: Array<{ state: string; lastError?: string }> = [];
      hub.events.on('server-state', (p) => seen.push(p));
      await expect(hub.startServer('bad')).rejects.toThrow('failed to start MCP server "bad"');
      const st = hub.serverStatus('bad');
      expect(st.state).toBe('error');
      expect(st.lastError).toBeTruthy();
      expect(seen.some((s) => s.state === 'error')).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('throws on unknown server names', async () => {
    const { hub, cleanup } = await makeHubWithFakeServer('demo', []);
    try {
      expect(() => hub.serverStatus('nope')).toThrow('unknown MCP server');
      await expect(hub.startServer('nope')).rejects.toThrow('unknown MCP server');
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------- namespacing + toggles

describe('namespacing and tool toggles', () => {
  it('exposes mcp__<server>__<tool> names, sanitized to snake_case', async () => {
    const { hub, factory, cleanup } = await makeHubWithFakeServer('My-Server', [
      { name: 'Read-File', description: 'reads' },
      { name: '2nd_tool', description: 'numbered' },
    ]);
    try {
      await hub.startServer('My-Server', factory);
      const tools = hub.listTools();
      expect(tools.map((t) => t.namespaced).sort()).toEqual([
        'mcp__my_server__read_file',
        'mcp__my_server__s_2nd_tool',
      ]);
      expect(namespacedName('My-Server', 'Read-File')).toBe('mcp__my_server__read_file');
      expect(sanitizeNamePart('9lives!')).toBe('s_9lives');
      for (const t of tools) {
        expect(t.namespaced).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    } finally {
      await cleanup();
    }
  });

  it('honors allowlist/denylist (denylist wins)', async () => {
    const { hub, factory, cleanup } = await makeHubWithFakeServer(
      'demo',
      [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      { toolAllowlist: ['a', 'b'], toolDenylist: ['b'] },
    );
    try {
      await hub.startServer('demo', factory);
      const byName = Object.fromEntries(hub.listTools().map((t) => [t.name, t.enabled]));
      expect(byName).toEqual({ a: true, b: false, c: false });
      // Only enabled tools are exposed.
      expect(hub.toTools().map((t) => t.definition.name)).toEqual(['mcp__demo__a']);
      // Disabled tools throw on direct call.
      await expect(hub.callTool('mcp__demo__b', {})).rejects.toThrow('disabled');
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------- cap + tool_search

describe('tool cap and tool_search', () => {
  const many = Array.from({ length: 35 }, (_, i) => ({
    name: `tool_${String(i).padStart(2, '0')}`,
    description: `Does thing number ${i}`,
  }));

  it(`caps toTools() at ${DEFAULT_MAX_TOOLS} by default`, async () => {
    const { hub, factory, cleanup } = await makeHubWithFakeServer('big', many);
    try {
      await hub.startServer('big', factory);
      const tools = hub.toTools();
      expect(tools).toHaveLength(DEFAULT_MAX_TOOLS);
      expect(hub.toTools({ maxTools: 5 })).toHaveLength(5);
      expect(hub.toTools({ maxTools: 100 })).toHaveLength(35);
      // Overflow stays callable + listed.
      expect(hub.listTools()).toHaveLength(35);
      // Definitions are dangerous (risk class M) and schema-valid.
      for (const t of tools) {
        expect(t.definition.dangerous).toBe(true);
        expect(t.definition.name).toMatch(/^mcp__/);
      }
    } finally {
      await cleanup();
    }
  });

  it('tool_search finds hidden tools beyond the cap', async () => {
    const { hub, factory, cleanup } = await makeHubWithFakeServer('big', many);
    try {
      await hub.startServer('big', factory);
      const search = createToolSearchTool(hub);
      expect(search.definition.name).toBe('tool_search');

      // tool_30..tool_34 are beyond the default cap of 30.
      const res = await search.execute({ query: 'thing number 3' }, { cwd: '/' });
      expect(res.isError).toBeFalsy();
      for (const n of ['30', '31', '32', '33', '34']) {
        expect(res.output).toContain(`mcp__big__tool_${n}`);
      }
      // Directly-exposed tools are excluded from results.
      const res2 = await search.execute({ query: 'tool_0' }, { cwd: '/' });
      expect(res2.output).toContain('no hidden MCP tools match');

      const res3 = await search.execute({ query: 'zzz-no-such-tool' }, { cwd: '/' });
      expect(res3.output).toContain('no hidden MCP tools match');
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------- callTool + history

describe('callTool and history', () => {
  it('calls tools, formats output, and records history', async () => {
    const { hub, factory, cleanup } = await makeHubWithFakeServer('demo', [
      {
        name: 'echo',
        description: 'echo',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        handler: (args) => ({ content: [{ type: 'text', text: `got:${args?.text}` }] }),
      },
      {
        name: 'boom',
        handler: () => {
          throw new Error('kaput');
        },
      },
      {
        name: 'sad',
        handler: () => ({ content: [{ type: 'text', text: 'nope' }], isError: true }),
      },
    ]);
    try {
      await hub.startServer('demo', factory);

      const ok = await hub.callTool('mcp__demo__echo', { text: 'hi' });
      expect(ok).toEqual({ output: 'got:hi' });

      const errRes = await hub.callTool('mcp__demo__boom', {});
      expect(errRes.isError).toBe(true);
      expect(errRes.output).toContain('kaput');

      const sad = await hub.callTool('mcp__demo__sad', {});
      expect(sad).toEqual({ output: 'nope', isError: true });

      const history = hub.getCallHistory();
      expect(history).toHaveLength(3);
      // Newest first.
      expect(history[0].tool).toBe('sad');
      expect(history[0].ok).toBe(false);
      expect(history[0].error).toContain('nope');
      expect(history[2].tool).toBe('echo');
      expect(history[2].ok).toBe(true);
      expect(history[2].namespaced).toBe('mcp__demo__echo');
      expect(history[2].server).toBe('demo');
      expect(typeof history[2].durationMs).toBe('number');
      expect(new Date(history[2].at).getTime()).not.toBeNaN();

      expect(hub.getCallHistory(2)).toHaveLength(2);

      await expect(hub.callTool('mcp__demo__nope', {})).rejects.toThrow('unknown MCP tool');
      await expect(hub.callTool('not_namespaced', {})).rejects.toThrow('not an MCP tool name');
    } finally {
      await cleanup();
    }
  });

  it('truncates long args in the history summary', async () => {
    const { hub, factory, cleanup } = await makeHubWithFakeServer('demo', [{ name: 'echo' }]);
    try {
      await hub.startServer('demo', factory);
      await hub.callTool('mcp__demo__echo', { blob: 'x'.repeat(500) });
      const [rec] = hub.getCallHistory(1);
      expect(rec.argsSummary.length).toBeLessThanOrEqual(241);
      expect(rec.argsSummary).toContain('blob');
    } finally {
      await cleanup();
    }
  });

  it('starts a stopped server on demand', async () => {
    const { hub, factory, cleanup } = await makeHubWithFakeServer('demo', [{ name: 'ping' }]);
    try {
      // Never started explicitly — callTool must start it via the remembered factory.
      await hub.startServer('demo', factory);
      await hub.stopServer('demo');
      expect(hub.serverStatus('demo').state).toBe('stopped');
      const res = await hub.callTool('mcp__demo__ping', {});
      expect(res.output).toBe('ok:ping');
      expect(hub.serverStatus('demo').state).toBe('running');
    } finally {
      await cleanup();
    }
  });

  it('toTools().execute routes through the hub', async () => {
    const { hub, factory, cleanup } = await makeHubWithFakeServer('demo', [{ name: 'ping' }]);
    try {
      await hub.startServer('demo', factory);
      const [tool] = hub.toTools();
      const res = await tool.execute({}, { cwd: '/' });
      expect(res.output).toBe('ok:ping');
      expect(hub.getCallHistory(1)[0].namespaced).toBe('mcp__demo__ping');
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------- workspace trust

describe('workspace trust gating', () => {
  it('ignores untrusted workspace config and flags it', async () => {
    const dir = await makeTempDir();
    try {
      const userConfigPath = await writeHubConfig(dir, { user_srv: cfg() });
      await fs.mkdir(path.join(dir, '.sunday'), { recursive: true });
      await writeHubConfig(path.join(dir, '.sunday'), { ws_srv: cfg() });
      const hub = new McpHub({
        userConfigPath,
        workspaceConfigPath: path.join(dir, '.sunday', 'mcp.json'),
        workspaceTrusted: false,
      });
      const config = await hub.loadConfig();
      expect(hub.workspaceConfigIgnored).toBe(true);
      expect(Object.keys(config.servers)).toEqual(['user_srv']);

      const trusted = new McpHub({
        userConfigPath,
        workspaceConfigPath: path.join(dir, '.sunday', 'mcp.json'),
        workspaceTrusted: true,
      });
      const config2 = await trusted.loadConfig();
      expect(trusted.workspaceConfigIgnored).toBe(false);
      expect(Object.keys(config2.servers).sort()).toEqual(['user_srv', 'ws_srv']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- real stdio

const STDIO_FIXTURE = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fake-stdio', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo_text',
    description: 'Echoes the input text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: 'echo:' + (req.params.arguments?.text ?? '') }],
}));
await server.connect(new StdioServerTransport());
`;

describe('real stdio transport', () => {
  let fixturePath = '';
  let dir = '';

  beforeAll(async () => {
    // Written under node_modules so the child resolves @modelcontextprotocol/sdk.
    const fixtureDir = path.join(process.cwd(), 'node_modules', '.mcp-test-fixtures');
    await fs.mkdir(fixtureDir, { recursive: true });
    fixturePath = path.join(fixtureDir, 'fake-stdio-server.mjs');
    await fs.writeFile(fixturePath, STDIO_FIXTURE);
    dir = await makeTempDir();
  });

  afterAll(async () => {
    await fs.rm(fixturePath, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('spawns a stdio server, lists tools, and calls one', async () => {
    const seenSecrets: string[] = [];
    const resolver: SecretResolver = {
      resolve: async (key: string) => {
        seenSecrets.push(key);
        return 'resolved-token';
      },
    };
    const userConfigPath = await writeHubConfig(dir, {
      std: cfg({
        command: ['node', fixturePath],
        env: { FOO: 'bar', TOKEN: 'secret:MY_TOKEN', FROM_ENV: '${env:PATH}' },
      }),
    });
    const hub = new McpHub({
      userConfigPath,
      workspaceConfigPath: path.join(dir, 'ws.json'),
      secretResolver: resolver,
    });
    try {
      await hub.loadConfig();
      await hub.startServer('std');
      expect(hub.serverStatus('std').state).toBe('running');
      expect(seenSecrets).toContain('MY_TOKEN');

      const tools = hub.listTools();
      expect(tools.map((t) => t.namespaced)).toEqual(['mcp__std__echo_text']);

      const res = await hub.callTool('mcp__std__echo_text', { text: 'hello' });
      expect(res).toEqual({ output: 'echo:hello' });

      const [rec] = hub.getCallHistory(1);
      expect(rec.ok).toBe(true);
      expect(rec.argsSummary).toContain('hello');
    } finally {
      await hub.stopAll().catch(() => undefined);
    }
  }, 30000);
});
