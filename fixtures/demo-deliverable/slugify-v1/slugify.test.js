import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slugify.js';

test('lowercases text: "Hello" → "hello"', () => {
  assert.equal(slugify('Hello'), 'hello');
});

test('replaces spaces with dashes: "build a thing" → "build-a-thing"', () => {
  assert.equal(slugify('build a thing'), 'build-a-thing');
});

test('strips punctuation: "Hello, World!" → "hello-world"', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
});

test('keeps numbers: "Top 10 tips" → "top-10-tips"', () => {
  assert.equal(slugify('Top 10 tips'), 'top-10-tips');
});
