/** Parses the first balanced JSON object in model text (tolerates code fences, chatter or junk after it). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object in output');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object (output cut off?)');
}
