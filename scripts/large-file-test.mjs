/**
 * Creates actual >5 GiB sparse files, then exercises browser File.slice and HTTP
 * Range loading. Sparse fixtures live only in an OS temp directory and are removed.
 * Run: node scripts/large-file-test.mjs (MODELDOCK_BROWSER optional).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const GiB = 1024 ** 3, directory = await mkdtemp(path.join(tmpdir(), 'modeldock-large-'));
const requests = [];
let server, browser;
try {
  const vertexCount = Math.ceil(5 * GiB / 24) + 1;
  const header = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${vertexCount}\nproperty double x\nproperty double y\nproperty double z\nend_header\n`);
  const plyPath = path.join(directory, 'actual-5gib.ply');
  const plySize = header.length + vertexCount * 24;
  const ply = await open(plyPath, 'w+');
  await ply.truncate(plySize); await ply.write(header, 0, header.length, 0);
  const middleVertex = Math.floor((vertexCount - 1) / 2);
  for (const [row, x] of [[0, 1], [middleVertex, 2], [vertexCount - 1, 3]]) {
    const record = Buffer.alloc(24); record.writeDoubleLE(x, 0);
    await ply.write(record, 0, record.length, header.length + row * 24);
  }
  const triangleCount = Math.ceil(5 * GiB / 50);
  const stlPath = path.join(directory, 'actual-5gib.stl'), stlSize = 84 + triangleCount * 50;
  const stl = await open(stlPath, 'w+');
  await stl.truncate(stlSize);
  const stlHeader = Buffer.alloc(84); stlHeader.writeUint32LE(triangleCount, 80);
  await stl.write(stlHeader, 0, 84, 0);
  const middleTriangle = Math.floor((triangleCount - 1) / 2);
  for (const [row, x] of [[0, 1], [middleTriangle, 2], [triangleCount - 1, 3]]) {
    const record = Buffer.alloc(50); record.writeFloatLE(1, 8);
    [x, 0, 0, x, 1, 0, x, 0, 1].forEach((value, k) => record.writeFloatLE(value, 12 + k * 4));
    await stl.write(record, 0, record.length, 84 + row * 50);
  }
  const bundled = await build({ entryPoints: ['src/large/index.ts'], bundle: true, write: false, format: 'iife', globalName: 'largeLoader', platform: 'browser', target: 'es2022' });
  const files = new Map([['/actual-5gib.ply', { handle: ply, size: plySize }], ['/actual-5gib.stl', { handle: stl, size: stlSize }]]);
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<input id="file" type="file"><script src="/large.js"></script>'); return; }
      if (request.url === '/large.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundled.outputFiles[0].contents); return; }
      const file = files.get(request.url);
      if (!file) { response.writeHead(404).end(); return; }
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
      if (!match) { response.writeHead(416).end(); return; }
      const start = Number(match[1]), end = Number(match[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= file.size || end - start + 1 > 1024 ** 2) { response.writeHead(416).end(); return; }
      const length = end - start + 1, bytes = Buffer.alloc(length);
      const result = await file.handle.read(bytes, 0, length, start);
      assert.equal(result.bytesRead, length);
      requests.push({ file: request.url, offset: start, length });
      response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${file.size}`, 'content-length': length, 'content-type': 'application/octet-stream', etag: '"sparse-fixture-v1"' });
      response.end(bytes);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.MODELDOCK_BROWSER, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(); await page.goto(url);
  const results = [];
  for (const [filePath, kind] of [[plyPath, 'ply'], [stlPath, 'stl']]) {
    await page.locator('#file').setInputFiles(filePath);
    const local = await page.evaluate(async () => {
      const file = document.querySelector('#file').files[0];
      const model = await largeLoader.loadLargeModel(largeLoader.sourceFromBlob(file), { maxPoints: 3, maxTriangles: 3, chunkBytes: 4096, maxReadBytes: 65536 });
      return { preview: model.preview, x: [...model.primitives[0].positions].filter((_, index) => index % (model.primitives[0].mode === 'triangles' ? 9 : 3) === 0) };
    });
    const remote = await page.evaluate(async ({ url, kind }) => {
      const source = await largeLoader.sourceFromHttp(`${url}/actual-5gib.${kind}`);
      const model = await largeLoader.loadLargeModel(source, { maxPoints: 3, maxTriangles: 3, chunkBytes: 4096, maxReadBytes: 65536 });
      return { preview: model.preview, x: [...model.primitives[0].positions].filter((_, index) => index % (model.primitives[0].mode === 'triangles' ? 9 : 3) === 0) };
    }, { url, kind });
    for (const result of [local, remote]) {
      assert(result.preview.sourceBytes > 5 * GiB);
      assert(result.preview.readBytes < 65536);
      assert(result.preview.maxReadChunkBytes <= 4096);
      assert.deepEqual(result.x, [0, 1, 2]);
      assert.equal(result.preview.fullyValidated, false);
    }
    const disk = await stat(filePath);
    results.push({ kind, logicalBytes: disk.size, allocatedBytes: disk.blocks * 512, local: local.preview, http: remote.preview });
  }
  assert(requests.some(r => r.offset > 4 * GiB));
  assert(requests.some(r => r.offset > 2 * GiB && r.offset < 3 * GiB));
  console.log(JSON.stringify({ passed: 'Actual >5 GiB PLY + STL via browser File.slice and validated HTTP ranges', results, httpTotalBytes: requests.reduce((n, r) => n + r.length, 0), httpRangeRequests: requests.length, largestOffset: Math.max(...requests.map(r => r.offset)) }, null, 2));
  await ply.close(); await stl.close();
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
