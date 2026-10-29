import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, unlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { startViewerServer } from '../src/cli/server';

async function setup() {
  const temp = await mkdtemp(resolve('.modeldock-server-test-'));
  const assetsPath = join(temp, 'web');
  await mkdir(assetsPath);
  for (const file of ['viewer.js', 'styles.css', 'worker.js', 'occt-import-js.js', 'occt-import-js.wasm']) {
    await writeFile(join(assetsPath, file), `fixture ${file}`);
  }
  const filePath = join(temp, 'a model.PLY');
  await writeFile(filePath, 'ply\nformat ascii 1.0\nend_header\n');
  return { temp, assetsPath, filePath };
}

function http(url: string, options: { method?: string; headers?: Record<string, string>; path?: string } = {}) {
  const parsed = new URL(url);
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((resolveResponse, reject) => {
    const req = request({ hostname: parsed.hostname, port: parsed.port, path: options.path ?? parsed.pathname + parsed.search, method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolveResponse({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('local server serves only a private viewer, its assets and the selected model', async () => {
  const fixture = await setup();
  const server = await startViewerServer({ assetsPath: fixture.assetsPath, filePath: fixture.filePath });
  try {
    const index = await http(server.url);
    assert.equal(index.status, 200);
    assert.match(String(index.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(index.headers['access-control-allow-origin'], undefined);
    const config = JSON.parse(index.body.toString().match(/id="modeldock-config"[^>]*>(.*?)<\/script>/s)![1]);
    assert.equal(config.initialFile.name, 'a model.PLY');
    assert.match(config.assets.occtWasm, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/assets\/occt-import-js\.wasm$/);
    const model = await http(new URL(config.initialFile.url, server.url).href);
    assert.equal(model.status, 200);
    assert.deepEqual(model.body, await readFile(fixture.filePath));
    const head = await http(new URL(config.initialFile.url, server.url).href, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers['content-length']), model.body.length);
    const asset = await http(new URL('assets/worker.js', server.url).href);
    assert.equal(asset.status, 200);
    assert.match(String(asset.headers['content-type']), /javascript/);
    for (const route of ['assets/../a%20model.PLY', 'assets/%2e%2e/a%20model.PLY', 'assets/%2Fetc%2Fpasswd', 'api/model?path=/etc/passwd', '../a%20model.PLY', 'assets/missing.js']) {
      const response = await http(server.url, { path: `${new URL(server.url).pathname}${route}` });
      if (route.startsWith('api/model?')) {
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, model.body);
      } else assert.equal(response.status, 404, route);
    }
    assert.equal((await http(new URL('/', server.url).href)).status, 404);
    assert.equal((await http(new URL('/wrong-token/api/model', server.url).href)).status, 404);
  } finally { await server.close(); await rm(fixture.temp, { recursive: true, force: true }); }
});

test('local server blocks cross-origin, DNS rebinding and writes', async () => {
  const fixture = await setup();
  const server = await startViewerServer({ assetsPath: fixture.assetsPath, filePath: fixture.filePath });
  try {
    const deniedHeaders: Record<string, string>[] = [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Host: `evil.example:${server.port}` }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const headers of deniedHeaders) {
      assert.equal((await http(server.url, { headers })).status, 403);
    }
    const response = await http(server.url, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD');
    const allowed = await http(server.url, { headers: { Origin: new URL(server.url).origin } });
    assert.equal(allowed.status, 200);
  } finally { await server.close(); await rm(fixture.temp, { recursive: true, force: true }); }
});

test('metadata follows atomic replacement and enforces size limits after startup', async () => {
  const fixture = await setup();
  const server = await startViewerServer({ assetsPath: fixture.assetsPath, filePath: fixture.filePath, maxFileBytes: 64 });
  try {
    const metadataUrl = new URL('api/model.json', server.url).href;
    const before = JSON.parse((await http(metadataUrl)).body.toString());
    const replacement = join(fixture.temp, 'replacement');
    await writeFile(replacement, 'ply\nformat ascii 1.0\ncomment updated\nend_header\n');
    await rename(replacement, fixture.filePath);
    const after = JSON.parse((await http(metadataUrl)).body.toString());
    assert.notEqual(after.revision, before.revision);
    assert.match((await http(new URL(after.url, server.url).href)).body.toString(), /updated/);
    await writeFile(fixture.filePath, 'x'.repeat(65));
    assert.equal((await http(metadataUrl)).status, 413);
    assert.equal((await http(new URL('api/model', server.url).href)).status, 413);
    await unlink(fixture.filePath);
    assert.equal((await http(metadataUrl)).status, 404);
  } finally { await server.close(); await rm(fixture.temp, { recursive: true, force: true }); }
});

test('repointing a selected symlink cannot expose another file', async () => {
  const fixture = await setup();
  const linked = join(fixture.temp, 'linked.ply');
  const secret = join(fixture.temp, 'private.txt');
  await writeFile(secret, 'private');
  await symlink(fixture.filePath, linked);
  const server = await startViewerServer({ assetsPath: fixture.assetsPath, filePath: linked });
  try {
    assert.equal((await http(new URL('api/model', server.url).href)).status, 200);
    await unlink(linked);
    await symlink(secret, linked);
    assert.equal((await http(new URL('api/model', server.url).href)).status, 403);
  } finally { await server.close(); await rm(fixture.temp, { recursive: true, force: true }); }
});

test('empty viewer does not expose a directory and invalid files fail before bind', async () => {
  const fixture = await setup();
  const server = await startViewerServer({ assetsPath: fixture.assetsPath });
  try {
    assert.equal((await http(server.url)).status, 200);
    assert.equal((await http(new URL('api/model', server.url).href)).status, 404);
    assert.equal((await http(new URL('api/model.json', server.url).href)).status, 404);
    await assert.rejects(startViewerServer({ assetsPath: fixture.assetsPath, filePath: fixture.filePath, maxFileBytes: 1 }), /size limit/);
    await assert.rejects(startViewerServer({ assetsPath: fixture.assetsPath, filePath: join(fixture.temp, 'private.txt') }), /extension/);
  } finally { await server.close(); await rm(fixture.temp, { recursive: true, force: true }); }
});
