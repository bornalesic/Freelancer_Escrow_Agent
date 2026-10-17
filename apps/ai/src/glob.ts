// Tiny glob helpers shared by the parse guards and the eval scorer.

export const hasWildcard = (pattern: string): boolean => /[*?]/.test(pattern);

/** Minimal glob → RegExp: `**\/` any dirs, `*` within a segment, `?` one char. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Two file patterns agree if they are equal or either glob matches the other ("README*" ~ "README.md"). */
export function patternsMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase() || globToRegExp(a).test(b) || globToRegExp(b).test(a);
}
