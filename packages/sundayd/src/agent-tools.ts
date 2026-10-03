// sundayd — Part A tool wiring: `load_skill`, `tool_search`, namespaced MCP
// tools, and the approval-gated `remember` memory tool.
//
// `createSundaydTools()` is the composition entry cli.ts uses instead of
// `createDefaultRegistry()`: it builds the default registry, registers the
// Part A tools, creates the McpHub, and marks every `dangerous` definition on
// the shared PolicyGate. MCP tools appear via `hub.toTools()` (capped); tools
// beyond the cap stay reachable through `tool_search` → `hub.callTool`, which
// starts stopped servers on demand.

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { toolDefinitionSchema } from '@sunday/protocol';
import {
  createToolSearchTool,
  defaultWorkspaceConfigPath,
  McpHub,
  type McpHubOptions,
  type SecretResolver,
  type Tool as McpTool,
  type ToolContext as McpToolContext,
} from '@sunday/mcp';
import {
  remember as rememberEntry,
  SecretRefusedError,
  SkillLoader,
  type LoadedSkill,
  type MemoryScope,
} from '@sunday/skills';
import {
  createDefaultRegistry,
  err,
  ToolRegistry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from '@sunday/tools';
import { PolicyGate, type PolicyOptions } from './policy.js';
import { isWorkspaceTrusted, mcpSecretEnvName } from './trust.js';
import { adaptMcpToolForWorkspace } from './workspace-mcp.js';

const SKILL_NAME_RE = /^[a-z][a-z0-9_]*$/;

export interface SundaydMcpOptions {
  userConfigPath?: string;
  workspaceConfigPath?: string;
  secretResolver?: SecretResolver;
  /**
   * The hub loads the workspace-scope mcp.json only when the workspace is
   * trusted. Fail-closed: when the caller passes no verdict, the daemon's
   * own SUNDAY_WORKSPACE_TRUSTED verdict decides (SEC-04). The extension
   * still owns the interactive Allow/Deny prompt for *starting* a
   * workspace-scope server — the hub only controls which configs load.
   * Model-driven skill content stays hard-gated on `isWorkspaceTrusted()`
   * (see load_skill below).
   */
  workspaceTrusted?: boolean;
  /** Cap for MCP tools registered directly (default: hub's DEFAULT_MAX_TOOLS). */
  maxTools?: number;
}

export interface SundaydToolsOptions {
  /** Workspace root default for loaders. Defaults to cwd. */
  workspaceDir?: string;
  /** Home dir for user skills/memory. Defaults to os.homedir(). */
  userDir?: string;
  policy?: PolicyOptions;
  mcp?: SundaydMcpOptions;
}

export interface SundaydTools {
  registry: ToolRegistry;
  hub: McpHub;
  policy: PolicyGate;
  /** Resolved workspace mcp.json path (for per-server scope detection). */
  workspaceConfigPath: string;
  /** The workspaceTrusted value the hub was constructed with. */
  workspaceTrusted: boolean;
  /** Resolves once the MCP config is loaded and initial tools are synced. */
  ready: Promise<void>;
}

/**
 * SecretResolver for sundayd: `secret:<key>` references resolve from
 * `SUNDAY_MCP_SECRET_*` env vars, which the extension pre-populates from VS
 * Code SecretStorage at spawn time (the stdio protocol is client→daemon only,
 * so the daemon cannot ask the extension later).
 */
export class EnvSecretResolver implements SecretResolver {
  async resolve(key: string): Promise<string> {
    const value = process.env[mcpSecretEnvName(key)];
    if (value === undefined) {
      throw new Error(
        `secret "${key}" is not available to sundayd ` +
          `(${mcpSecretEnvName(key)} is not set — store it via "MCP: Store Secret" and restart the sidecar)`,
      );
    }
    return value;
  }
}

/**
 * Adapt an @sunday/mcp Tool (which deliberately mirrors the @sunday/tools
 * shape without depending on it) into the real registry Tool.
 */
export function adaptMcpTool(t: McpTool): Tool {
  return {
    definition: t.definition,
    execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const mcpCtx: McpToolContext = { cwd: ctx.cwd };
      if (ctx.signal !== undefined) mcpCtx.signal = ctx.signal;
      const r = await t.execute(args, mcpCtx);
      const out: ToolResult = { output: r.output };
      if (r.isError !== undefined) out.isError = r.isError;
      if (r.metadata !== undefined) out.metadata = r.metadata;
      return out;
    },
  };
}

function createLoadSkillTool(userDir: string): Tool {
  const definition = toolDefinitionSchema.parse({
    name: 'load_skill',
    description:
      'Read a skill\'s full content. Returns the skill body plus its supporting file list ' +
      '(open those with read_file). Skills come from .sunday/skills (workspace) and ' +
      '~/.sunday/skills (user); names are listed in the system prompt.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "Skill name (snake_case), exactly as listed in the system prompt's Skills section.",
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  });
  return {
    definition,
    execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const name = String(args.name ?? '');
      if (!SKILL_NAME_RE.test(name)) {
        return err(`invalid skill name "${name}": expected snake_case`);
      }
      const loader = new SkillLoader({ workspaceDir: ctx.cwd, userDir });
      let skill: LoadedSkill;
      try {
        skill = await loader.loadSkill(name);
      } catch (e) {
        return err(`load_skill: ${(e as Error).message}`);
      }
      // Trust gate: a workspace skill that ships executable scripts is
      // disabled in an untrusted workspace until the user approves it (by
      // trusting the workspace). Reading the SKILL.md body is safe; the
      // scripts it may instruct the agent to run are not.
      //
      // Phase 8 Stage 3: the verdict is per-workspace, resolved from the
      // session's cwd (which the daemon confines per workspace). In
      // single-workspace mode this falls back to the daemon's
      // SUNDAY_WORKSPACE_TRUSTED env verdict (unchanged behavior).
      if (skill.scope === 'workspace' && skill.hasScripts && !isWorkspaceTrusted(ctx.cwd)) {
        return err(
          `skill "${name}" contains scripts and the workspace is not trusted, so it is ` +
            `disabled until approved. Ask the user to trust the workspace (or explicitly approve ` +
            `this skill) before using it.`,
        );
      }
      const files =
        skill.files.length > 0
          ? `\n\nSupporting files:\n${skill.files.map((f) => `- ${f}`).join('\n')}`
          : '\n\nNo supporting files.';
      return { output: `# ${skill.name}\n\n${skill.description}\n\n${skill.body}${files}` };
    },
  };
}

function createRememberTool(userDir: string): Tool {
  const definition = toolDefinitionSchema.parse({
    name: 'remember',
    description:
      'Append a short note to persistent memory for future sessions. Use for durable facts ' +
      'the user asked you to keep (preferences, project conventions). ' +
      'Requires explicit user approval (dangerous). Never stores secrets.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The note to remember — one or two sentences, no credentials or secrets.',
        },
        scope: {
          type: 'string',
          enum: ['workspace', 'user'],
          description: 'Where to store it. Default: workspace.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    dangerous: true,
  });
  return {
    definition,
    execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const text = String(args.text ?? '');
      const scope: MemoryScope = args.scope === 'user' ? 'user' : 'workspace';
      try {
        const { appended, diff } = await rememberEntry(text, scope, {
          workspaceDir: ctx.cwd,
          userDir,
        });
        return { output: `Remembered (${scope}):\n${appended}\n\n${diff}` };
      } catch (e) {
        if (e instanceof SecretRefusedError) {
          return err(`remember refused: ${e.message}`);
        }
        return err(`remember failed: ${(e as Error).message}`);
      }
    },
  };
}

/** Build the full sundayd tool surface (default tools + Part A). */
export function createSundaydTools(opts: SundaydToolsOptions = {}): SundaydTools {
  const workspaceDir = resolve(opts.workspaceDir ?? process.cwd());
  const userDir = resolve(opts.userDir ?? homedir());
  const mcpOpts = opts.mcp ?? {};
  // SEC-04: fail closed — an untrusted (or verdict-less) workspace never
  // loads workspace-scope MCP servers, which could otherwise spawn
  // arbitrary local processes via stdio `command` entries.
  //
  // Phase 8 Stage 3: resolved per workspace root. In multi-workspace mode
  // the daemon's trust map decides; in single-workspace mode this falls
  // back to the SUNDAY_WORKSPACE_TRUSTED env verdict (unchanged behavior).
  const workspaceTrusted = mcpOpts.workspaceTrusted ?? isWorkspaceTrusted(workspaceDir);
  const workspaceConfigPath =
    mcpOpts.workspaceConfigPath ?? defaultWorkspaceConfigPath(workspaceDir);

  const registry = createDefaultRegistry();
  const policy = new PolicyGate(opts.policy);

  const hubOpts: McpHubOptions = { workspaceTrusted };
  if (mcpOpts.userConfigPath !== undefined) hubOpts.userConfigPath = mcpOpts.userConfigPath;
  hubOpts.workspaceConfigPath = workspaceConfigPath;
  hubOpts.secretResolver = mcpOpts.secretResolver ?? new EnvSecretResolver();
  const hub = new McpHub(hubOpts);

  // Part A tools.
  const loadSkill = createLoadSkillTool(userDir);
  const remember = createRememberTool(userDir);
  const toolSearch = adaptMcpTool(createToolSearchTool(hub));
  registry.register(loadSkill);
  registry.register(remember);
  registry.register(toolSearch);
  policy.markDangerous(remember.definition.name);
  // load_skill + tool_search are read-only (not dangerous).
  for (const def of registry.definitions()) {
    if (def.dangerous === true) policy.markDangerous(def.name);
  }

  /** Register newly appeared MCP tools (servers started after boot). */
  const syncMcpTools = (): void => {
    const config = hub.getConfig();
    const infos = new Map(hub.listTools().map((i) => [i.namespaced, i]));
    for (const t of hub.toTools({ maxTools: mcpOpts.maxTools })) {
      const name = t.definition.name;
      if (registry.names().includes(name)) continue;
      // Phase 8 Stage 3: execution-gated to this workspace. Permissive in
      // single-workspace mode (backward compat for sessions with any cwd),
      // strict once any workspace is configured (multi-workspace mode).
      registry.register(adaptMcpToolForWorkspace(t, adaptMcpTool, workspaceDir));
      policy.markDangerous(name);
      // Per-server default approval posture: 'allow' pre-approves the tools.
      const info = infos.get(name);
      const serverCfg = info ? config.servers[info.server] : undefined;
      if (serverCfg?.defaultApproval === 'allow') policy.approve(name);
    }
  };

  const ready = hub
    .loadConfig()
    .then(() => {
      syncMcpTools();
    })
    .catch((e: Error) => {
      // MCP is additive: a broken mcp.json must not take the daemon down.
      console.error(`[sundayd] MCP config load failed: ${e.message}`);
    });

  // Servers started later (mcp/server/start) or restarted publish here.
  hub.events.on('tools-changed', () => {
    try {
      syncMcpTools();
    } catch (e) {
      console.error(`[sundayd] MCP tool sync failed: ${(e as Error).message}`);
    }
  });

  return { registry, hub, policy, workspaceConfigPath, workspaceTrusted, ready };
}
