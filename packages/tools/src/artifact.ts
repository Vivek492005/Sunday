/**
 * @sunday/tools — create_artifact agent tool (Group A, A3).
 *
 * Lets the agent produce durable visual/text deliverables: HTML pages,
 * Markdown documents, and Mermaid diagrams. Artifacts are written under
 * `~/.sunday/artifacts/<session>/<slug>.<ext>` (mode 0600) — outside the
 * workspace, like memory, so generated documents never pollute the repo.
 *
 * Safety: strict type allowlist, 500KB size cap, and slug sanitization
 * that rejects path traversal (`../`, slashes, absolute paths). The tool
 * is not marked dangerous: it can only write inside the artifacts dir.
 */

import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import type { Tool, ToolContext, ToolResult } from './types.js';

/** Max artifact content size: 500 KiB. */
export const ARTIFACT_MAX_BYTES = 500 * 1024;

export const ARTIFACT_TYPES = {
  html: '.html',
  markdown: '.md',
  mermaid: '.mmd',
} as const;
export type ArtifactType = keyof typeof ARTIFACT_TYPES;

const TYPE_DESCRIPTIONS: Record<ArtifactType, string> = {
  html: 'a standalone HTML page (rendered sandboxed in the IDE)',
  markdown: 'a Markdown document (rendered to HTML in the IDE)',
  mermaid: 'a Mermaid diagram definition (shown as code + rendered when possible)',
};

/**
 * Turn a title into a safe filename slug. Returns undefined when the title
 * cannot be made safe (empty, traversal, separators, absolute path).
 */
export function slugifyTitle(title: string): string | undefined {
  if (typeof title !== 'string') return undefined;
  const t = title.trim();
  if (!t) return undefined;
  // Reject anything that even smells like a path: separators, drive
  // letters, dot-segments, leading dots, absolute paths.
  if (
    t.includes('/') ||
    t.includes('\\') ||
    t.includes(sep) ||
    /(^|[\\/])\.\.?([\\/]|$)/.test(t) ||
    t.startsWith('.') ||
    /^[A-Za-z]:/.test(t)
  ) {
    return undefined;
  }
  const slug = t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || undefined;
}

/** Session dir segment: strict allowlist (the session id is agent-influenced). */
export function sanitizeSessionId(sessionId: string | undefined): string {
  if (typeof sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(sessionId)) {
    return sessionId;
  }
  return 'default';
}

export function artifactsDir(sessionId: string | undefined, home: string = homedir()): string {
  return join(home, '.sunday', 'artifacts', sanitizeSessionId(sessionId));
}

export interface CreateArtifactResult {
  id: string;
  path: string;
  type: ArtifactType;
  bytes: number;
}

export async function createArtifactFile(
  args: { type: string; title: string; content: string },
  ctx: Pick<ToolContext, 'sessionId'>,
  home: string = homedir(),
): Promise<CreateArtifactResult> {
  const type = args.type as ArtifactType;
  if (!Object.prototype.hasOwnProperty.call(ARTIFACT_TYPES, type)) {
    throw new Error(
      `invalid type "${args.type}": must be one of ${Object.keys(ARTIFACT_TYPES).join(', ')}`,
    );
  }
  const slug = slugifyTitle(args.title);
  if (!slug) {
    throw new Error(
      'invalid title: must be a plain name (no paths, separators, or dot-segments)',
    );
  }
  const bytes = Buffer.byteLength(args.content, 'utf8');
  if (bytes > ARTIFACT_MAX_BYTES) {
    throw new Error(
      `content too large: ${bytes} bytes exceeds the ${ARTIFACT_MAX_BYTES}-byte cap`,
    );
  }
  const dir = artifactsDir(ctx.sessionId, home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filename = `${slug}${ARTIFACT_TYPES[type]}`;
  const path = join(dir, filename);
  await writeFile(path, args.content, { mode: 0o600 });
  await chmod(path, 0o600);
  return {
    id: `${sanitizeSessionId(ctx.sessionId)}/${slug}`,
    path,
    type,
    bytes,
  };
}

export const createArtifactTool: Tool = {
  definition: {
    name: 'create_artifact',
    description:
      'Create a durable artifact the user can open in the IDE: ' +
      Object.entries(TYPE_DESCRIPTIONS)
        .map(([t, d]) => `${t} (${d})`)
        .join('; ') +
      '. Writes to ~/.sunday/artifacts/<session>/; content capped at 500KB. ' +
      'Use for reports, diagrams, mockups, and documents the user asked for.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: Object.keys(ARTIFACT_TYPES) },
        title: { type: 'string', description: 'Plain title used for the filename (no paths)' },
        content: { type: 'string', description: 'Full artifact content' },
      },
      required: ['type', 'title', 'content'],
    },
  },
  execute: async (args, ctx): Promise<ToolResult> => {
    try {
      const r = await createArtifactFile(
        {
          type: args.type as string,
          title: args.title as string,
          content: args.content as string,
        },
        ctx,
      );
      return {
        output:
          `artifact created: ${r.id} (${r.type}, ${r.bytes} bytes)\n` +
          `The user can open it from the Sunday Artifacts panel.`,
        metadata: { id: r.id, path: r.path, type: r.type, bytes: r.bytes },
      };
    } catch (e) {
      return { output: `create_artifact failed: ${(e as Error).message}`, isError: true };
    }
  },
};
