import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Condition } from '@escrow/shared';
import { checkCondition, prepareWorkspace } from '../src/verifier';
import { runCommand } from '../src/verifier/tests';
import { safeEntryPath, unpack } from '../src/verifier/unpack';
import { buildReviewFiles } from '../src/verifier/excerpt';
import { listFiles, resolveDeliveryFile } from '../src/verifier/files';
import { slugifyProject, tmpDir, writeZip } from './helpers';

const tests: Condition = { id: 'c1', kind: 'tests_pass', description: 'Tests pass', command: 'npm test', timeoutSec: 30 };
const readme: Condition = { id: 'c2', kind: 'file_present', description: 'README', pathPattern: 'readme*' };

describe('unpack', () => {
  it('rejects zip-slip paths', () => {
    expect(() => safeEntryPath('../evil')).toThrow();
    expect(() => safeEntryPath('a/../../evil')).toThrow();
    expect(() => safeEntryPath('/etc/passwd')).toThrow();
    expect(() => safeEntryPath('C:\\x')).toThrow();
    expect(safeEntryPath('a\\b.txt')).toBe('a/b.txt');
  });

  it('extracts a zip and descends into a single top-level folder', () => {
    const dir = tmpDir();
    const zip = writeZip(dir, 'd.zip', { 'a.txt': 'A', 'sub/b.txt': 'B' }, 'project/');
    const root = unpack(zip, 'd.zip', path.join(dir, 'work'));
    expect(root).toBe(path.join(dir, 'work', 'project'));
    expect(fs.readFileSync(path.join(root, 'sub/b.txt'), 'utf8')).toBe('B');
  });

  it('copies a non-zip file as-is', () => {
    const dir = tmpDir();
    const f = path.join(dir, 'upload');
    fs.writeFileSync(f, 'hello');
    const root = unpack(f, 'report.pdf', path.join(dir, 'work'));
    expect(fs.readFileSync(path.join(root, 'report.pdf'), 'utf8')).toBe('hello');
  });
});

describe('runCommand', () => {
  it('captures output and exit code', async () => {
    const r = await runCommand('echo hi; echo err >&2; exit 3', tmpDir(), 10);
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('hi');
    expect(r.output).toContain('err');
    expect(r.timedOut).toBe(false);
  });

  it('keeps only the last 40 lines', async () => {
    const r = await runCommand('for i in $(seq 1 100); do echo line$i; done', tmpDir(), 10);
    const lines = r.output.split('\n');
    expect(lines).toHaveLength(40);
    expect(lines.at(-1)).toBe('line100');
  });

  it('kills the whole process tree on timeout', async () => {
    const dir = tmpDir();
    const marker = path.join(dir, 'survived');
    const started = Date.now();
    const r = await runCommand(`(sleep 3 && touch ${marker}) & sleep 30`, dir, 1);
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/Timed out/);
    expect(Date.now() - started).toBeLessThan(5000);
    await new Promise((res) => setTimeout(res, 3500));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('does not pass secrets through the environment', async () => {
    process.env.AGENT_MNEMONIC = 'secret words';
    const r = await runCommand('echo "[$AGENT_MNEMONIC]"', tmpDir(), 10);
    delete process.env.AGENT_MNEMONIC;
    expect(r.output).toBe('[]');
  });
});

describe('checkCondition', () => {
  function workspace(version: 1 | 2, opts?: { readme?: boolean }) {
    const dir = tmpDir();
    const zip = writeZip(dir, 'd.zip', slugifyProject(version, opts));
    return { zip, ws: prepareWorkspace(zip, 'd.zip', path.join(dir, 'work')) };
  }

  it('tests_pass fails on v1 with the failing test name in the output', async () => {
    const r = await checkCondition(tests, workspace(1).ws);
    expect(r.passed).toBe(false);
    expect(r.evidence.exitCode).not.toBe(0);
    expect(r.evidence.stdoutTail).toContain('strips punctuation');
  });

  it('tests_pass passes on v2', async () => {
    const r = await checkCondition(tests, workspace(2).ws);
    expect(r.passed).toBe(true);
    expect(r.evidence.exitCode).toBe(0);
  });

  it('file_present matches case-insensitively and fails when missing', async () => {
    expect((await checkCondition(readme, workspace(2).ws)).evidence.matched).toEqual(['README.md']);
    expect((await checkCondition(readme, workspace(2, { readme: false }).ws)).passed).toBe(false);
  });

  it('file_present refuses patterns that leave the delivery', async () => {
    const r = await checkCondition({ ...readme, pathPattern: '../*' } as Condition, workspace(2).ws);
    expect(r.passed).toBe(false);
    expect(r.evidence.error).toMatch(/inside/);
  });

  it('file_hash checks the whole upload or a named file', async () => {
    const { zip, ws } = workspace(2);
    const whole = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    const readmeHash = createHash('sha256').update('# slugify\n').digest('hex');
    const hash = (sha256: string, fileName?: string): Condition => ({ id: 'h', kind: 'file_hash', description: 'hash', sha256, ...(fileName ? { fileName } : {}) });
    expect((await checkCondition(hash(whole), ws)).passed).toBe(true);
    expect((await checkCondition(hash(readmeHash, 'README.md'), ws)).passed).toBe(true);
    const wrong = await checkCondition(hash('0'.repeat(64), 'README.md'), ws);
    expect(wrong.passed).toBe(false);
    expect(wrong.evidence.actualSha256).toBe(readmeHash);
    expect((await checkCondition(hash(readmeHash, 'nope.md'), ws)).evidence.error).toMatch(/not found/);
    expect((await checkCondition(hash(readmeHash, '../../x'), ws)).evidence.error).toMatch(/inside/);
  });

  it('a broken zip fails every unpacked condition with an explanation', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'bad.zip');
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage')]));
    const ws = prepareWorkspace(f, 'bad.zip', path.join(dir, 'work'));
    const r = await checkCondition(tests, ws);
    expect(r.passed).toBe(false);
    expect(r.evidence.error).toMatch(/Could not unpack/);
  });
});

describe('delivery files for client review', () => {
  it('serves only regular files inside the delivery (no .., no symlinks out)', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');
    fs.mkdirSync(path.join(root, 'css'));
    fs.writeFileSync(path.join(root, 'css', 'a.css'), 'h1{}');
    const secret = path.join(tmpDir(), 'secret.txt');
    fs.writeFileSync(secret, 'secret');
    fs.symlinkSync(secret, path.join(root, 'link.txt'));

    expect(resolveDeliveryFile(root, 'index.html')).toBe(path.join(root, 'index.html'));
    expect(resolveDeliveryFile(root, 'css/a.css')).toBe(path.join(root, 'css', 'a.css'));
    expect(resolveDeliveryFile(root, 'link.txt')).toBeUndefined();
    expect(resolveDeliveryFile(root, '../secret.txt')).toBeUndefined();
    expect(resolveDeliveryFile(root, '/etc/passwd')).toBeUndefined();
    expect(resolveDeliveryFile(root, 'css')).toBeUndefined();
    expect(listFiles(root).map((f) => f.path)).toEqual(['css/a.css', 'index.html']);
  });

  it('excerpts text files only, within the size caps', () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, 'README.md'), '# Readme\n');
    fs.writeFileSync(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(root, `big${i}.txt`), 'x'.repeat(10_000));
    const files = buildReviewFiles(root);
    expect(files.find((f) => f.path === 'README.md')!.excerpt).toBe('# Readme\n');
    expect(files.find((f) => f.path === 'img.png')!.excerpt).toBeUndefined();
    expect(files.every((f) => (f.excerpt?.length ?? 0) <= 3 * 1024)).toBe(true);
    expect(files.reduce((n, f) => n + (f.excerpt?.length ?? 0), 0)).toBeLessThanOrEqual(12 * 1024);
    expect(files.find((f) => f.path === 'big0.txt')!.sizeBytes).toBe(10_000);
  });
});
