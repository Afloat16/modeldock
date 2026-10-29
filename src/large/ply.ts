import { srgbToLinear } from '../core/common';
import { safeInteger } from './source';
import { finiteNumber, floatPosition, product, sampleWindows, type LoadContext, type LargeParsedModel } from './index';

interface Scalar { bytes: number; integer: boolean; maximum: number; read(view: DataView, offset: number, little: boolean): number }
const scalars: Record<string, Scalar> = {};
function scalar(names: string[], bytes: number, integer: boolean, maximum: number, read: Scalar['read']): void {
  for (const name of names) scalars[name] = { bytes, integer, maximum, read };
}
scalar(['char', 'int8'], 1, true, 127, (v, o) => v.getInt8(o));
scalar(['uchar', 'uint8'], 1, true, 255, (v, o) => v.getUint8(o));
scalar(['short', 'int16'], 2, true, 32767, (v, o, le) => v.getInt16(o, le));
scalar(['ushort', 'uint16'], 2, true, 65535, (v, o, le) => v.getUint16(o, le));
scalar(['int', 'int32'], 4, true, 2147483647, (v, o, le) => v.getInt32(o, le));
scalar(['uint', 'uint32'], 4, true, 4294967295, (v, o, le) => v.getUint32(o, le));
scalar(['float', 'float32'], 4, false, 1, (v, o, le) => v.getFloat32(o, le));
scalar(['double', 'float64'], 8, false, 1, (v, o, le) => v.getFloat64(o, le));
interface Property { name: string; type: Scalar; offset: number; list?: Scalar }
interface Element { name: string; count: number; properties: Property[]; stride: number; variable: boolean }

async function headerBytes(context: LoadContext): Promise<Uint8Array> {
  let bytes = new Uint8Array(0), lineStart = 0;
  while (bytes.length < Math.min(context.options.maxHeaderBytes, context.source.size)) {
    const count = Math.min(16 * 1024, context.options.chunkBytes, context.options.maxHeaderBytes - bytes.length, context.source.size - bytes.length);
    const chunk = await context.read(bytes.length, count);
    const combined = new Uint8Array(bytes.length + chunk.length);
    combined.set(bytes); combined.set(chunk, bytes.length);
    const oldLength = bytes.length; bytes = combined;
    for (let i = oldLength; i < bytes.length; i++) if (bytes[i] === 10) {
      const line = new TextDecoder().decode(bytes.subarray(lineStart, i)).trim();
      if (line === 'end_header') return bytes.slice(0, i + 1);
      lineStart = i + 1;
    }
  }
  throw new Error('PLY header is truncated or exceeds maxHeaderBytes.');
}

export async function loadBinaryPly(context: LoadContext): Promise<LargeParsedModel> {
  const { source, options } = context;
  const header = await headerBytes(context);
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(header).replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== 'ply') throw new Error('Not a PLY file (missing ply signature).');
  let format = '', current: Element | undefined;
  const elements: Element[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (['', 'comment', 'obj_info', 'end_header'].includes(parts[0])) continue;
    if (parts[0] === 'format') {
      if (format || parts.length !== 3 || parts[2] !== '1.0' || !['binary_little_endian', 'binary_big_endian', 'ascii'].includes(parts[1])) throw new Error('Unsupported or duplicate PLY format declaration.');
      format = parts[1];
    } else if (parts[0] === 'element') {
      if (parts.length !== 3 || !/^\d+$/.test(parts[2]) || elements.some(e => e.name === parts[1])) throw new Error('Missing or duplicate PLY element or invalid count.');
      current = { name: parts[1], count: safeInteger(Number(parts[2]), 'PLY element count'), properties: [], stride: 0, variable: false };
      elements.push(current);
    } else if (parts[0] === 'property') {
      if (!current) throw new Error('PLY property appears before an element.');
      const list = parts[1] === 'list';
      const type = scalars[parts[list ? 3 : 1]], countType = list ? scalars[parts[2]] : undefined, name = parts[list ? 4 : 2];
      if (parts.length !== (list ? 5 : 3) || !name || !type || (list && !countType?.integer) || current.properties.some(p => p.name === name)) throw new Error('Unsupported or duplicate PLY property.');
      current.properties.push({ name, type, offset: current.stride, list: countType });
      current.stride = safeInteger(current.stride + (countType?.bytes ?? type.bytes), 'PLY record size');
      current.variable ||= list;
    } else throw new Error(`Unsupported PLY directive: ${parts[0]}.`);
  }
  if (!format) throw new Error('PLY format declaration is missing.');
  if (format === 'ascii') throw new Error('Large ASCII PLY requires external conversion to binary PLY; no full-file read was attempted.');
  const vertex = elements.find(e => e.name === 'vertex');
  if (!vertex?.count) throw new Error('PLY contains no vertices.');
  if (vertex.variable) throw new Error('Random-access PLY requires fixed-width vertex records; list-valued vertices need an external index.');
  if (vertex.stride > options.chunkBytes) throw new Error('PLY vertex record exceeds chunkBytes.');
  const property = (name: string) => vertex.properties.find(p => p.name === name && !p.list);
  const xyz = ['x', 'y', 'z'].map(property);
  if (xyz.some(p => !p)) throw new Error('PLY vertex properties x, y, z are required.');
  for (const element of elements) if (element.count && !element.properties.length) throw new Error('PLY element has no properties.');
  let vertexOffset = header.length, minimumEnd = header.length, foundVertex = false;
  for (const element of elements) {
    if (element === vertex) { vertexOffset = minimumEnd; foundVertex = true; }
    else if (!foundVertex && element.variable && element.count) throw new Error('A variable-length PLY element precedes vertices; random access requires an external index.');
    minimumEnd = safeInteger(minimumEnd + product(element.count, element.stride, 'PLY element byte size'), 'PLY declared byte size');
    if (minimumEnd > source.size) throw new Error('Binary PLY is truncated for its declared element counts.');
  }
  const little = format === 'binary_little_endian';
  const normalProperties = ['nx', 'ny', 'nz'].map(property);
  const hasNormals = normalProperties.every(Boolean);
  let colorProperties = ['red', 'green', 'blue'].map(property);
  if (!colorProperties.every(Boolean)) colorProperties = ['diffuse_red', 'diffuse_green', 'diffuse_blue'].map(property);
  const directColors = colorProperties.every(Boolean);
  if (!directColors) colorProperties = ['f_dc_0', 'f_dc_1', 'f_dc_2'].map(property);
  const hasColors = colorProperties.every(Boolean), gaussian = !directColors && hasColors;
  const bytesPerPoint = 12 + (hasNormals ? 12 : 0) + (hasColors ? 12 : 0);
  const retained = Math.min(vertex.count, options.maxPoints, Math.floor(options.maxOutputBytes / bytesPerPoint), Math.floor((options.maxReadBytes - context.readBytes) / vertex.stride));
  if (retained < 1) throw new Error('Preview budget cannot hold one PLY vertex record.');
  const positions = new Float32Array(retained * 3);
  const normals = hasNormals ? new Float32Array(retained * 3) : undefined;
  const colors = hasColors ? new Float32Array(retained * 3) : undefined;
  const origin: [number, number, number] = [0, 0, 0];
  let emitted = 0;
  context.progress('header', 0, retained);
  for (const window of sampleWindows(vertex.count, retained)) {
    for (let row = 0; row < window.count;) {
      const records = Math.min(window.count - row, Math.floor(options.chunkBytes / vertex.stride));
      const bytes = await context.read(vertexOffset + (window.start + row) * vertex.stride, records * vertex.stride);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < records; i++) {
        const read = (p: Property | undefined) => finiteNumber(p!.type.read(view, i * vertex.stride + p!.offset, little), `PLY ${p!.name}`);
        for (let axis = 0; axis < 3; axis++) {
          const value = read(xyz[axis]);
          if (!emitted) origin[axis] = value;
          positions[emitted * 3 + axis] = floatPosition(value - origin[axis]);
          if (normals) normals[emitted * 3 + axis] = floatPosition(read(normalProperties[axis]));
          if (colors) {
            const value = read(colorProperties[axis]);
            colors[emitted * 3 + axis] = srgbToLinear(gaussian ? 0.5 + 0.28209479177387814 * value : value / (colorProperties[axis]!.type.integer ? colorProperties[axis]!.type.maximum : 1));
          }
        }
        emitted++;
      }
      row += records; context.progress('geometry', emitted, retained);
    }
  }
  const faces = elements.find(e => e.name === 'face')?.count ?? 0;
  const omittedElements = elements.filter(e => e !== vertex && e.count > 0);
  const warnings: string[] = [];
  if (faces) warnings.push(`Surface topology unavailable in the bounded PLY preview: ${faces.toLocaleString('en-US')} declared polygon faces are omitted. Only sampled vertex centres are displayed; surface area, volume, connectivity and mesh completeness are unavailable.`);
  if (omittedElements.some(e => e.name !== 'face')) warnings.push(`Non-vertex PLY elements are omitted from this point preview: ${omittedElements.filter(e => e.name !== 'face').map(e => e.name).join(', ')}.`);
  if (gaussian || property('scale_0') || property('opacity')) warnings.push('Gaussian-splat attributes are displayed as point centres only. Covariance, opacity and splat rendering are unsupported.');
  if (property('alpha')) warnings.push('PLY per-vertex alpha is ignored.');
  return {
    sourceFormat: 'PLY', units: 'model units', origin,
    primitives: [{ name: faces ? 'PLY mesh vertex preview (surface unavailable)' : 'PLY point preview', mode: 'points', positions, normals, colors }], warnings,
    preview: { sourceBytes: source.size, originalVertices: vertex.count, originalFaces: faces || undefined,
      sampledVertices: retained, sampledTriangles: 0, sampling: retained === vertex.count ? 'all' : 'stratified-blocks', coverage: retained / vertex.count,
      origin, readBytes: 0, readCalls: 0, maxReadChunkBytes: 0, fullyValidated: retained === vertex.count && !omittedElements.length, representation: 'points', topologyOmitted: omittedElements.length > 0 },
  };
}
