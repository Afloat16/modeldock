import { ZipFile } from 'yazl';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, readdir, stat, access, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
// Source archives stay out of Git history but must accompany binary releases.
await import('./fetch-cad-source.mjs');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const release = path.join(root, 'releases');
await mkdir(release, { recursive: true });
await access('dist/extension.cjs');
await access('dist/mcp.cjs');
await access('adapters/deepseek-harness/lib/client.js');
const vsix = `modeldock-${pkg.version}.vsix`;
await access(path.join(release, vsix));
const ignored = new Set(['node_modules', '.git', 'test-results', '.vscode-test', 'releases']);
async function collect(directory, prefix = '') {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ignored.has(entry.name) ||
      entry.name.startsWith('.modeldock-') ||
      entry.name.endsWith('.part') ||
      entry.name.endsWith('.log') ||
      entry.name === '.DS_Store'
    )
      continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await collect(file, relative)));
    else if (entry.isFile()) results.push({ file, relative });
  }
  return results;
}
async function zipTo(filename, files) {
  const zip = new ZipFile();
  const output = createWriteStream(path.join(release, filename));
  const done = new Promise((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    zip.outputStream.once('error', reject);
  });
  zip.outputStream.pipe(output);
  for (const { file, relative } of files) {
    const info = await stat(file);
    zip.addFile(file, relative, {
      mode: info.mode,
      compress:
        !file.endsWith('.tar.gz') &&
        !file.endsWith('.tgz') &&
        !file.endsWith('.vsix') &&
        !file.endsWith('.zip'),
    });
  }
  zip.end();
  await done;
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = JSON.parse(
  execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', release], {
    cwd: path.join(root, 'adapters/deepseek-harness'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);
if (!result[0]?.filename) throw new Error('Harness package filename was not returned.');
const harness = result[0].filename;
const openai = `modeldock-openai-${pkg.version}.zip`;
await zipTo(
  openai,
  (await collect(path.join(root, 'adapters/openai'))).map((item) => ({
    ...item,
    relative: `modeldock-openai/${item.relative}`,
  })),
);
const source = `modeldock-${pkg.version}-source.zip`;
const files = (await collect(root)).map((item) => ({
  ...item,
  relative: `modeldock/${item.relative}`,
}));
for (const name of [vsix, harness, openai])
  files.push({ file: path.join(release, name), relative: `modeldock/releases/${name}` });
await zipTo(source, files);
const checksums = [];
for (const name of [source, vsix, harness, openai])
  checksums.push(
    `${createHash('sha256')
      .update(await readFile(path.join(release, name)))
      .digest('hex')}  ${name}`,
  );
await writeFile(path.join(release, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
for (const name of [source, vsix, harness, openai, 'SHA256SUMS.txt'])
  console.log(`${name}\t${(await stat(path.join(release, name))).size} bytes`);
