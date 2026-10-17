import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 5000;

/** True if the file starts with the zip local-file-header magic "PK\x03\x04". */
export function isZip(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    return fs.readSync(fd, buf, 0, 4, 0) === 4 && buf.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } finally {
    fs.closeSync(fd);
  }
}

/** Reject absolute paths, drive letters and any `..` segment. Returns the normalised relative path. */
export function safeEntryPath(entryName: string): string {
  const name = entryName.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..') || name.includes('\0')) {
    throw new Error(`Unsafe path in zip: ${entryName}`);
  }
  return name;
}

/**
 * Unpack an upload into `dest` (wiped first). A zip is extracted with path checks; any other file is
 * copied in as-is. Returns the folder conditions run in: if the zip holds a single top-level folder
 * (someone zipped the folder, not its contents), that folder.
 */
export function unpack(upload: string, fileName: string, destDir: string): string {
  const dest = path.resolve(destDir);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  if (!isZip(upload)) {
    fs.copyFileSync(upload, path.join(dest, path.basename(fileName)));
    return dest;
  }

  const entries = new AdmZip(upload).getEntries();
  if (entries.length > MAX_ENTRIES) throw new Error(`Zip has too many entries (${entries.length})`);
  let total = 0;
  for (const entry of entries) {
    const rel = safeEntryPath(entry.entryName);
    if (rel.startsWith('__MACOSX/')) continue;
    const target = path.resolve(dest, rel);
    if (target !== dest && !target.startsWith(dest + path.sep)) throw new Error(`Unsafe path in zip: ${entry.entryName}`);
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const data = entry.getData();
    total += data.length;
    if (total > MAX_UNPACKED_BYTES) throw new Error('Zip is too large when unpacked (over 100 MB)');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Plain file with default mode: no symlinks, no setuid bits from the archive.
    fs.writeFileSync(target, data, { mode: 0o644 });
  }

  return workspaceRoot(dest);
}

/** If `dir` holds a single top-level folder (someone zipped the folder, not its contents), that folder. */
export function workspaceRoot(dir: string): string {
  const top = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.'));
  if (top.length === 1 && top[0]!.isDirectory()) return path.join(dir, top[0]!.name);
  return dir;
}
