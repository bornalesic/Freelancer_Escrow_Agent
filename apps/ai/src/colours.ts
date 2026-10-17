// Colour facts for /review, computed by code. The 2B model reads hex values but cannot tell their
// temperature: on landing-v1 it called #1e3a5f "dark navy blue" and then "a warm colour". So code names
// each colour and its temperature for the prompt, and the guard in review.ts uses the same facts.

export type Temperature = 'warm' | 'cool' | 'neutral';
export interface ColourFact { hex: string; name: string; temperature: Temperature }

const HEX = /(?<![&\w])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi; // `(?<!&)` skips entities like &#039;
const MAX_FACTS = 12;
const MIN_CHROMA = 0.15; // below this a colour reads as white/grey/black
// Upper hue bound (degrees) of each name; the first bound above the hue wins.
const HUE_NAMES: [number, string][] = [
  [15, 'red'], [45, 'orange'], [70, 'yellow'], [170, 'green'], [200, 'teal'],
  [255, 'blue'], [290, 'purple'], [345, 'pink'], [360, 'red'],
];

function rgb(hex: string): [number, number, number] | undefined {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return undefined;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** Plain name + temperature of one hex colour, e.g. #1e3a5f → dark blue, cool. */
export function describeHex(hex: string): ColourFact | undefined {
  const c = rgb(hex);
  if (!c) return undefined;
  const [r, g, b] = c;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const light = (max + min) / 2;
  const fact = (name: string, temperature: Temperature) => ({ hex: hex.toLowerCase(), name, temperature });

  if (chroma < MIN_CHROMA) {
    const name = light >= 0.94 ? 'white' : light >= 0.75 ? 'light grey' : light >= 0.35 ? 'grey' : light >= 0.15 ? 'dark grey' : 'black';
    return fact(name, 'neutral');
  }
  const hue = max === r ? (60 * ((g - b) / chroma) + 360) % 360 : max === g ? 60 * ((b - r) / chroma + 2) : 60 * ((r - g) / chroma + 4);
  const base = HUE_NAMES.find(([limit]) => hue < limit)![1];
  const name = base === 'orange' && light < 0.3 ? 'brown' : `${light < 0.3 ? 'dark ' : light > 0.75 ? 'light ' : ''}${base}`;
  const temperature: Temperature = hue < 70 || hue >= 330 ? 'warm' : hue >= 90 && hue < 300 ? 'cool' : 'neutral';
  return fact(name, temperature);
}

/** Distinct hex colours in the excerpts, in order of appearance. Comments are skipped: the freelancer wrote them. */
export function colourFacts(excerpts: (string | undefined)[]): ColourFact[] {
  const facts = new Map<string, ColourFact>();
  for (const text of excerpts) {
    if (!text) continue;
    const code = text.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '');
    for (const m of code.matchAll(HEX)) {
      const f = describeHex(m[0]);
      if (f && !facts.has(f.hex)) facts.set(f.hex, f);
      if (facts.size >= MAX_FACTS) return [...facts.values()];
    }
  }
  return [...facts.values()];
}

/** Prompt lines, e.g. "- #1e3a5f: dark blue (cool)". */
export function colourFactLines(facts: ColourFact[]): string {
  return facts.map((f) => `- ${f.hex}: ${f.name} (${f.temperature})`).join('\n');
}

/**
 * If the criterion asks for warm (or cool) colours but every non-neutral colour in the delivery has the
 * opposite temperature, returns those colours; otherwise undefined.
 */
export function colourContradiction(criterion: string, facts: ColourFact[]): { wanted: Temperature; found: ColourFact[] } | undefined {
  const wanted: Temperature | undefined = /\bwarm/i.test(criterion) ? 'warm' : /\b(cool|cold)\s+(colou?rs?|tones?|palette)/i.test(criterion) ? 'cool' : undefined;
  if (!wanted) return undefined;
  const coloured = facts.filter((f) => f.temperature !== 'neutral');
  if (!coloured.length || coloured.some((f) => f.temperature === wanted)) return undefined;
  return { wanted, found: coloured };
}
