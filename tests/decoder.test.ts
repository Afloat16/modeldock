import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { decodeModel, type OcctFactory, type OcctModule } from '../src/core/index';

const require = createRequire(import.meta.url);
const encode = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
async function fixture(name: string): Promise<ArrayBuffer> {
  const bytes = await readFile(new URL(`../fixtures/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
const pointHeader = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n';
const points = '0 0 0\n2 0 0\n0 3 0\n';
function bounds(positions: Float32Array): number[] {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) { min[i % 3] = Math.min(min[i % 3], positions[i]); max[i % 3] = Math.max(max[i % 3], positions[i]); }
  return max.map((value, i) => value - min[i]);
}

test('PLY vertex count divisible by three remains a point cloud without faces', () => {
  const model = decodeModel(encode(pointHeader + 'end_header\n' + points), 'sample.PLY');
  assert.equal(model.primitives[0].mode, 'points');
  assert.equal(model.primitives[0].indices, undefined);
  assert.deepEqual(bounds(model.primitives[0].positions), [2, 3, 0]);
});

test('PLY mesh versus point-cloud fixtures preserve vertex colours', async () => {
  const pointModel = decodeModel(await fixture('colored-points.ply'), 'scan.ply');
  const meshModel = decodeModel(await fixture('colored-mesh.ply'), 'scan.ply');
  assert.equal(pointModel.primitives[0].positions.length / 3, 2048);
  assert.equal(pointModel.primitives[0].mode, 'points');
  assert.equal(meshModel.primitives[0].mode, 'triangles');
  assert.equal(meshModel.primitives[0].indices!.length / 3, 4096);
  assert.ok(meshModel.primitives[0].colors?.length);
});

for (const endian of ['little', 'big']) test(`PLY binary ${endian} endian coordinates, colours and face indices`, async () => {
  const model = decodeModel(await fixture(`triangle-${endian}.ply`), 'triangle.ply');
  assert.deepEqual([...model.primitives[0].positions], [0, 0, 0, 2, 0, 0, 0, 3, 0]);
  assert.deepEqual([...model.primitives[0].indices!], [0, 1, 2]);
  assert.deepEqual([...model.primitives[0].colors!], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('PLY concave polygons are triangulated into the expected area', () => {
  const ply = 'ply\nformat ascii 1.0\nelement vertex 5\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n2 0 0\n2 2 0\n1 1 0\n0 2 0\n5 0 1 2 3 4\n';
  const primitive = decodeModel(encode(ply), 'concave.ply').primitives[0];
  assert.equal(primitive.indices!.length, 9);
  let area = 0;
  for (let i = 0; i < primitive.indices!.length; i += 3) {
    const [a, b, c] = [...primitive.indices!.slice(i, i + 3)].map(index => index * 3);
    const p = primitive.positions;
    area += Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) / 2;
  }
  assert.equal(area, 3);
});

test('PLY unknown elements and list properties do not shift the vertex stream', () => {
  const ply = 'ply\nformat ascii 1.0\nelement metadata 1\nproperty list uchar float values\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n4 4 3 2 1\n3 4 5\n';
  assert.deepEqual([...decodeModel(encode(ply), 'extra.ply').primitives[0].positions], [3, 4, 5]);
});

test('PLY Gaussian data is explicitly presented as point centres', () => {
  const ply = 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nproperty float opacity\nend_header\n0 0 0 0 0 0 1\n';
  const model = decodeModel(encode(ply), 'gaussians.ply');
  assert.equal(model.primitives[0].mode, 'points');
  assert.match(model.warnings[0], /point centres/);
  assert.ok(Math.abs(model.primitives[0].colors![0] - 0.21404114) < 1e-6);
});

test('PLY refuses truncated buffers, invalid coordinates, bad indices and oversized declarations', async () => {
  const binary = await fixture('triangle-little.ply');
  assert.throws(() => decodeModel(binary.slice(0, -2), 'bad.ply'), /truncated/);
  assert.throws(() => decodeModel(encode(pointHeader + 'end_header\nnan 0 0\n2 0 0\n0 3 0\n'), 'bad.ply'), /non-finite/);
  assert.throws(() => decodeModel(encode(pointHeader + 'element face 1\nproperty list uchar int vertex_indices\nend_header\n' + points + '3 0 1 9\n'), 'bad.ply'), /outside/);
  assert.throws(() => decodeModel(encode(pointHeader + 'end_header\n' + points), 'big.ply', { maxVertices: 2 }), /limit/);
  assert.throws(() => decodeModel(encode(pointHeader + 'element face 1\nproperty uchar material\nend_header\n' + points + '0\n'), 'bad.ply'), /vertex_indices/);
});

for (const encoding of ['ascii', 'binary']) test(`STL ${encoding} fixture has one correctly sized triangle`, async () => {
  const primitive = decodeModel(await fixture(`triangle-${encoding}.stl`), 'triangle.stl').primitives[0];
  assert.equal(primitive.mode, 'triangles');
  assert.equal(primitive.positions.length, 9);
  assert.deepEqual(bounds(primitive.positions), [2, 3, 0]);
});

test('STL partial ASCII facets and malicious binary counts fail', async () => {
  const data = new TextDecoder().decode(await fixture('triangle-ascii.stl')).replace('endsolid triangle', 'facet normal 0 0 1\nendsolid triangle');
  assert.throws(() => decodeModel(encode(data), 'bad.stl'), /malformed|truncated/);
  const binary = await fixture('triangle-binary.stl');
  new DataView(binary).setUint32(80, 0xffffffff, true);
  assert.throws(() => decodeModel(binary, 'bad.stl'));
});

test('STL exporters that write zero normals leave them for renderer recomputation', async () => {
  const binary = await fixture('triangle-binary.stl');
  new DataView(binary).setFloat32(92, 0, true);
  assert.equal(decodeModel(binary, 'zero-normals.stl').primitives[0].normals, undefined);
});

test('OBJ negative indices and groups work; texture paths are never fetched', () => {
  const obj = 'mtllib ../../private.mtl\no Part A\nv 0 0 0\nv 2 0 0\nv 0 3 0\nvn 0 0 1\nf -3//1 -2//1 -1//1\n';
  const model = decodeModel(encode(obj), 'part.obj');
  assert.equal(model.primitives[0].name, 'Part A');
  assert.deepEqual(bounds(model.primitives[0].positions), [2, 3, 0]);
  assert.deepEqual([...model.primitives[0].normals!], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.match(model.warnings.join(' '), /external textures are not loaded/);
  assert.throws(() => decodeModel(encode('v 0 0 0\nf 0 1 2\n'), 'bad.obj'), /index/);
});

test('OBJ pyramid, lines and points retain their primitive types', async () => {
  const pyramid = decodeModel(await fixture('pyramid.obj'), 'pyramid.obj');
  assert.equal(pyramid.primitives[0].positions.length / 9, 6);
  const mixed = decodeModel(encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nl 1 2 3\np 1\n'), 'mixed.obj');
  assert.deepEqual(mixed.primitives.map(p => p.mode), ['lines', 'points']);
});

test('OFF topology and XYZ coloured points load with known bounds', async () => {
  const off = decodeModel(await fixture('triangle.off'), 'triangle.off');
  assert.deepEqual([...off.primitives[0].indices!], [0, 1, 2]);
  const xyz = decodeModel(await fixture('points.xyz'), 'points.xyz');
  assert.equal(xyz.primitives[0].mode, 'points');
  assert.deepEqual([...xyz.primitives[0].colors!], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.throws(() => decodeModel(encode('0 0 nan\n'), 'bad.xyz'), /non-finite/);
});

test('PCD ASCII packed RGB preserves points and colours', async () => {
  const model = decodeModel(await fixture('points.pcd'), 'points.pcd');
  assert.deepEqual(bounds(model.primitives[0].positions), [2, 3, 0]);
  assert.deepEqual([...model.primitives[0].colors!], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

function pcdBinary(compressed: boolean): ArrayBuffer {
  const header = encode('VERSION 0.7\nFIELDS x y z rgb\nSIZE 4 4 4 4\nTYPE F F F U\nCOUNT 1 1 1 1\nWIDTH 2\nHEIGHT 1\nPOINTS 2\nDATA ' + (compressed ? 'binary_compressed' : 'binary') + '\n');
  const raw = new ArrayBuffer(32), data = new DataView(raw);
  if (compressed) {
    [1, 4, 2, 5, 3, 6].forEach((v, i) => data.setFloat32(i * 4, v, true));
    data.setUint32(24, 0xff0000, true); data.setUint32(28, 0x00ff00, true);
  } else for (const [i, value] of [1, 2, 3, 0, 4, 5, 6, 0].entries()) data.setFloat32(i * 4, value, true);
  if (!compressed) { data.setUint32(12, 0xff0000, true); data.setUint32(28, 0x00ff00, true); }
  let payload = new Uint8Array(raw);
  if (compressed) {
    payload = new Uint8Array(8 + 1 + 32);
    const lengths = new DataView(payload.buffer); lengths.setUint32(0, 33, true); lengths.setUint32(4, 32, true);
    payload[8] = 31; payload.set(new Uint8Array(raw), 9);
  }
  const result = new Uint8Array(header.byteLength + payload.length);
  result.set(new Uint8Array(header)); result.set(payload, header.byteLength);
  return result.buffer;
}
for (const compressed of [false, true]) test(`PCD ${compressed ? 'binary_compressed' : 'binary'} record layout is decoded correctly`, () => {
  const p = decodeModel(pcdBinary(compressed), 'scan.pcd').primitives[0];
  assert.deepEqual([...p.positions], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...p.colors!], [1, 0, 0, 0, 1, 0]);
});

test('PCD rejects an oversized decompression declaration before allocation', () => {
  const bytes = pcdBinary(true);
  const headerEnd = new TextDecoder().decode(bytes).indexOf('DATA binary_compressed\n') + 'DATA binary_compressed\n'.length;
  new DataView(bytes).setUint32(headerEnd + 4, 0xffffffff, true);
  assert.throws(() => decodeModel(bytes, 'attack.pcd'), /lengths/);
});

test('PCD binary packed float RGBA retains colour bits even in NaN bit patterns', () => {
  const header = new TextEncoder().encode('FIELDS x y z rgba\nSIZE 4 4 4 4\nTYPE F F F F\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n');
  const buffer = new ArrayBuffer(header.length + 16);
  new Uint8Array(buffer).set(header);
  new DataView(buffer).setUint32(header.length + 12, 0xffff1234, true);
  const p = decodeModel(buffer, 'rgba.pcd').primitives[0];
  assert.equal(p.colors![0], 1);
  assert.ok(p.colors![1] > 0 && p.colors![1] < 0.01);
  assert.ok(p.colors![2] > p.colors![1]);
});

test('original arch demos load as distinct cloud and mesh representations', async () => {
  const cloud = decodeModel(await fixture('demo-arch-cloud.ply'), 'arch.ply').primitives[0];
  const mesh = decodeModel(await fixture('demo-arch-mesh.ply'), 'arch.ply').primitives[0];
  assert.equal(cloud.mode, 'points');
  assert.equal(cloud.positions.length / 3, 48_000);
  assert.equal(mesh.mode, 'triangles');
  assert.equal(mesh.indices!.length / 3, 12_156);
  assert.ok(bounds(cloud.positions).every((value, i) => Math.abs(value - [5.55, 3.96, 3.075][i]) < 0.03));
});

let occt: Promise<OcctModule> | undefined;
function kernel(): Promise<OcctModule> {
  return occt ??= (require('occt-import-js') as OcctFactory)({ print: () => {}, printErr: () => {} });
}
for (const format of ['step', 'iges', 'brep']) test(`real OpenCascade ${format.toUpperCase()} import recovers the 20 × 15 × 10 cube`, async () => {
  const model = decodeModel(await fixture(`cube.${format}`), `cube.${format}`, {}, await kernel());
  assert.equal(model.units, format === 'brep' ? 'model units' : 'mm');
  const positions = new Float32Array(model.primitives.flatMap(p => [...p.positions]));
  assert.deepEqual(bounds(positions), [20, 15, 10]);
  assert.equal(model.primitives.reduce((n, p) => n + (p.indices?.length ?? 0) / 3, 0), 12);
});

test('CAD smooth bored mounting bracket is actually tessellated and bounded', async () => {
  const model = decodeModel(await fixture('mounting-bracket.step'), 'bracket.step', {}, await kernel());
  const triangleCount = model.primitives.reduce((n, p) => n + (p.indices?.length ?? 0) / 3, 0);
  assert.ok(triangleCount > 100);
  const positions = new Float32Array(model.primitives.flatMap(p => [...p.positions]));
  const dimensions = bounds(positions);
  assert.ok(dimensions.every((d, i) => Math.abs(d - [64, 42, 28][i]) < 0.001));
});

test('CAD reports missing kernel and enforces decoded mesh limits', async () => {
  const bytes = await fixture('cube.step');
  assert.throws(() => decodeModel(bytes, 'cube.step'), /CAD decoder is not ready/);
  const module = await kernel();
  assert.throws(() => decodeModel(bytes, 'cube.step', { maxTriangles: 1 }, module), /geometry limit/);
});

test('empty, unsupported and invalid limit requests fail clearly', () => {
  assert.throws(() => decodeModel(new ArrayBuffer(0), 'empty.ply'), /empty/);
  assert.throws(() => decodeModel(encode('dummy'), 'drawing.dwg'), /Unsupported/);
  assert.throws(() => decodeModel(encode(pointHeader + 'end_header\n' + points), 'scan.ply', { maxVertices: Infinity }), /integer/);
});
