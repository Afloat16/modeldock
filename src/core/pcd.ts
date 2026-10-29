import type { DecodeOptions, ParsedModel } from '../shared/types';
import { count, finite, makeModel, srgbToLinear, TokenCursor } from './common';

type Field = { name: string; size: number; type: string; count: number; offset: number; column: number };

/** The PCD binary_compressed payload uses liblzf, followed by field-major bytes. */
function decompressLzf(source: Uint8Array, expectedSize: number): Uint8Array {
  const output = new Uint8Array(expectedSize);
  let i = 0, o = 0;
  while (i < source.length) {
    const control = source[i++];
    if (control < 32) {
      const n = control + 1;
      if (i + n > source.length || o + n > output.length) throw new Error('Invalid PCD LZF literal.');
      output.set(source.subarray(i, i + n), o); i += n; o += n;
    } else {
      let n = control >>> 5;
      let reference = o - ((control & 31) << 8) - 1;
      if (n === 7) {
        if (i >= source.length) throw new Error('Truncated PCD LZF length.');
        n += source[i++];
      }
      if (i >= source.length) throw new Error('Truncated PCD LZF reference.');
      reference -= source[i++]; n += 2;
      if (reference < 0 || o + n > output.length) throw new Error('Invalid PCD LZF reference.');
      for (let k = 0; k < n; k++) output[o++] = output[reference++];
    }
  }
  if (o !== expectedSize) throw new Error('PCD decompressed size does not match its header.');
  return output;
}

export function parsePcd(buffer: ArrayBuffer, options: DecodeOptions): ParsedModel {
  const bytes = new Uint8Array(buffer);
  const header = new Map<string, string[]>();
  let start = 0, end = -1;
  for (let i = 0; i < Math.min(bytes.length, 65536); i++) {
    if (bytes[i] !== 10) continue;
    const line = new TextDecoder().decode(bytes.subarray(start, i)).trim(); start = i + 1;
    if (!line || line.startsWith('#')) continue;
    const [key, ...values] = line.split(/\s+/);
    if (header.has(key.toUpperCase())) throw new Error(`Duplicate PCD ${key} header.`);
    header.set(key.toUpperCase(), values);
    if (key.toUpperCase() === 'DATA') { end = i + 1; break; }
  }
  if (end < 0) throw new Error('PCD DATA header is missing or exceeds 64 KiB.');
  const names = header.get('FIELDS') ?? header.get('FIELD');
  if (!names?.length) throw new Error('PCD FIELDS header is missing.');
  const sizes = header.get('SIZE'), types = header.get('TYPE'), counts = header.get('COUNT');
  if (sizes?.length !== names.length || types?.length !== names.length || (counts && counts.length !== names.length)) throw new Error('PCD field metadata has inconsistent lengths.');
  const width = header.has('WIDTH') ? count(header.get('WIDTH')?.[0], 'PCD width', options.maxVertices) : undefined;
  const height = header.has('HEIGHT') ? count(header.get('HEIGHT')?.[0], 'PCD height', options.maxVertices) : 1;
  const points = count(header.get('POINTS')?.[0] ?? (width === undefined ? undefined : width * height), 'PCD point count', options.maxVertices);
  if (!points || (width !== undefined && width * height !== points)) throw new Error('PCD dimensions do not match its point count.');
  const fields: Field[] = [];
  let stride = 0, columns = 0;
  for (let i = 0; i < names.length; i++) {
    const size = Number(sizes[i]), type = types[i].toUpperCase(), n = count(counts?.[i] ?? 1, 'PCD field count', 4096);
    if (!n || !['F', 'I', 'U'].includes(type) || !(type === 'F' ? [4, 8] : [1, 2, 4]).includes(size)) throw new Error('Unsupported PCD field size/type.');
    if (fields.some(f => f.name === names[i]) && names[i] !== '_') throw new Error('Duplicate PCD field.');
    fields.push({ name: names[i], size, type, count: n, offset: stride, column: columns });
    stride += size * n; columns += n;
  }
  const find = (name: string) => fields.find(f => f.name === name);
  const xyz = ['x', 'y', 'z'].map(find);
  if (xyz.some(f => !f || f.count !== 1)) throw new Error('PCD must have scalar x, y and z fields.');
  const normals = ['normal_x', 'normal_y', 'normal_z'].map(find);
  const rgb = find('rgb') ?? find('rgba');
  if (rgb && (rgb.size !== 4 || rgb.count !== 1)) throw new Error('PCD packed RGB must have size 4 and count 1.');
  const separateRgb = ['r', 'g', 'b'].map(find);
  const hasNormals = normals.every(f => f?.count === 1);
  const hasColors = !!rgb || separateRgb.every(f => f?.count === 1);
  const data = header.get('DATA')?.[0]?.toLowerCase();
  let binary: Uint8Array<ArrayBufferLike> = bytes.subarray(end);
  let fieldMajor = false;
  const expected = points * stride;
  if (!Number.isSafeInteger(expected) || expected > 512 * 1024 * 1024) throw new Error('PCD expanded record data exceeds the 512 MiB safety limit.');
  if (data === 'binary_compressed') {
    if (binary.length < 8) throw new Error('PCD compressed header is truncated.');
    const lengths = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
    const compressedLength = lengths.getUint32(0, true), uncompressedLength = lengths.getUint32(4, true);
    if (uncompressedLength !== expected || compressedLength !== binary.length - 8) throw new Error('PCD compressed lengths do not match its header.');
    binary = decompressLzf(binary.subarray(8), expected); fieldMajor = true;
  } else if (data === 'binary') {
    if (binary.length !== expected) throw new Error('PCD binary data size does not match its header.');
  } else if (data !== 'ascii') throw new Error('Unsupported PCD DATA encoding.');
  const cursor = data === 'ascii' ? new TokenCursor(new TextDecoder().decode(binary)) : null;
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const packedFloat = new DataView(new ArrayBuffer(4));
  const positions = new Float32Array(points * 3), colorData = hasColors ? new Float32Array(points * 3) : undefined, normalData = hasNormals ? new Float32Array(points * 3) : undefined;
  const read = (field: Field, row: number): number => {
    const at = fieldMajor ? points * field.offset + row * field.size * field.count : row * stride + field.offset;
    if (field.type === 'F') return field.size === 8 ? view.getFloat64(at, true) : view.getFloat32(at, true);
    if (field.type === 'I') return field.size === 1 ? view.getInt8(at) : field.size === 2 ? view.getInt16(at, true) : view.getInt32(at, true);
    return field.size === 1 ? view.getUint8(at) : field.size === 2 ? view.getUint16(at, true) : view.getUint32(at, true);
  };
  for (let row = 0; row < points; row++) {
    let values: number[] | undefined;
    if (cursor) {
      values = [];
      for (let k = 0; k < columns; k++) {
        const token = cursor.next();
        if (token === undefined) throw new Error('PCD ASCII data is truncated.');
        const n = Number(token);
        if (Number.isNaN(n) && !/^[-+]?nan$/i.test(token)) throw new Error('Invalid PCD numeric value.');
        values.push(n);
      }
    }
    const get = (field: Field) => values ? values[field.column] : read(field, row);
    for (let k = 0; k < 3; k++) {
      positions[row * 3 + k] = finite(get(xyz[k]!), 'PCD position');
      if (normalData) normalData[row * 3 + k] = finite(get(normals[k]!), 'PCD normal');
    }
    if (colorData && rgb) {
      let packed: number;
      if (!values) {
        const at = fieldMajor ? points * rgb.offset + row * rgb.size * rgb.count : row * stride + rgb.offset;
        // A packed RGBA float can be a NaN bit pattern; reading as JS Number
        // and writing it back would canonicalise NaN and discard colour bits.
        packed = view.getUint32(at, true);
      } else if (rgb.type === 'F') { packedFloat.setFloat32(0, get(rgb), true); packed = packedFloat.getUint32(0, true); }
      else packed = get(rgb) >>> 0;
      colorData[row * 3] = srgbToLinear(((packed >>> 16) & 255) / 255);
      colorData[row * 3 + 1] = srgbToLinear(((packed >>> 8) & 255) / 255);
      colorData[row * 3 + 2] = srgbToLinear((packed & 255) / 255);
    } else if (colorData) for (let k = 0; k < 3; k++) colorData[row * 3 + k] = srgbToLinear(finite(get(separateRgb[k]!), 'PCD color') / (separateRgb[k]!.type === 'F' ? 1 : 255));
  }
  if (cursor?.next() !== undefined) throw new Error('PCD ASCII data contains more points than declared.');
  const warnings: string[] = [];
  const viewpoint = header.get('VIEWPOINT');
  if (viewpoint && viewpoint.join(' ') !== '0 0 0 1 0 0 0') warnings.push('PCD VIEWPOINT is sensor metadata; coordinates are displayed as stored without applying that transform.');
  if (find('rgba')) warnings.push('PCD per-point alpha is ignored.');
  return makeModel([{ name: 'PCD points', mode: 'points', positions, colors: colorData, normals: normalData }], 'PCD', warnings);
}
