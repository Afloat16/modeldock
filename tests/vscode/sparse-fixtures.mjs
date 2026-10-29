import assert from 'node:assert/strict';
import { open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Actual logical >5 GiB models, made with truncate and tiny positioned writes. */
export async function createNativeSparseFixtures(workspace) {
  const GiB = 1024 ** 3;
  const plyPath = join(workspace, 'native-5gib.ply');
  const stlPath = join(workspace, 'native-5gib.stl');
  const cleanup = async () => {
    await Promise.all([plyPath, stlPath].map((path) => rm(path, { force: true })));
  };
  try {
    const vertices = Math.ceil((5 * GiB) / 24) + 1;
    const header = Buffer.from(
      `ply\nformat binary_little_endian 1.0\nelement vertex ${vertices}\nproperty double x\nproperty double y\nproperty double z\nend_header\n`,
    );
    const ply = await open(plyPath, 'w');
    try {
      await ply.truncate(header.length + vertices * 24);
      await ply.write(header, 0, header.length, 0);
      for (const [index, point] of [
        [0, [1, 0, 0]],
        [vertices - 1, [3, 1, 1]],
      ]) {
        const record = Buffer.alloc(24);
        point.forEach((value, axis) => record.writeDoubleLE(value, axis * 8));
        await ply.write(record, 0, record.length, header.length + index * 24);
      }
    } finally {
      await ply.close();
    }
    const triangles = Math.ceil((5 * GiB) / 50) + 1;
    const stl = await open(stlPath, 'w');
    try {
      await stl.truncate(84 + triangles * 50);
      const header = Buffer.alloc(84);
      header.writeUint32LE(triangles, 80);
      await stl.write(header, 0, header.length, 0);
      for (const [index, x] of [
        [0, 1],
        [triangles - 1, 3],
      ]) {
        const record = Buffer.alloc(50);
        record.writeFloatLE(1, 0);
        [x, 0, 0, x, 1, 0, x, 0, 1].forEach((value, component) =>
          record.writeFloatLE(value, 12 + component * 4),
        );
        await stl.write(record, 0, record.length, 84 + index * 50);
      }
    } finally {
      await stl.close();
    }
    const fixtures = [];
    for (const [kind, path, expectedVertices, expectedTriangles] of [
      ['ply', plyPath, 300_000, 0],
      ['stl', stlPath, 300_000, 100_000],
    ]) {
      const info = await stat(path);
      assert.ok(info.size > 5 * GiB, `${kind} must be an actual logical >5 GiB file`);
      // This test fixture must stay cheap on disk; it is deliberately not a dense model.
      assert.ok(info.blocks * 512 < 1024 ** 2, `${kind} fixture was not stored sparsely`);
      fixtures.push({
        kind,
        path,
        name: `native-5gib.${kind}`,
        logicalBytes: info.size,
        allocatedBytes: info.blocks * 512,
        expectedVertices,
        expectedTriangles,
      });
    }
    return { fixtures, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
