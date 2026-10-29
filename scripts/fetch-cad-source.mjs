import { readFile, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'third_party/cad-source');
const provenance = JSON.parse(await readFile(path.join(directory, 'provenance.json'), 'utf8'));
await mkdir(directory, { recursive: true });
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
for (const archive of provenance.archives) {
  if (
    path.basename(archive.file) !== archive.file ||
    !archive.url.startsWith('https://codeload.github.com/')
  )
    throw new Error('Unexpected CAD source provenance.');
  const target = path.join(directory, archive.file);
  let valid = false;
  try {
    valid =
      (await stat(target)).size === archive.bytes && (await digest(target)) === archive.sha256;
  } catch {}
  if (!valid) {
    const temporary = `${target}.part`;
    try {
      const response = await fetch(archive.url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body)
        throw new Error(`CAD source download failed: ${response.status}`);
      let bytes = 0;
      const bound = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(
            bytes > archive.bytes ? new Error('CAD source archive exceeds its pinned size.') : null,
            chunk,
          );
        },
      });
      await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(temporary));
      if (bytes !== archive.bytes || (await digest(temporary)) !== archive.sha256)
        throw new Error('CAD source archive checksum mismatch.');
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  console.log(`Verified corresponding CAD source: ${archive.file}`);
}
