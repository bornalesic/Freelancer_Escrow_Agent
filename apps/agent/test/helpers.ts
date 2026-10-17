import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

export function tmpDir(prefix = 'agent-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const TEST_FILE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slugify.js';

test('lowercases', () => assert.equal(slugify('ABC'), 'abc'));
test('spaces become dashes', () => assert.equal(slugify('a b'), 'a-b'));
test('strips punctuation: "Hello, World!" → "hello-world"', () => assert.equal(slugify('Hello, World!'), 'hello-world'));
`;

/** A tiny slugify project like fixtures/demo-deliverable. v1 forgets to strip punctuation. */
export function slugifyProject(version: 1 | 2, opts: { readme?: boolean } = {}): Record<string, string> {
  const impl =
    version === 1
      ? `export const slugify = (s) => s.toLowerCase().replace(/ +/g, '-');\n`
      : `export const slugify = (s) => s.toLowerCase().replace(/ +/g, '-').replace(/[^a-z0-9-]/g, '');\n`;
  return {
    'package.json': JSON.stringify({ name: 'slugify', type: 'module', scripts: { test: 'node --test' } }),
    'slugify.js': impl,
    'slugify.test.js': TEST_FILE,
    ...(opts.readme === false ? {} : { 'README.md': '# slugify\n' }),
  };
}

export function zipBuffer(files: Record<string, string>, prefix = ''): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(prefix + name, Buffer.from(content));
  return zip.toBuffer();
}

export function writeZip(dir: string, name: string, files: Record<string, string>, prefix = ''): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, zipBuffer(files, prefix));
  return file;
}
