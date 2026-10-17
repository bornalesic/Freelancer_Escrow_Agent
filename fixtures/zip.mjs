// Zips each folder in fixtures/demo-deliverable/ into fixtures/dist/<folder>.zip (contents at the zip root).
// Zero dependencies (node:zlib only) so it runs the same in WSL and PowerShell. Fixed timestamps and
// sorted entries make the output byte-identical every run, so its sha256 is stable across rehearsals.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const here = fileURLToPath(new URL('.', import.meta.url));
const srcRoot = join(here, 'demo-deliverable');
const outDir = join(here, 'dist');

// 2026-10-17 12:00:00 in MS-DOS format
const DOS_TIME = (12 << 11) | (0 << 5) | 0;
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 17;

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== 'node_modules' && e.name !== '.DS_Store')
    .flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]))
    .sort();
}

function zip(files, base) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(relative(base, file).split(sep).join('/'));
    const data = readFileSync(file);
    const deflated = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + deflated.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

mkdirSync(outDir, { recursive: true });
for (const entry of readdirSync(srcRoot).sort()) {
  const dir = join(srcRoot, entry);
  if (!statSync(dir).isDirectory()) continue;
  const buf = zip(listFiles(dir), dir);
  const out = join(outDir, `${entry}.zip`);
  writeFileSync(out, buf);
  const sha = createHash('sha256').update(buf).digest('hex');
  console.log(`${relative(process.cwd(), out)}  ${buf.length} bytes  sha256 ${sha}`);
}
