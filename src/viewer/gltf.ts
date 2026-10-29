import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { DecodeOptions } from '../shared/types';

export type GltfLimits = DecodeOptions & { maxFileBytes?: number };
type Json = Record<string, any>;
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENT_COUNTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const MAX_ITEMS = 100_000;

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Invalid or excessive glTF ${label}.`);
  }
  return value;
}
function array(value: unknown, label: string): any[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`Invalid or excessive glTF ${label}.`);
  return value;
}
function record(value: unknown, label: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid glTF ${label}.`);
  return value as Json;
}
function at(items: any[], index: unknown, label: string): Json {
  const item = items[integer(index, `${label} index`, items.length - 1)];
  return record(item, label);
}
function finiteVector(value: unknown, length: number, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
    throw new Error(`Invalid glTF ${label}.`);
  }
}
function embeddedBytes(uri: unknown, kind: 'buffer' | 'image'): number {
  if (typeof uri !== 'string' || !uri.startsWith('data:')) {
    throw new Error('External glTF buffers/textures are not loaded. Export a self-contained GLB or embed all resources as data URIs.');
  }
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('Invalid embedded glTF data URI.');
  const metadata = uri.slice(5, comma).toLowerCase();
  const mime = metadata.split(';', 1)[0];
  if (kind === 'image' && !/^image\/(png|jpeg|webp|avif)$/.test(mime)) {
    throw new Error('Only embedded PNG, JPEG, WebP and AVIF textures are supported.');
  }
  let payload: string;
  try { payload = decodeURIComponent(uri.slice(comma + 1)); }
  catch { throw new Error('Invalid embedded glTF data URI encoding.'); }
  if (metadata.endsWith(';base64')) {
    payload = payload.replace(/\s/g, '');
    if (payload.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(payload)) throw new Error('Invalid embedded glTF base64 data.');
    return payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
  }
  return new TextEncoder().encode(payload).byteLength;
}

/** Validate sizes and references before GLTFLoader can allocate geometry or fetch data. */
export function inspectGltf(buffer: ArrayBuffer, limits: GltfLimits): Json {
  const maxBytes = limits.maxFileBytes ?? 128 * 1024 * 1024;
  integer(maxBytes, 'byte limit');
  if (buffer.byteLength > maxBytes) throw new Error('glTF file exceeds the configured byte limit.');
  const maxVertices = integer(limits.maxVertices, 'vertex limit');
  const maxTriangles = integer(limits.maxTriangles, 'triangle limit');
  const view = new DataView(buffer);
  let binaryLength: number | undefined;
  let jsonText: string;
  if (buffer.byteLength >= 4 && view.getUint32(0, true) === 0x46546c67) {
    if (buffer.byteLength < 20 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength) {
      throw new Error('Invalid GLB 2.0 header or truncated file.');
    }
    let offset = 12;
    let jsonFound = false;
    jsonText = '';
    while (offset < buffer.byteLength) {
      if (offset + 8 > buffer.byteLength) throw new Error('Truncated GLB chunk header.');
      const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
      if (length % 4 !== 0 || length > buffer.byteLength - offset - 8) throw new Error('Invalid GLB chunk length.');
      if (!jsonFound && type !== 0x4e4f534a) throw new Error('The first GLB chunk must be JSON.');
      if (type === 0x4e4f534a) {
        if (jsonFound) throw new Error('Duplicate GLB JSON chunk.');
        jsonText = new TextDecoder().decode(new Uint8Array(buffer, offset + 8, length)).replace(/\0+$/, '');
        jsonFound = true;
      } else if (type === 0x004e4942) {
        if (binaryLength !== undefined) throw new Error('Duplicate GLB binary chunk.');
        binaryLength = length;
      }
      // Unknown chunks are skipped as required by the glTF 2.0 container spec.
      offset += 8 + length;
    }
    if (!jsonFound) throw new Error('Missing GLB JSON chunk.');
  } else jsonText = new TextDecoder().decode(buffer);
  const json = record(JSON.parse(jsonText), 'document');
  if (json.asset?.version !== '2.0') throw new Error('Only glTF 2.0 / GLB 2.0 is supported.');
  const extensions = new Set<string>();
  for (const extension of [...array(json.extensionsRequired, 'required extensions'), ...array(json.extensionsUsed, 'used extensions')]) {
    if (typeof extension !== 'string') throw new Error('Invalid glTF extension identifier.');
    extensions.add(extension);
  }
  for (const extension of ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu', 'EXT_mesh_gpu_instancing']) {
    if (extensions.has(extension)) throw new Error(`${extension} is not bundled. Export an uncompressed, self-contained GLB with ordinary mesh nodes.`);
  }
  const buffers = array(json.buffers, 'buffers');
  const views = array(json.bufferViews, 'buffer views');
  const accessors = array(json.accessors, 'accessors');
  const meshes = array(json.meshes, 'meshes');
  const nodes = array(json.nodes, 'nodes');
  const scenes = array(json.scenes, 'scenes');
  let totalBufferBytes = 0;
  for (const [index, raw] of buffers.entries()) {
    const item = record(raw, 'buffer');
    const length = integer(item.byteLength, 'buffer byte length', maxBytes);
    totalBufferBytes += length;
    if (totalBufferBytes > maxBytes) throw new Error('glTF buffer byte budget exceeded.');
    let available: number;
    if (item.uri !== undefined) available = embeddedBytes(item.uri, 'buffer');
    else {
      if (index !== 0 || binaryLength === undefined) throw new Error('A glTF buffer is missing its embedded data.');
      available = binaryLength;
    }
    if (available < length || available > maxBytes) throw new Error('Invalid or excessive glTF embedded buffer length.');
  }
  for (const raw of views) {
    const item = record(raw, 'buffer view');
    const owner = at(buffers, item.buffer, 'buffer');
    const offset = integer(item.byteOffset ?? 0, 'buffer view offset');
    const length = integer(item.byteLength, 'buffer view byte length', maxBytes);
    if (offset + length > owner.byteLength) throw new Error('glTF buffer view exceeds its buffer.');
    if (item.byteStride !== undefined) {
      const stride = integer(item.byteStride, 'buffer view stride', 252);
      if (stride < 4 || stride % 4) throw new Error('Invalid glTF buffer view stride.');
    }
  }
  let decodedBytes = 0;
  const decodedByteBudget = Math.min(1024 ** 3, maxBytes * 8);
  function range(viewIndex: unknown, byteOffset: unknown, extent: number, alignment: number, label: string): Json {
    const owner = at(views, viewIndex, `${label} buffer view`);
    const offset = integer(byteOffset ?? 0, `${label} offset`);
    if (offset + extent > owner.byteLength || ((owner.byteOffset ?? 0) + offset) % alignment !== 0) {
      throw new Error(`Invalid glTF ${label} byte range or alignment.`);
    }
    return owner;
  }
  for (const raw of accessors) {
    const item = record(raw, 'accessor');
    const count = integer(item.count, 'accessor count');
    const bytes = COMPONENT_BYTES[item.componentType];
    const components = COMPONENT_COUNTS[item.type];
    if (!bytes || !components) throw new Error('Invalid glTF accessor component type.');
    let elementBytes = bytes * components;
    if (String(item.type).startsWith('MAT')) {
      const width = Number(String(item.type).slice(3));
      elementBytes = Math.ceil(width * bytes / 4) * 4 * width;
    }
    decodedBytes += count * Math.max(elementBytes, components * 4);
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > decodedByteBudget) throw new Error('glTF decoded accessor byte budget exceeded.');
    if (item.bufferView !== undefined) {
      const owner = at(views, item.bufferView, 'accessor buffer view');
      const stride = owner.byteStride ?? elementBytes;
      if (stride < elementBytes) throw new Error('glTF accessor is larger than its byte stride.');
      range(item.bufferView, item.byteOffset, count ? stride * (count - 1) + elementBytes : 0, bytes, 'accessor');
    } else if ((item.byteOffset ?? 0) !== 0) throw new Error('An accessor without a buffer view cannot have a byte offset.');
    if (item.min !== undefined) finiteVector(item.min, components, 'accessor minimum');
    if (item.max !== undefined) finiteVector(item.max, components, 'accessor maximum');
    if (item.sparse !== undefined) {
      const sparse = record(item.sparse, 'sparse accessor');
      const sparseCount = integer(sparse.count, 'sparse accessor count', count);
      const indices = record(sparse.indices, 'sparse indices'), values = record(sparse.values, 'sparse values');
      if (![5121, 5123, 5125].includes(indices.componentType)) throw new Error('Invalid glTF sparse index component type.');
      const indexBytes = COMPONENT_BYTES[indices.componentType];
      const indicesView = range(indices.bufferView, indices.byteOffset, sparseCount * indexBytes, indexBytes, 'sparse indices');
      const valuesView = range(values.bufferView, values.byteOffset, sparseCount * elementBytes, bytes, 'sparse values');
      if (indicesView.byteStride !== undefined || valuesView.byteStride !== undefined) throw new Error('Sparse accessor buffer views cannot have a byte stride.');
    }
  }
  for (const raw of array(json.images, 'images')) {
    const image = record(raw, 'image');
    if (image.uri !== undefined) {
      if (embeddedBytes(image.uri, 'image') > maxBytes) throw new Error('Embedded glTF image exceeds the byte limit.');
    } else {
      at(views, image.bufferView, 'image buffer view');
      if (!/^image\/(png|jpeg|webp|avif)$/.test(image.mimeType ?? '')) throw new Error('Unsupported embedded glTF image MIME type.');
    }
  }
  const costs = meshes.map(raw => {
    const mesh = record(raw, 'mesh');
    let vertices = 0, triangles = 0;
    for (const rawPrimitive of array(mesh.primitives, 'mesh primitives')) {
      const primitive = record(rawPrimitive, 'mesh primitive');
      const attributes = record(primitive.attributes, 'primitive attributes');
      const position = at(accessors, attributes.POSITION, 'POSITION accessor');
      if (position.type !== 'VEC3') throw new Error('glTF POSITION must contain VEC3 values.');
      for (const accessorIndex of Object.values(attributes)) {
        if (at(accessors, accessorIndex, 'vertex attribute').count !== position.count) throw new Error('glTF vertex attribute counts do not match.');
      }
      for (const rawTarget of array(primitive.targets, 'morph targets')) {
        for (const accessorIndex of Object.values(record(rawTarget, 'morph target'))) {
          if (at(accessors, accessorIndex, 'morph attribute').count !== position.count) throw new Error('glTF morph target counts do not match.');
        }
      }
      const mode = primitive.mode === undefined ? 4 : integer(primitive.mode, 'primitive mode', 6);
      let count = position.count;
      if (primitive.indices !== undefined) {
        const indices = at(accessors, primitive.indices, 'index accessor');
        if (indices.type !== 'SCALAR' || ![5121, 5123, 5125].includes(indices.componentType)) throw new Error('Invalid glTF index accessor.');
        count = indices.count;
      }
      if (mode === 4 && count % 3) throw new Error('glTF triangle index count must be divisible by three.');
      vertices += position.count;
      triangles += mode === 4 ? count / 3 : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
      if (vertices > maxVertices || triangles > maxTriangles) throw new Error('glTF primitive geometry budget exceeded before decoding.');
    }
    return { vertices, triangles };
  });
  let sceneVertices = 0, sceneTriangles = 0;
  const parents = new Int32Array(nodes.length).fill(-1);
  for (const [index, raw] of nodes.entries()) {
    const node = record(raw, 'node');
    if (node.extensions?.EXT_mesh_gpu_instancing) throw new Error('EXT_mesh_gpu_instancing is not supported; export ordinary mesh nodes.');
    finiteVector(node.matrix, 16, 'node matrix'); finiteVector(node.translation, 3, 'node translation');
    finiteVector(node.rotation, 4, 'node rotation'); finiteVector(node.scale, 3, 'node scale');
    if (node.mesh !== undefined) {
      const cost = costs[integer(node.mesh, 'mesh index', meshes.length - 1)];
      sceneVertices += cost.vertices; sceneTriangles += cost.triangles;
      if (sceneVertices > maxVertices || sceneTriangles > maxTriangles) throw new Error('glTF scene geometry budget exceeded before decoding.');
    }
    for (const child of array(node.children, 'node children')) {
      integer(child, 'child node index', nodes.length - 1);
      if (parents[child] !== -1) throw new Error('A glTF node cannot have more than one parent.');
      parents[child] = index;
    }
  }
  // Iterative traversal avoids stack overflow while rejecting cyclic/deep trees
  // before the upstream loader recursively constructs them.
  const state = new Uint8Array(nodes.length);
  for (let start = 0; start < nodes.length; start++) {
    if (state[start] === 2) continue;
    const stack: { index: number; leave: boolean; depth: number }[] = [{ index: start, leave: false, depth: 0 }];
    while (stack.length) {
      const next = stack.pop()!;
      if (next.leave) { state[next.index] = 2; continue; }
      if (state[next.index] === 1) throw new Error('glTF node graph contains a cycle.');
      if (state[next.index] === 2) continue;
      if (next.depth > 256) throw new Error('glTF node hierarchy is too deep.');
      state[next.index] = 1;
      stack.push({ ...next, leave: true });
      for (const child of nodes[next.index].children ?? []) stack.push({ index: child, leave: false, depth: next.depth + 1 });
    }
  }
  for (const raw of scenes) for (const index of array(record(raw, 'scene').nodes, 'scene roots')) {
    integer(index, 'scene root index', nodes.length - 1);
    if (parents[index] !== -1) throw new Error('A glTF scene root cannot also be a child node.');
  }
  if (json.scene !== undefined) integer(json.scene, 'default scene index', scenes.length - 1);
  return json;
}

function disposeGltfObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse(node => {
    const object = node as THREE.Mesh;
    if (object.geometry) geometries.add(object.geometry);
    if (object.material) for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  textures.forEach(texture => texture.dispose());
  materials.forEach(material => material.dispose());
  geometries.forEach(geometry => geometry.dispose());
}

export async function loadGltf(buffer: ArrayBuffer, limits: GltfLimits): Promise<{ object: THREE.Object3D; warnings: string[]; units: string }> {
  const json = inspectGltf(buffer, limits);
  const manager = new THREE.LoadingManager();
  const embeddedUrls = new Map<string, string>();
  manager.setURLModifier(url => {
    if (url.startsWith('blob:')) return url;
    if (!url.startsWith('data:')) throw new Error('External model resources are disabled.');
    const previous = embeddedUrls.get(url);
    if (previous) return previous;
    // FileLoader fetches embedded buffer URIs. Turn them into local blobs so
    // strict host CSPs need only connect-src blob:, without enabling data: fetch.
    const comma = url.indexOf(',');
    const metadata = url.slice(5, comma);
    const payload = decodeURIComponent(url.slice(comma + 1));
    let bytes: Uint8Array<ArrayBuffer>;
    if (metadata.toLowerCase().endsWith(';base64')) {
      const decoded = atob(payload.replace(/\s/g, ''));
      bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
    } else bytes = new TextEncoder().encode(payload);
    const blob = URL.createObjectURL(new Blob([bytes], { type: metadata.split(';', 1)[0] || 'application/octet-stream' }));
    embeddedUrls.set(url, blob);
    return blob;
  });
  const loader = new GLTFLoader(manager);
  let gltf;
  try { gltf = await loader.parseAsync(buffer, ''); }
  finally { for (const url of embeddedUrls.values()) URL.revokeObjectURL(url); }
  if (!gltf.scene) throw new Error('No displayable scene in this glTF.');
  try {
    let vertices = 0, triangles = 0;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse(node => {
      if (!node.matrixWorld.elements.every(Number.isFinite)) throw new Error('glTF contains a non-finite world transform.');
      const object = node as THREE.Mesh;
      if (!object.geometry) return;
      const position = object.geometry.getAttribute('position');
      if (!position) return;
      vertices += position.count;
      if (object.isMesh) triangles += (object.geometry.index?.count ?? position.count) / 3;
      if (vertices > limits.maxVertices || triangles > limits.maxTriangles) throw new Error('Decoded glTF geometry exceeds the configured limit.');
      for (let i = 0; i < position.count; i++) {
        if (!Number.isFinite(position.getX(i)) || !Number.isFinite(position.getY(i)) || !Number.isFinite(position.getZ(i))) throw new Error('glTF contains non-finite coordinates.');
      }
      const index = object.geometry.index;
      if (index) for (let i = 0; i < index.count; i++) if (index.getX(i) >= position.count) throw new Error('glTF index is out of range.');
      // Do not trust accessor min/max as an authoritative bounding box.
      object.geometry.computeBoundingBox(); object.geometry.computeBoundingSphere();
    });
    if (!vertices) throw new Error('No displayable geometry in this glTF scene.');
    const bounds = new THREE.Box3().setFromObject(gltf.scene);
    if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) throw new Error('glTF contains non-finite world bounds.');
    const warnings: string[] = [];
    if (gltf.animations.length) warnings.push('Animations are shown in their initial pose.');
    if (json.extensionsUsed?.includes('KHR_materials_variants')) warnings.push('The default material variant is shown.');
    return { object: gltf.scene, warnings, units: 'm' };
  } catch (error) {
    disposeGltfObject(gltf.scene);
    throw error;
  }
}
