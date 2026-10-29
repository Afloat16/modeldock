import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { inspectGltf, loadGltf } from '../src/viewer/gltf';
import { DEFAULT_LIMITS } from '../src/shared/types';

// Three's browser FileLoader uses ProgressEvent even for embedded data URLs.
if (!globalThis.ProgressEvent) {
  Object.defineProperty(globalThis, 'ProgressEvent', { configurable: true, value: class extends Event {
    loaded: number; total: number; lengthComputable: boolean;
    constructor(type: string, init: ProgressEventInit = {}) { super(type); this.loaded = init.loaded ?? 0; this.total = init.total ?? 0; this.lengthComputable = init.lengthComputable ?? false; }
  } });
}
const limits = { ...DEFAULT_LIMITS, maxVertices: 100, maxTriangles: 100, maxFileBytes: 64 * 1024 };
const encode = (value: object): ArrayBuffer => new TextEncoder().encode(JSON.stringify(value)).buffer;

function triangle() {
  const bytes = new Uint8Array(44);
  new Float32Array(bytes.buffer, 0, 9).set([0, 0, 0, 2, 0, 0, 0, 3, 0]);
  new Uint16Array(bytes.buffer, 36, 3).set([0, 1, 2]);
  const json: Record<string, any> = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 42, uri: `data:application/octet-stream;base64,${Buffer.from(bytes.subarray(0, 42)).toString('base64')}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 3, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
  return { bytes, json };
}
function glb(json: Record<string, any>, binary: Uint8Array, extra = new Uint8Array()): ArrayBuffer {
  const copy = structuredClone(json); delete copy.buffers[0].uri;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(copy));
  const jsonLength = Math.ceil(jsonBytes.length / 4) * 4;
  const binaryLength = Math.ceil(binary.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength + extra.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + jsonLength); bytes.set(jsonBytes, 20);
  view.setUint32(20 + jsonLength, binaryLength, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  bytes.set(binary, 28 + jsonLength); bytes.set(extra, 28 + jsonLength + binaryLength);
  return bytes.buffer;
}
function dispose(object: THREE.Object3D): void {
  object.traverse(node => {
    const item = node as THREE.Mesh;
    item.geometry?.dispose();
    if (item.material) for (const material of Array.isArray(item.material) ? item.material : [item.material]) material.dispose();
  });
}

test('self-contained glTF and GLB render the same indexed geometry in metres', async () => {
  const { json, bytes } = triangle();
  for (const data of [encode(json), glb(json, bytes)]) {
    const result = await loadGltf(data, limits);
    let mesh: THREE.Mesh | undefined;
    result.object.traverse(node => { if ((node as THREE.Mesh).isMesh) mesh = node as THREE.Mesh; });
    assert.ok(mesh);
    assert.equal(mesh.geometry.getAttribute('position').count, 3);
    assert.deepEqual(Array.from(mesh.geometry.index!.array), [0, 1, 2]);
    assert.deepEqual(mesh.geometry.boundingBox!.max.toArray(), [2, 3, 0]);
    assert.equal(result.units, 'm');
    dispose(result.object);
  }
});

test('embedded buffers use local blob fetches and revoke those URLs after parsing', async () => {
  const { json } = triangle();
  const originalFetch = globalThis.fetch, originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const fetched: string[] = [], created: string[] = [], revoked: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(input instanceof Request ? input.url : String(input));
    return originalFetch(input, init);
  }) as typeof fetch;
  URL.createObjectURL = blob => { const url = originalCreate(blob); created.push(url); return url; };
  URL.revokeObjectURL = url => { revoked.push(url); originalRevoke(url); };
  try {
    const result = await loadGltf(encode(json), limits);
    assert.ok(fetched.length > 0);
    assert.ok(fetched.every(url => url.startsWith('blob:')));
    assert.deepEqual(revoked, created);
    dispose(result.object);
  } finally { globalThis.fetch = originalFetch; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
});

test('glTF external URLs and traversal are refused before any fetch', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = ((..._args: unknown[]) => { requests++; throw new Error('Unexpected network request'); }) as typeof fetch;
  try {
    for (const uri of ['https://evil.example/private', 'http://127.0.0.1:9000/secret', '//evil.example/buffer', 'file:///etc/passwd', '../private.bin', '/private.bin', 'blob:http://local/unknown', 'javascript:alert(1)']) {
      const { json } = triangle(); json.buffers[0].uri = uri;
      await assert.rejects(loadGltf(encode(json), limits), /External glTF/);
      const { json: imageJson } = triangle(); imageJson.images = [{ uri }];
      assert.throws(() => inspectGltf(encode(imageJson), limits), /External glTF/);
    }
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('glTF byte caps apply to source bytes, declared buffers and decoded accessors', () => {
  const { json } = triangle(); const data = encode(json);
  assert.throws(() => inspectGltf(data, { ...limits, maxFileBytes: data.byteLength - 1 }), /byte limit/);
  const hugeBuffer = structuredClone(json); hugeBuffer.buffers[0].byteLength = 2 ** 31;
  assert.throws(() => inspectGltf(encode(hugeBuffer), limits), /buffer byte length/);
  const hugeAccessor = structuredClone(json); hugeAccessor.accessors[0] = { componentType: 5126, count: 100_000_000, type: 'VEC3' };
  assert.throws(() => inspectGltf(encode(hugeAccessor), limits), /byte budget/);
  const shortData = structuredClone(json); shortData.buffers[0].uri = 'data:application/octet-stream;base64,AA==';
  assert.throws(() => inspectGltf(encode(shortData), limits), /buffer length/);
});

test('sparse/zero-filled accessors and repeated mesh nodes obey geometry caps before allocation', () => {
  const { json } = triangle();
  const sparse = structuredClone(json); sparse.accessors[0] = { componentType: 5126, count: 30, type: 'VEC3' };
  delete sparse.meshes[0].primitives[0].indices; sparse.meshes[0].primitives[0].mode = 0;
  assert.throws(() => inspectGltf(encode(sparse), { ...limits, maxVertices: 5 }), /geometry budget/);
  const repeated = structuredClone(json); repeated.nodes.push({ mesh: 0 }); repeated.scenes[0].nodes.push(1);
  assert.throws(() => inspectGltf(encode(repeated), { ...limits, maxVertices: 5 }), /scene geometry budget/);
  assert.throws(() => inspectGltf(encode(json), { ...limits, maxTriangles: 0 }), /geometry budget/);
});

test('GLB inspection rejects truncated chunks, duplicate chunks and invalid headers', () => {
  const { json, bytes } = triangle(); const valid = glb(json, bytes);
  assert.throws(() => inspectGltf(valid.slice(0, -1), limits), /header|truncated/);
  const truncated = valid.slice(0); new DataView(truncated).setUint32(12, truncated.byteLength, true);
  assert.throws(() => inspectGltf(truncated, limits), /chunk length/);
  const wrongType = valid.slice(0); new DataView(wrongType).setUint32(16, 0x004e4942, true);
  assert.throws(() => inspectGltf(wrongType, limits), /first GLB chunk/);
  const wrongVersion = valid.slice(0); new DataView(wrongVersion).setUint32(4, 1, true);
  assert.throws(() => inspectGltf(wrongVersion, limits), /header/);
  const duplicateBin = new Uint8Array(8); new DataView(duplicateBin.buffer).setUint32(4, 0x004e4942, true);
  assert.throws(() => inspectGltf(glb(json, bytes, duplicateBin), limits), /Duplicate GLB binary/);
  const trailing = glb(json, bytes, new Uint8Array(4));
  assert.throws(() => inspectGltf(trailing, limits), /chunk header/);
});

test('malformed view/accessor/sparse byte ranges are rejected before decoding', () => {
  const { json } = triangle();
  const outside = structuredClone(json); outside.bufferViews[0].byteLength = 100;
  assert.throws(() => inspectGltf(encode(outside), limits), /buffer view exceeds/);
  const accessor = structuredClone(json); accessor.accessors[0].byteOffset = 4;
  assert.throws(() => inspectGltf(encode(accessor), limits), /accessor byte range/);
  const sparse = structuredClone(json); sparse.accessors[0].sparse = { count: 4, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 0 } };
  assert.throws(() => inspectGltf(encode(sparse), limits), /sparse accessor count/);
  const invalidIndex = structuredClone(json); invalidIndex.accessors[1].componentType = 5126;
  assert.throws(() => inspectGltf(encode(invalidIndex), limits), /byte range|index accessor/);
});

test('cyclic, deep and malformed node graphs are refused before upstream recursion', () => {
  const { json } = triangle();
  const cycle = structuredClone(json); cycle.nodes[0].children = [0];
  assert.throws(() => inspectGltf(encode(cycle), limits), /cycle/);
  const deep = structuredClone(json); deep.nodes = Array.from({ length: 260 }, (_, index) => index === 259 ? { mesh: 0 } : { children: [index + 1] });
  assert.throws(() => inspectGltf(encode(deep), limits), /too deep/);
  const multiParent = structuredClone(json); multiParent.nodes = [{ children: [2] }, { children: [2] }, { mesh: 0 }]; multiParent.scenes[0].nodes = [0, 1];
  assert.throws(() => inspectGltf(encode(multiParent), limits), /more than one parent/);
});

test('post-decode validation rejects non-finite coordinates and disposes allocated geometry', async () => {
  const { json, bytes } = triangle(); new Float32Array(bytes.buffer)[0] = NaN;
  json.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(bytes.subarray(0, 42)).toString('base64')}`;
  const original = THREE.BufferGeometry.prototype.dispose; let disposals = 0;
  THREE.BufferGeometry.prototype.dispose = function () { disposals++; original.call(this); };
  try {
    await assert.rejects(loadGltf(encode(json), limits), /non-finite coordinates/);
    assert.ok(disposals > 0);
  } finally { THREE.BufferGeometry.prototype.dispose = original; }
});

test('untrusted bounding-box metadata is recomputed and world overflow rejected', async () => {
  const { json } = triangle(); json.accessors[0].max = [0, 0, 0];
  const result = await loadGltf(encode(json), limits);
  const bounds = new THREE.Box3().setFromObject(result.object);
  assert.deepEqual(bounds.max.toArray(), [2, 3, 0]); dispose(result.object);
  json.nodes[0].scale = [1e308, 1, 1];
  await assert.rejects(loadGltf(encode(json), limits), /non-finite world/);
});

test('decoded indices cannot reference missing vertices', async () => {
  const { json, bytes } = triangle();
  new Uint16Array(bytes.buffer, 36, 3)[2] = 99;
  json.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(bytes.subarray(0, 42)).toString('base64')}`;
  await assert.rejects(loadGltf(encode(json), limits), /index is out of range/);
});

test('unsupported compressed and GPU-instanced features fail explicitly', () => {
  for (const extension of ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu', 'EXT_mesh_gpu_instancing']) {
    const { json } = triangle(); json.extensionsRequired = [extension];
    assert.throws(() => inspectGltf(encode(json), limits), /not bundled/);
  }
});
