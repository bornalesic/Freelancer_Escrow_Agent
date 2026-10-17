import { describe, expect, it } from 'vitest';
import { colourContradiction, colourFactLines, colourFacts, describeHex } from '../src/colours.ts';

// The palettes of fixtures/demo-deliverable/landing-v1 (navy/blue) and landing-v2 (orange/cream).
const V1 = ':root { --header-bg: #1e3a5f; --header-text: #e2e8f0; --accent: #3b82f6; --page-bg: #f1f5f9; --card-bg: #ffffff; --text: #1e293b; }';
const V2 = ':root { --header-bg: #c2410c; --header-text: #fff7ed; --accent: #f59e0b; --page-bg: #fef3e2; --card-bg: #fffbf5; --text: #451a03; }';
const CRITERION = 'The page should look clean and use warm colours.';

describe('describeHex', () => {
  it('names colours and their temperature', () => {
    expect(describeHex('#1e3a5f')).toEqual({ hex: '#1e3a5f', name: 'dark blue', temperature: 'cool' });
    expect(describeHex('#3b82f6')).toMatchObject({ name: 'blue', temperature: 'cool' });
    expect(describeHex('#c2410c')).toMatchObject({ name: 'orange', temperature: 'warm' });
    expect(describeHex('#f59e0b')).toMatchObject({ name: 'orange', temperature: 'warm' });
    expect(describeHex('#451a03')).toMatchObject({ name: 'brown', temperature: 'warm' });
    expect(describeHex('#16a34a')).toMatchObject({ name: 'green', temperature: 'cool' });
  });

  it('treats whites, greys and near-blacks as neutral, and expands short forms', () => {
    expect(describeHex('#FFF')).toEqual({ hex: '#fff', name: 'white', temperature: 'neutral' });
    expect(describeHex('#e2e8f0')).toMatchObject({ name: 'light grey', temperature: 'neutral' });
    expect(describeHex('#1e293b')).toMatchObject({ name: 'dark grey', temperature: 'neutral' });
    expect(describeHex('#fef3e2')).toMatchObject({ temperature: 'neutral' });
  });

  it('rejects lengths that are not colours', () => {
    expect(describeHex('#12345')).toBeUndefined();
  });
});

describe('colourFacts', () => {
  it('lists distinct colours in order, ignoring comments and HTML entities', () => {
    const css = '/* old: #ff8800 */ a { color: #3B82F6; } b { color: #3b82f6; }';
    const html = '<p>it&#039;s</p><!-- #ffaa00 --><div style="background:#c2410c">';
    expect(colourFacts([css, undefined, html]).map((f) => f.hex)).toEqual(['#3b82f6', '#c2410c']);
  });

  it('formats prompt lines', () => {
    expect(colourFactLines(colourFacts(['#1e3a5f #fff']))).toBe('- #1e3a5f: dark blue (cool)\n- #fff: white (neutral)');
  });
});

describe('colourContradiction', () => {
  it('flags a warm criterion when every coloured value is cool', () => {
    expect(colourContradiction(CRITERION, colourFacts([V1]))?.found.map((f) => f.hex)).toEqual(['#1e3a5f', '#3b82f6']);
  });

  it('does not flag warm palettes, colourless deliveries or criteria without a temperature', () => {
    expect(colourContradiction(CRITERION, colourFacts([V2]))).toBeUndefined();
    expect(colourContradiction(CRITERION, colourFacts(['#fff #000 #f1f5f9']))).toBeUndefined();
    expect(colourContradiction('The page should look clean.', colourFacts([V1]))).toBeUndefined();
    expect(colourContradiction('The logo should look cool.', colourFacts([V2]))).toBeUndefined();
  });

  it('flags a cool-colour criterion on a warm palette', () => {
    expect(colourContradiction('Use cool colours throughout.', colourFacts([V2]))?.wanted).toBe('cool');
  });
});
