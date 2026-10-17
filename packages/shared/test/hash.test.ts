import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex, termsHash, type Terms } from '../src/hash.ts';

describe('sha256Hex', () => {
  // Reference values from node:crypto.
  const vectors: [string, string][] = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['a'.repeat(55), '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318'],
    ['a'.repeat(56), 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'],
    ['a'.repeat(64), 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
    ['a'.repeat(1000), '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3'],
    ['héllo wörld 🎉', '88887bb90756341fffb0054b79689cf2cbf38d266b236ec83e657a03d284fd28'],
  ];
  it.each(vectors)('hashes %j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });
  it('hashes bytes the same as the equivalent string', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
  });
});

describe('canonicalJson', () => {
  it('is key-order independent, recursively', () => {
    const a = { b: 1, a: { y: [1, { q: 1, p: 2 }], x: 'x' } };
    const b = { a: { x: 'x', y: [1, { p: 2, q: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":"x","y":[1,{"p":2,"q":1}]},"b":1}');
  });
  it('drops undefined object values like JSON.stringify', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson([undefined])).toBe('[null]');
  });
  it('keeps array order', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });
  it('rejects bigint', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow();
  });
});

describe('termsHash', () => {
  const terms: Terms = {
    title: 'Slugify',
    amount: '50000000',
    assetId: 'rgb:asset',
    deadline: '2026-10-18T10:00:00.000Z',
    conditions: [{ id: 'c1', kind: 'tests_pass', description: 'Tests pass', command: 'npm test', timeoutSec: 60 }],
  };
  it('ignores fields outside the terms', () => {
    expect(termsHash({ ...terms, rawText: 'anything', state: 'DRAFT' } as Terms)).toBe(termsHash(terms));
  });
  it('changes when a condition changes', () => {
    const other = { ...terms, conditions: [{ ...terms.conditions[0]!, description: 'x' }] };
    expect(termsHash(other)).not.toBe(termsHash(terms));
  });
  it('is a 64-char hex string', () => {
    expect(termsHash(terms)).toMatch(/^[0-9a-f]{64}$/);
  });
});
