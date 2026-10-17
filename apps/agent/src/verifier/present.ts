import fg from 'fast-glob';

/** Files/folders matching `pattern` inside `root`. Case-insensitive, no dotfiles, never leaves `root`. */
export async function findMatches(root: string, pattern: string): Promise<string[]> {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.split('/').includes('..')) {
    throw new Error(`Pattern must stay inside the delivery: ${pattern}`);
  }
  const matches = await fg(p, {
    cwd: root,
    dot: false,
    onlyFiles: false,
    caseSensitiveMatch: false,
    followSymbolicLinks: false,
    deep: 12,
  });
  return matches.sort().slice(0, 50);
}
