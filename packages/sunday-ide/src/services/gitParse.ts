/**
 * Pure parser for `git status --porcelain=v1` output.
 * Shared between the Electron main process and unit tests — no Node/Electron
 * imports here.
 */

export interface GitFileChange {
  path: string;
  /** Porcelain status letter: M, A, D, R, ?, U … */
  status: string;
  staged: boolean;
}

export interface GitChanges {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
}

/**
 * Parse `git status --porcelain=v1` (non -z) output.
 * Each line: XY<space>path — X = index status, Y = worktree status.
 * Renames look like `R  old -> new` (we keep the new path).
 */
export function parseGitPorcelain(out: string): GitChanges {
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  for (const rawLine of (out ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    if (x === ' ' && y === ' ') continue;
    let filePath = line.slice(3);
    const arrow = filePath.indexOf(' -> ');
    if (arrow >= 0) filePath = filePath.slice(arrow + 4);
    filePath = filePath.trim();
    if (!filePath) continue;
    if (x === '?' && y === '?') {
      unstaged.push({ path: filePath, status: '?', staged: false });
      continue;
    }
    if (x !== ' ') staged.push({ path: filePath, status: x, staged: true });
    if (y !== ' ') unstaged.push({ path: filePath, status: y, staged: false });
  }
  return { staged, unstaged };
}

/** Human label for a porcelain status letter. */
export function statusLabel(status: string): string {
  switch (status) {
    case 'M':
      return 'Modified';
    case 'A':
      return 'Added';
    case 'D':
      return 'Deleted';
    case 'R':
      return 'Renamed';
    case 'C':
      return 'Copied';
    case '?':
      return 'Untracked';
    case 'U':
      return 'Conflict';
    default:
      return status;
  }
}
