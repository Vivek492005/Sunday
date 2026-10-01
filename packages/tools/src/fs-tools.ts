import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWithinRoot } from './paths.js';
import { err, type Tool } from './types.js';

const MAX_READ_BYTES = 50_000_000;
const MAX_OUT_LINES = 2000;
const MAX_LIST_ENTRIES = 500;

export const readFileTool: Tool = {
  definition: {
    name: 'read_file',
    description:
      'Read a text file from the workspace. Output is line-numbered; use offset/limit to page through large files.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        offset: { type: 'integer', description: 'First line to read (1-based).', minimum: 1 },
        limit: { type: 'integer', description: 'Maximum lines to read.', minimum: 1 },
      },
    },
  },
  async execute(rawArgs, ctx) {
    const args = rawArgs as { path: string; offset?: number; limit?: number };
    const abs = resolveWithinRoot(ctx.cwd, args.path);
    const st = await fs.stat(abs).catch(() => null);
    if (!st) return err(`file not found: ${args.path}`);
    if (!st.isFile()) return err(`not a file: ${args.path}`);
    if (st.size > MAX_READ_BYTES) return err(`file too large to read (${st.size} bytes): ${args.path}`);
    const buf = await fs.readFile(abs);
    if (buf.indexOf(0) !== -1) return err(`binary file, refusing to print: ${args.path}`);
    const lines = buf.toString('utf8').split('\n');
    const start = (args.offset ?? 1) - 1;
    const slice = lines.slice(start, args.limit ? start + args.limit : undefined);
    const shown = slice.slice(0, MAX_OUT_LINES);
    let out = shown.map((l, i) => `${start + i + 1}: ${l}`).join('\n');
    if (slice.length > MAX_OUT_LINES) {
      out += `\n…[${slice.length - MAX_OUT_LINES} more lines truncated]`;
    }
    return { output: out || '(empty file)' };
  },
};

export const writeFileTool: Tool = {
  definition: {
    name: 'write_file',
    description: 'Create or overwrite a text file in the workspace. Parent directories are created as needed.',
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'Full file content (UTF-8).' },
      },
    },
  },
  async execute(rawArgs, ctx) {
    const args = rawArgs as { path: string; content: string };
    const abs = resolveWithinRoot(ctx.cwd, args.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, args.content, 'utf8');
    return { output: `wrote ${Buffer.byteLength(args.content, 'utf8')} bytes to ${args.path}` };
  },
};

export const editFileTool: Tool = {
  definition: {
    name: 'edit_file',
    description:
      'Replace the first exact occurrence of oldText with newText in a file. oldText must match exactly (including whitespace) and be unique in the file.',
    parameters: {
      type: 'object',
      required: ['path', 'oldText', 'newText'],
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        oldText: { type: 'string', description: 'Exact text to replace.' },
        newText: { type: 'string', description: 'Replacement text.' },
      },
    },
  },
  async execute(rawArgs, ctx) {
    const args = rawArgs as { path: string; oldText: string; newText: string };
    const abs = resolveWithinRoot(ctx.cwd, args.path);
    const text = await fs.readFile(abs, 'utf8').catch(() => null);
    if (text === null) return err(`file not found: ${args.path}`);
    const idx = text.indexOf(args.oldText);
    if (idx === -1) return err(`oldText not found in ${args.path}`);
    const occurrences = text.split(args.oldText).length - 1;
    if (occurrences > 1) {
      return err(`oldText matches ${occurrences} times in ${args.path} — make it unique`);
    }
    await fs.writeFile(abs, text.slice(0, idx) + args.newText + text.slice(idx + args.oldText.length), 'utf8');
    return { output: `replaced 1 occurrence in ${args.path}` };
  },
};

export const listDirTool: Tool = {
  definition: {
    name: 'list_dir',
    description: 'List a directory in the workspace (directories first, then files).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory (default ".").' },
        showHidden: { type: 'boolean', description: 'Include dotfiles (default false).' },
      },
    },
  },
  async execute(rawArgs, ctx) {
    const args = rawArgs as { path?: string; showHidden?: boolean };
    const abs = resolveWithinRoot(ctx.cwd, args.path ?? '.');
    const st = await fs.stat(abs).catch(() => null);
    if (!st) return err(`not found: ${args.path ?? '.'}`);
    if (!st.isDirectory()) return err(`not a directory: ${args.path ?? '.'}`);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const visible = entries.filter((e) => args.showHidden || !e.name.startsWith('.'));
    visible.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const shown = visible.slice(0, MAX_LIST_ENTRIES);
    const lines = await Promise.all(
      shown.map(async (e) => {
        if (e.isDirectory()) return `- [dir] ${e.name}/`;
        const s = await fs.stat(path.join(abs, e.name)).catch(() => null);
        return `- [file] ${e.name}${s ? ` (${s.size} bytes)` : ''}`;
      }),
    );
    if (visible.length > MAX_LIST_ENTRIES) {
      lines.push(`…[${visible.length - MAX_LIST_ENTRIES} more entries truncated]`);
    }
    return { output: lines.join('\n') || '(empty directory)' };
  },
};
