import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadLargeModel, sourceFromBlob, sourceFromHttp, sampleWindows, type RandomAccessSource } from '../src/large/index';

const GiB = 1024 ** 3;
const encode = (text: string) => new TextEncoder().encode(text);

/** A >5 GiB logical source with real coordinates generated only for requested ranges. */
function hugePly(bigEndian = false, extraHeader = ''): RandomAccessSource & { reads: [number, number][]; count: number; header: Uint8Array } {
  const count = Math.ceil(5 * GiB / 24) + 1;
  const header = encode(`ply\nformat binary_${bigEndian ? 'big' : 'little'}_endian 1.0\nelement vertex ${count}\nproperty double x\nproperty double y\nproperty double z\n${extraHeader}end_header\n`);
  const reads: [number, number][] = [];
  return { name: 'survey.ply', size: header.length + count * 24, reads, count, header,
    async read(offset, length, signal) {
      signal?.throwIfAborted(); reads.push([offset, length]);
      const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
      if (offset < header.length) bytes.set(header.subarray(offset, Math.min(header.length, offset + length)));
      const first = Math.max(0, Math.floor((offset - header.length) / 24));
      const last = Math.min(count, Math.ceil((offset + length - header.length) / 24));
      for (let row = first; row < last; row++) {
        const record = new Uint8Array(24), data = new DataView(record.buffer);
        // Millimetre details at a trillion-unit origin survive subtraction before Float32.
        data.setFloat64(0, 1e12 + row * 0.125, !bigEndian);
        data.setFloat64(8, 2e12 + row % 101 * 0.25, !bigEndian);
        data.setFloat64(16, -3e12 + row % 53 * 0.5, !bigEndian);
        const at = header.length + row * 24 - offset;
        if (at >= 0 && at + 24 <= length) bytes.set(record, at);
        else for (let k = 0; k < 24; k++) if (at + k >= 0 && at + k < length) view.setUint8(at + k, record[k]);
      }
      return bytes;
    },
  };
}

for (const big of [false, true]) test(`>5 GiB binary PLY ${big ? 'BE' : 'LE'} preview uses bounded ranges above 4 GiB and preserves origin`, async () => {
  const source = hugePly(big);
  const model = await loadLargeModel(source, { maxPoints: 9, maxReadBytes: 65536, chunkBytes: 4096 });
  assert(source.size > 5 * GiB);
  assert.equal(model.preview.sampledVertices, 9);
  assert.equal(model.preview.originalVertices, source.count);
  assert.equal(model.preview.representation, 'points');
  assert.equal(model.preview.fullyValidated, false);
  assert.equal(model.preview.sampling, 'stratified-blocks');
  assert.deepEqual(model.origin, [1e12, 2e12, -3e12]);
  assert.deepEqual(model.preview.origin, model.origin);
  const rows = sampleWindows(source.count, 9).map(w => w.start);
  assert.equal(rows[0], 0); assert.equal(rows.at(-1), source.count - 1);
  assert(Math.abs(rows[4] / source.count - 0.5) < 1e-6);
  const p = model.primitives[0].positions;
  assert.equal(p[0], 0);
  assert.equal(p[4], (rows[1] % 101) * 0.25);
  assert.equal(p.at(-3), Math.fround((source.count - 1) * 0.125));
  assert(source.reads.some(([at]) => at > 4 * GiB));
  assert(source.reads.some(([at]) => at > 2 * GiB && at < 3 * GiB));
  assert.equal(model.preview.readBytes, source.reads.reduce((sum, [, count]) => sum + count, 0));
  assert(model.preview.readBytes < 65536);
  assert(model.preview.maxReadChunkBytes <= 4096);
  assert.match(model.warnings.join(' '), /retained samples only/);
});

test('PLY mesh topology is explicitly unavailable rather than misrepresented as a full mesh', async () => {
  const source = hugePly(false, 'element face 1\nproperty list uchar int vertex_indices\n');
  source.size += 13;
  const model = await loadLargeModel(source, { maxPoints: 3 });
  assert.equal(model.primitives[0].mode, 'points');
  assert.equal(model.preview.topologyOmitted, true);
  assert.equal(model.preview.originalFaces, 1);
  assert.equal(model.preview.originalTriangles, undefined);
  assert.equal(model.preview.sampledTriangles, 0);
  assert.match(model.warnings.join(' '), /Surface topology unavailable/);
});

function hugeStl(): RandomAccessSource & { count: number; reads: [number, number][] } {
  const count = Math.ceil(5 * GiB / 50), reads: [number, number][] = [];
  return { name: 'terrain.stl', size: 84 + count * 50, count, reads,
    async read(offset, length) {
      reads.push([offset, length]);
      const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
      if (offset === 0) { view.setUint32(80, count, true); return bytes; }
      assert.equal((offset - 84) % 50, 0); assert.equal(length % 50, 0);
      const first = (offset - 84) / 50;
      for (let i = 0; i < length / 50; i++) {
        view.setFloat32(i * 50 + 8, 1, true);
        const coords = [first + i, 0, 0, first + i, 2, 0, first + i, 0, 3];
        coords.forEach((value, k) => view.setFloat32(i * 50 + 12 + k * 4, value, true));
      }
      return bytes;
    } };
}

test('>5 GiB binary STL retains sampled beginning/middle/end surface triangles with bounded memory', async () => {
  const source = hugeStl();
  const model = await loadLargeModel(source, { maxTriangles: 5, maxReadBytes: 1000, chunkBytes: 100 });
  assert(source.size > 5 * GiB);
  assert.equal(model.primitives[0].mode, 'triangles');
  assert.equal(model.primitives[0].positions.length, 45);
  assert.equal(model.preview.sampledTriangles, 5);
  assert.equal(model.preview.originalTriangles, source.count);
  assert.equal(model.preview.coverage, 5 / source.count);
  assert.equal(model.preview.readBytes, 334);
  assert(source.reads.some(([at]) => at > 4 * GiB));
  assert(source.reads.some(([at]) => at > 2 * GiB && at < 3 * GiB));
  assert.match(model.warnings.join(' '), /do not form a closed surface/);
});

test('memory and I/O budgets constrain retained geometry independently of logical source size', async () => {
  const model = await loadLargeModel(hugeStl(), { maxTriangles: 10000, maxOutputBytes: 144, maxReadBytes: 200, chunkBytes: 100 });
  assert.equal(model.preview.sampledTriangles, 2);
  assert.equal(model.preview.readBytes, 184);
  assert.equal(model.primitives[0].positions.byteLength + model.primitives[0].normals!.byteLength, 144);
  await assert.rejects(loadLargeModel(hugeStl(), { maxOutputBytes: 1 }), /one STL triangle/);
  await assert.rejects(loadLargeModel(hugeStl(), { maxTriangles: Infinity }), /safe integer/);
  await assert.rejects(loadLargeModel(hugeStl(), { chunkBytes: 32 * 1024 ** 2 }), /16 MiB/);
});

test('cancellation before and during geometry stops further reads', async () => {
  const source = hugePly(), cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(loadLargeModel(source, { signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(source.reads.length, 0);
  const controller = new AbortController();
  await assert.rejects(loadLargeModel(source, { maxPoints: 100, signal: controller.signal, onProgress(progress) {
    if (progress.phase === 'geometry') controller.abort();
  } }), { name: 'AbortError' });
  assert.equal(source.reads.length, 2);
});

test('short reads, truncated STL/PLY, unsafe counts and malformed headers fail before huge allocation', async () => {
  const short = hugeStl(); short.read = async () => new Uint8Array(1);
  await assert.rejects(loadLargeModel(short), /truncated/);
  const truncated = hugeStl(); truncated.size--;
  await assert.rejects(loadLargeModel(truncated), /truncated/);
  const truncatedPly = hugePly(); truncatedPly.size -= 1000;
  await assert.rejects(loadLargeModel(truncatedPly), /truncated/);
  for (const header of [
    'ply\nformat binary_little_endian 1.0\nelement vertex 9007199254740992\nproperty float x\nproperty float y\nproperty float z\nend_header\n',
    'ply\nformat binary_little_endian 1.0\nelement vertex 9007199254740991\nproperty double x\nproperty double y\nproperty double z\nend_header\n',
    'ply\nformat binary_little_endian 1.0\nelement vertex -1\nend_header\n',
    'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty unknown x\nend_header\n',
  ]) await assert.rejects(loadLargeModel(sourceFromBlob(new Blob([header]), 'bad.ply')), /safe integer|invalid count|property/);
  await assert.rejects(loadLargeModel(sourceFromBlob(new Blob(['ply\ncomment ' + 'x'.repeat(2000)]), 'bad.ply'), { maxHeaderBytes: 100 }), /header/);
  await assert.rejects(loadLargeModel({ ...hugePly(), size: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
});

test('unsupported large formats and ASCII do not trigger whole-file reads', async () => {
  const ascii = sourceFromBlob(new Blob(['ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n']), 'ascii.ply');
  await assert.rejects(loadLargeModel(ascii), /conversion to binary/);
  const source = hugePly(); source.name = 'massive.step';
  await assert.rejects(loadLargeModel(source), /out-of-core tessellation/);
  assert.equal(source.reads.length, 0);
});

test('small binary fixtures preserve LE/BE colors and fully validate point clouds', async () => {
  for (const endian of ['little', 'big']) {
    const bytes = await readFile(new URL(`../fixtures/triangle-${endian}.ply`, import.meta.url));
    const model = await loadLargeModel(sourceFromBlob(new Blob([bytes]), 'triangle.ply'));
    assert.deepEqual([...model.primitives[0].colors!], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.equal(model.preview.topologyOmitted, true);
  }
  const source = sourceFromBlob(new Blob([encode('ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n'), new Uint8Array(12)]), 'one.ply');
  const model = await loadLargeModel(source);
  assert.equal(model.preview.fullyValidated, true);
  assert.equal(model.preview.sampling, 'all');
});

test('non-finite retained coordinates fail rather than corrupting GPU buffers', async () => {
  const source = hugeStl(), original = source.read;
  source.read = async (offset, length, signal) => {
    const bytes = await original(offset, length, signal);
    if (offset > 0) new DataView(bytes.buffer).setFloat32(12, NaN, true);
    return bytes;
  };
  await assert.rejects(loadLargeModel(source, { maxTriangles: 1 }), /non-finite/);
});

test('Blob adapter validates safe bounds and propagates cancellation', async () => {
  const source = sourceFromBlob(new Blob(['0123456789']), 'a.ply');
  assert.equal(new TextDecoder().decode(await source.read(5, 3)), '567');
  await assert.rejects(source.read(9, 2), /outside/);
  await assert.rejects(source.read(0.5, 2), /safe integer/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(source.read(0, 1, controller.signal), { name: 'AbortError' });
});

test('HTTP adapter validates 206 and exact ranges above 4 GiB, source identity, and bounded bodies', async () => {
  const requests: string[] = [], size = 6 * GiB;
  const fetcher = (async (_url: string, init?: RequestInit) => {
    const request = new Headers(init?.headers).get('range')!; requests.push(request);
    const [, startText, endText] = /bytes=(\d+)-(\d+)/.exec(request)!;
    const start = Number(startText), end = Number(endText);
    return new Response(new Uint8Array(end - start + 1).fill(42), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1), etag: '"revision1"' } });
  }) as typeof fetch;
  const source = await sourceFromHttp('https://example.com/model.ply', { fetch: fetcher });
  assert.equal(source.size, size);
  assert.deepEqual([...await source.read(5 * GiB + 7, 4)], [42, 42, 42, 42]);
  assert.deepEqual(requests, ['bytes=0-0', `bytes=${5 * GiB + 7}-${5 * GiB + 10}`]);
  for (const [status, contentRange, body, expected] of [
    [200, 'bytes 0-0/10', 'x', /206/],
    [206, 'bytes 1-1/10', 'x', /does not match/],
    [206, 'bytes 0-0/9007199254740992', 'x', /does not match/],
    [206, '', 'x', /Content-Range/],
    [206, 'bytes 0-0/10', 'xx', /exceeds/],
    [206, 'bytes 0-0/10', '', /truncated/],
  ] as const) await assert.rejects(sourceFromHttp('https://example.com/model.ply', { fetch: (async () => new Response(body, { status, headers: { 'content-range': contentRange } })) as typeof fetch }), expected);
  await assert.rejects(sourceFromHttp('https://example.com/model.ply', { size: 1, fetch: fetcher }), /source size/);
  let calls = 0;
  const changed = await sourceFromHttp('https://example.com/model.ply', { fetch: (async () => new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/10', etag: `"${++calls}"` } })) as typeof fetch });
  await assert.rejects(changed.read(0, 1), /changed/);
});

test('sample windows have exact cardinality, no overlap, and include both endpoints', () => {
  for (const total of [1, 2, 3, 129, 1001, 500_000_001]) for (const wanted of [1, 2, 3, 127, 128, 129, 1000]) {
    const retained = Math.min(total, wanted), windows = sampleWindows(total, retained);
    assert.equal(windows.reduce((n, w) => n + w.count, 0), retained);
    assert.equal(windows[0].start, 0);
    if (retained > 1) assert.equal(windows.at(-1)!.start + windows.at(-1)!.count, total);
    windows.forEach((w, i) => { if (i) assert(w.start >= windows[i - 1].start + windows[i - 1].count); });
  }
});
