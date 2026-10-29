import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, rm, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { selectedFileInfo, readSelectedRange, validateRange } from '../src/host/selected-file';
import { readWebviewRequest } from '../src/extension/webview';
import { createViewerServer } from '../src/openai/server';
import { openAISelectedRangeSource, type CallFileTool } from '../src/openai/range';
import { harnessRangeSource, parseHarnessSelection, type HarnessFileRemote } from '../adapters/deepseek-harness/src/range-source';
import { startViewerServer } from '../src/cli/server';
import { MAX_RANGE_BYTES } from '../src/shared/types';

const fiveGiB = 5 * 1024 ** 3;
async function sparseFixture() {
  const directory = await mkdtemp(resolve('.modeldock-range-test-'));
  const path = join(directory, 'selected.ply');
  const file = await open(path, 'w');
  try {
    await file.truncate(fiveGiB + 64);
    await file.write(new Uint8Array([17, 29, 41, 53]), 0, 4, fiveGiB + 12);
  } finally { await file.close(); }
  return { directory, path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
function http(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, unknown>; data: Buffer }>((resolveResult, reject) => {
    const req = request(url, { headers, method }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolveResult({ status: res.statusCode!, headers: res.headers, data: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}
const selected = { name: 'selected.ply', resourceUri: 'opaque:selected' };
function openAIFake(overrides: Partial<{ revision: string; size: number }> = {}): CallFileTool {
  return async (name, args) => name === 'modeldock_file_info'
    ? { structuredContent: { name: selected.name, size: fiveGiB + 64, revision: 'v1', ...overrides } }
    : { structuredContent: { ...args, base64: Buffer.alloc(Number(args.length), 7).toString('base64') } };
}
function harnessFake(): HarnessFileRemote {
  return { workspaceFiles: {
    stat: async () => ({ ok: true, value: { absolutePath: '/authorized/selected.ply', version: 'v1', bytes: fiveGiB + 64 } }),
    readBytes: async (_session, _path, options) => ({ ok: true, value: { absolutePath: '/authorized/selected.ply', version: 'v1', bytes: fiveGiB + 64, offset: options.range.offset, data: new Uint8Array(options.range.length).fill(9), eof: false } }),
  } };
}
const address = 'dsh-resource://file/session/test/selected.ply';

test('host selected-file reads are bounded and retain offsets beyond 4 GiB', async () => {
  const f = await sparseFixture();
  try {
    const info = await selectedFileInfo(f.path);
    assert.equal(info.size, fiveGiB + 64);
    assert.equal(info.name, 'selected.ply');
    const bytes = await readSelectedRange(f.path, info.revision, fiveGiB + 12, 4);
    assert.deepEqual([...bytes], [17, 29, 41, 53]);
    await assert.rejects(readSelectedRange(f.path, info.revision, 0, MAX_RANGE_BYTES + 1), /4 MiB/);
    await assert.rejects(readSelectedRange(f.path, info.revision, info.size - 1, 2), /Invalid byte range/);
    await assert.rejects(selectedFileInfo(f.path, fiveGiB), /source-size limit/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(readSelectedRange(f.path, info.revision, 0, 4, undefined, abort.signal), { name: 'AbortError' });
    const changed = await open(f.path, 'r+');
    try { await changed.write(new Uint8Array([99]), 0, 1, fiveGiB + 12); } finally { await changed.close(); }
    await assert.rejects(readSelectedRange(f.path, info.revision, fiveGiB + 12, 4), /changed/);
  } finally { await f.cleanup(); }
});

test('host range validation rejects malformed windows and unsupported selections', async () => {
  for (const [offset, length, size] of [[-1, 1, 4], [0, 0, 4], [.5, 1, 4], [0, Infinity, 4], [Number.MAX_SAFE_INTEGER + 1, 1, Number.MAX_SAFE_INTEGER + 2], [4, 1, 4], [0, MAX_RANGE_BYTES + 1, MAX_RANGE_BYTES + 1]]) {
    assert.throws(() => validateRange(offset, length, size), /Invalid byte range/);
  }
  await assert.rejects(selectedFileInfo('relative.ply'), /absolute supported/);
  await assert.rejects(selectedFileInfo(resolve('not-authorized.txt')), /absolute supported/);
  const directory = await mkdtemp(resolve('.modeldock-range-test-'));
  try {
    const path = join(directory, 'folder.ply'); await mkdir(path);
    await assert.rejects(selectedFileInfo(path), /regular file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('webview range requests accept opaque capabilities and reject paths, extra fields and invalid ranges', () => {
  const good = { type: 'readRange', requestId: 'req-1', sourceId: 'a'.repeat(32), revision: 'v1', offset: fiveGiB + 12, length: 4 };
  assert.deepEqual(readWebviewRequest(good), good);
  assert.deepEqual(readWebviewRequest({ type: 'pickModels', requestId: 'req-2' }), { type: 'pickModels', requestId: 'req-2' });
  for (const bad of [null, [], { ...good, path: '/private/file.ply' }, { ...good, sourceId: '/private/file.ply' }, { ...good, offset: -1 }, { ...good, offset: 1.5 }, { ...good, length: MAX_RANGE_BYTES + 1 }, { ...good, length: 0 }, { ...good, requestId: '<script>' }, { ...good, revision: 'x'.repeat(251) }, { type: 'pickModels', requestId: 'req', path: '/private/file.ply' }]) {
    assert.equal(readWebviewRequest(bad), undefined);
  }
});

test('OpenAI MCP host metadata is required and a path argument cannot choose another file', async () => {
  const f = await sparseFixture();
  const server = createViewerServer(async () => '<html></html>');
  const client = new Client({ name: 'range-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const missing = await client.callTool({ name: 'modeldock_file_info', arguments: {} });
    assert.equal(missing.isError, true);
    assert.equal((missing.structuredContent as Record<string, unknown>).reason, 'HOST_FILE_CONTEXT_REQUIRED');
    const meta = { 'openai/resource': { path: f.path } };
    const result = await client.callTool({ name: 'modeldock_file_info', arguments: {}, _meta: meta });
    assert.equal(result.isError, undefined);
    const info = result.structuredContent as Record<string, unknown>;
    assert.equal(info.size, fiveGiB + 64);
    const read = await client.callTool({ name: 'modeldock_read_range', arguments: { offset: fiveGiB + 12, length: 4, revision: info.revision }, _meta: meta });
    assert.deepEqual([...Buffer.from(String((read.structuredContent as Record<string, unknown>).base64), 'base64')], [17, 29, 41, 53]);
    const noContext = await client.callTool({ name: 'modeldock_read_range', arguments: { offset: 0, length: 4, revision: info.revision, path: f.path } });
    assert.equal(noContext.isError, true);
    const secret = join(f.directory, 'secret.ply'); await writeFile(secret, 'secret-never-selected');
    const redirect = await client.callTool({ name: 'modeldock_file_info', arguments: { path: secret }, _meta: meta });
    assert.equal(redirect.isError, true, 'An app-supplied path must be refused by the strict schema.');
    const tooLarge = await client.callTool({ name: 'modeldock_read_range', arguments: { offset: 0, length: MAX_RANGE_BYTES + 1, revision: info.revision }, _meta: meta });
    assert.equal(tooLarge.isError, true);
    const stale = await client.callTool({ name: 'modeldock_read_range', arguments: { offset: 0, length: 4, revision: 'wrong' }, _meta: meta });
    assert.equal(stale.isError, true);
    const missingPath = join(f.directory, 'missing.ply');
    const unavailable = await client.callTool({ name: 'modeldock_file_info', arguments: {}, _meta: { 'openai/resource': { path: missingPath } } });
    assert.equal(unavailable.isError, true);
    assert.ok(!JSON.stringify(unavailable).includes(missingPath), 'OS errors should not leak selected absolute paths.');
  } finally { await client.close(); await server.close(); await f.cleanup(); }
});

test('OpenAI byte-window adapter bounds offsets, validates revisions and preserves transport permissions', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const real = openAIFake();
  const source = await openAISelectedRangeSource(selected, async (name, args, signal) => { calls.push({ name, args }); return real(name, args, signal); }, new AbortController().signal);
  assert.equal(source?.size, fiveGiB + 64);
  assert.deepEqual([...await source!.readRange!(fiveGiB, 4)], [7, 7, 7, 7]);
  assert.deepEqual(calls[1].args, { offset: fiveGiB, length: 4, revision: 'v1' });
  await assert.rejects(source!.readRange!(0, MAX_RANGE_BYTES + 1), /Invalid bounded/);
  const stale = await openAISelectedRangeSource(selected, async (name, args) => name === 'modeldock_file_info' ? real(name, args) : { structuredContent: { ...args, revision: 'v2', base64: 'AAAAAA==' } }, new AbortController().signal);
  await assert.rejects(stale!.readRange!(0, 4), /different model revision/);
  const denied = await openAISelectedRangeSource(selected, async (name, args) => name === 'modeldock_file_info' ? real(name, args) : { isError: true, content: [{ type: 'text', text: 'Host permission denied' }] }, new AbortController().signal);
  await assert.rejects(denied!.readRange!(0, 4), /permission denied/);
  const malformed = await openAISelectedRangeSource(selected, async (name, args) => name === 'modeldock_file_info' ? real(name, args) : { structuredContent: { ...args, base64: 'AA==' } }, new AbortController().signal);
  await assert.rejects(malformed!.readRange!(0, 4), /truncated/);
  assert.equal(await openAISelectedRangeSource(selected, async () => ({ isError: true, structuredContent: { reason: 'HOST_FILE_CONTEXT_REQUIRED' } }), new AbortController().signal), undefined);
});

test('OpenAI adapter refuses a last response delivered after cancellation', async () => {
  const abort = new AbortController(), real = openAIFake();
  const source = await openAISelectedRangeSource(selected, async (name, args) => {
    if (name !== 'modeldock_file_info') abort.abort();
    return real(name, args);
  }, abort.signal);
  await assert.rejects(source!.readRange!(0, 4), { name: 'AbortError' });
});

test('Harness ranges split bounded transfers and validate permissions, revisions and windows', async () => {
  const remote = harnessFake(), calls: Array<{ path: string; offset: number; length: number }> = [];
  const read = remote.workspaceFiles.readBytes;
  remote.workspaceFiles.readBytes = async (session, path, options, signal) => { calls.push({ path, ...options.range }); return read(session, path, options, signal); };
  const source = await harnessRangeSource(remote, address, selected.name, new AbortController().signal);
  const bytes = await source.readRange!(fiveGiB, 32);
  assert.equal(bytes.length, 32); assert.equal(bytes[0], 9);
  assert.deepEqual(calls, [{ path: '/authorized/selected.ply', offset: fiveGiB, length: 32 }]);
  await source.readRange!(0, 1024 * 1024 + 1);
  assert.deepEqual(calls.slice(1).map(x => x.length), [512 * 1024, 512 * 1024, 1]);
  await assert.rejects(source.readRange!(0, MAX_RANGE_BYTES + 1), /Invalid bounded/);
  const changed = harnessFake();
  changed.workspaceFiles.readBytes = async (_session, _path, options) => ({ ok: true, value: { absolutePath: '/authorized/selected.ply', version: 'v2', bytes: fiveGiB + 64, offset: options.range.offset, data: new Uint8Array(options.range.length), eof: false } });
  const stale = await harnessRangeSource(changed, address, selected.name, new AbortController().signal);
  await assert.rejects(stale.readRange!(0, 4), /changed/);
  const denied = harnessFake();
  denied.workspaceFiles.stat = async () => ({ ok: false, error: { message: 'Host permission denied' } });
  await assert.rejects(harnessRangeSource(denied, address, selected.name, new AbortController().signal), /permission denied/);
  assert.deepEqual(parseHarnessSelection(address), { sessionId: 'test', path: 'selected.ply' });
  for (const bad of ['file:///etc/passwd', 'dsh-resource://other/session/test/a.ply', 'dsh-resource://file/session/test/a.ply?path=secret', 'dsh-resource://file/session/test/a.ply#x']) assert.throws(() => parseHarnessSelection(bad), /Unsupported/);
});

test('Harness adapter refuses a last frame delivered after cancellation', async () => {
  const abort = new AbortController(), remote = harnessFake(), read = remote.workspaceFiles.readBytes;
  remote.workspaceFiles.readBytes = async (...args) => { abort.abort(); return read(...args); };
  const source = await harnessRangeSource(remote, address, selected.name, abort.signal);
  await assert.rejects(source.readRange!(0, 4), { name: 'AbortError' });
});

test('CLI HTTP ranges retain >4 GiB offsets, enforce caps and reject malformed/revised windows', async () => {
  const f = await sparseFixture();
  const server = await startViewerServer({ filePath: f.path, assetsPath: f.directory });
  try {
    const info = JSON.parse((await http(new URL('api/model.json', server.url).href)).data.toString()) as { url: string; revision: string };
    const url = new URL(info.url, server.url).href;
    const result = await http(url, { Range: `bytes=${fiveGiB + 12}-${fiveGiB + 15}` });
    assert.equal(result.status, 206);
    assert.equal(result.headers['content-range'], `bytes ${fiveGiB + 12}-${fiveGiB + 15}/${fiveGiB + 64}`);
    assert.deepEqual([...result.data], [17, 29, 41, 53]);
    const head = await http(url, { Range: `bytes=${fiveGiB + 12}-${fiveGiB + 15}` }, 'HEAD');
    assert.equal(head.status, 206); assert.equal(head.data.length, 0); assert.equal(head.headers['content-length'], '4');
    for (const range of ['bytes=0-', 'bytes=-10', 'bytes=0-1,3-4', 'bytes=2-1', 'bytes=0-4194304', `bytes=${fiveGiB + 64}-${fiveGiB + 65}`, 'bytes=9007199254740992-9007199254740993']) {
      const bad = await http(url, { Range: range }); assert.equal(bad.status, 416, range);
    }
    const fullBound = await http(url, { Range: `bytes=0-${MAX_RANGE_BYTES - 1}` });
    assert.equal(fullBound.status, 206); assert.equal(fullBound.data.length, MAX_RANGE_BYTES);
    const changed = await open(f.path, 'r+');
    try { await changed.write(new Uint8Array([55]), 0, 1, 2); } finally { await changed.close(); }
    const stale = await http(url, { Range: 'bytes=0-3' }); assert.equal(stale.status, 409);
    const current = await http(new URL('api/model', server.url).href, { Range: 'bytes=0-3' }); assert.equal(current.status, 206);
    const injected = new URL('api/model?path=/never/authorized.ply', server.url);
    const stillSelected = await http(injected.href, { Range: `bytes=${fiveGiB + 12}-${fiveGiB + 15}` });
    assert.deepEqual([...stillSelected.data], [17, 29, 41, 53]);
  } finally { await server.close(); await f.cleanup(); }
});
