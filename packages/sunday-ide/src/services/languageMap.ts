/**
 * Extension → Monaco language id + short badge label for the file tree.
 * Pure function, unit-tested.
 */

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'dockerfile',
};

const FILENAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
};

export function languageForFile(fileName: string): string {
  const lower = fileName.toLowerCase();
  const byName = FILENAME_LANGUAGE[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return 'plaintext';
  const ext = lower.slice(dot + 1);
  return EXTENSION_LANGUAGE[ext] ?? 'plaintext';
}

/** Short badge shown in the explorer tree, e.g. "TS", "{}", "PY". */
export function badgeForFile(fileName: string): string {
  const lang = languageForFile(fileName);
  const map: Record<string, string> = {
    typescript: 'TS',
    javascript: 'JS',
    json: '{}',
    css: 'CSS',
    scss: 'CSS',
    less: 'CSS',
    html: '<>',
    xml: '<>',
    markdown: 'MD',
    python: 'PY',
    rust: 'RS',
    go: 'GO',
    java: 'JV',
    kotlin: 'KT',
    c: 'C',
    cpp: 'C+',
    csharp: 'C#',
    ruby: 'RB',
    php: 'PHP',
    swift: 'SW',
    shell: 'SH',
    yaml: 'YML',
    toml: 'TML',
    sql: 'SQL',
    dockerfile: 'DK',
  };
  return map[lang] ?? '···';
}

export function baseName(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}
