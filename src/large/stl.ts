import { finiteNumber, floatPosition, sampleWindows, type LoadContext, type LargeParsedModel } from './index';

export async function loadBinaryStl(context: LoadContext): Promise<LargeParsedModel> {
  const { source, options } = context;
  if (source.size < 84) throw new Error('Binary STL is truncated (84-byte header required).');
  if (options.chunkBytes < 84) throw new Error('Binary STL requires chunkBytes >= 84.');
  const header = await context.read(0, 84);
  const count = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(80, true);
  const expected = 84 + count * 50;
  if (!count || expected > source.size) {
    if (/^\s*solid\b/i.test(new TextDecoder().decode(header))) throw new Error('Large ASCII STL requires external conversion to binary STL; no full-file read was attempted.');
    throw new Error('Binary STL is empty or truncated.');
  }
  // Exact file-length checking avoids interpreting ASCII text as a triangle count.
  if (expected !== source.size) throw new Error('Binary STL size does not match its declared triangle count (trailing bytes or ASCII input).');
  const retained = Math.min(count, options.maxTriangles, Math.floor(options.maxOutputBytes / 72), Math.floor((options.maxReadBytes - context.readBytes) / 50));
  if (retained < 1) throw new Error('Preview budget cannot hold one STL triangle.');
  const positions = new Float32Array(retained * 9), normals = new Float32Array(retained * 9);
  const origin: [number, number, number] = [0, 0, 0];
  let emitted = 0, hasNormals = false;
  context.progress('header', 0, retained);
  for (const window of sampleWindows(count, retained)) {
    for (let row = 0; row < window.count;) {
      const records = Math.min(window.count - row, Math.floor(options.chunkBytes / 50));
      const bytes = await context.read(84 + (window.start + row) * 50, records * 50);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < records; i++) {
        const offset = i * 50;
        if (!emitted) for (let axis = 0; axis < 3; axis++) origin[axis] = finiteNumber(view.getFloat32(offset + 12 + axis * 4, true), 'STL position');
        for (let k = 0; k < 9; k++) {
          positions[emitted * 9 + k] = floatPosition(view.getFloat32(offset + 12 + k * 4, true) - origin[k % 3]);
          const normal = finiteNumber(view.getFloat32(offset + (k % 3) * 4, true), 'STL normal');
          normals[emitted * 9 + k] = normal;
          hasNormals ||= normal !== 0;
        }
        emitted++;
      }
      row += records; context.progress('geometry', emitted, retained);
    }
  }
  return {
    sourceFormat: 'STL', units: 'model units', origin,
    primitives: [{ name: 'STL sampled surface', mode: 'triangles', positions, normals: hasNormals ? normals : undefined }],
    warnings: ['STL carries no reliable units. Non-standard binary STL colours are ignored.', ...(retained < count ? ['Surface triangles are a deterministic sample and do not form a closed surface. Area and volume of the full model cannot be inferred.'] : [])],
    preview: { sourceBytes: source.size, originalVertices: count * 3, originalTriangles: count, originalFaces: count,
      sampledVertices: retained * 3, sampledTriangles: retained, sampling: retained === count ? 'all' : 'stratified-blocks', coverage: retained / count,
      origin, readBytes: 0, readCalls: 0, maxReadChunkBytes: 0, fullyValidated: retained === count, representation: 'surface', topologyOmitted: false },
  };
}
