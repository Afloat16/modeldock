import assert from 'node:assert/strict';
import test from 'node:test';
import { copyDocumentBytes, createEmbeddedAssetPool, createViewStateCache, nameFromResourceAddress } from '../adapters/deepseek-harness/src/helpers.js';

test('Harness filenames are decoded for format selection without treating the URI as a filesystem path', () => {
  assert.equal(nameFromResourceAddress('dsh-resource://file/session/one/model%20v2.PLY'), 'model v2.PLY');
  assert.equal(nameFromResourceAddress('dsh-resource://file/session/one/%E9%9B%B6%E4%BB%B6.step'), '零件.step');
  assert.equal(nameFromResourceAddress('dsh-resource://file/session/one/model%23final.ply?revision=1'), 'model#final.ply');
  assert.equal(nameFromResourceAddress('dsh-resource://file/session/one/%not-valid.ply'), '%not-valid.ply');
});

test('copying a byte window prevents Worker transfers from detaching the host content', () => {
  const original = Uint8Array.from([11, 22, 33, 44, 55]);
  const copied = copyDocumentBytes(original.subarray(1, 4));
  assert.deepEqual([...new Uint8Array(copied)], [22, 33, 44]);
  const transferred = structuredClone(copied, { transfer: [copied] });
  assert.equal(copied.byteLength, 0);
  assert.deepEqual([...new Uint8Array(transferred)], [22, 33, 44]);
  assert.deepEqual([...original], [11, 22, 33, 44, 55]);
});

test('Harness tabs share asset URLs and revoke them once after the last close', () => {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const pool = createEmbeddedAssetPool({ workerSource: 'worker', occtSource: 'occt', occtWasmBase64: 'AGFzbQ==' }, {
    create: blob => { created.push(blob); return `blob:test-${created.length}`; },
    revoke: url => { revoked.push(url); },
  });
  assert.equal(created.length, 0, 'Allocation must remain lazy.');
  const first = pool.retain();
  const second = pool.retain();
  assert.equal(created.length, 3);
  assert.equal(first.assets, second.assets);
  assert.deepEqual(created.map(blob => blob.type), ['text/javascript', 'text/javascript', 'application/wasm']);
  first.release();
  first.release();
  assert.equal(revoked.length, 0);
  second.release();
  assert.deepEqual(revoked, ['blob:test-1', 'blob:test-2', 'blob:test-3']);
  const third = pool.retain();
  assert.equal(created.length, 6);
  pool.dispose();
  third.release();
  pool.dispose();
  assert.equal(revoked.length, 6);
  assert.throws(() => pool.retain(), /unloaded/);
});

test('partial asset creation rolls back URLs before propagating the failure', () => {
  let calls = 0;
  const revoked: string[] = [];
  const pool = createEmbeddedAssetPool({ workerSource: 'worker', occtSource: 'occt', occtWasmBase64: 'AGFzbQ==' }, {
    create: () => { if (++calls === 2) throw new Error('Blob policy blocked'); return 'blob:allocated'; },
    revoke: url => { revoked.push(url); },
  });
  assert.throws(() => pool.retain(), /Blob policy blocked/);
  assert.deepEqual(revoked, ['blob:allocated']);
});

test('Harness view states survive preview remounts, stay isolated, and evict least-recently-used files', () => {
  const cache = createViewStateCache<{ position: number[] }>(2);
  const camera = { position: [1, 2, 3] };
  cache.set('resource:a', camera);
  camera.position[0] = 99;
  cache.set('resource:b', { position: [4, 5, 6] });
  const restored = cache.get('resource:a')!;
  assert.deepEqual(restored.position, [1, 2, 3]);
  restored.position[1] = 99;
  cache.set('resource:c', { position: [7, 8, 9] });
  assert.equal(cache.get('resource:b'), undefined);
  assert.deepEqual(cache.get('resource:a')?.position, [1, 2, 3]);
  cache.clear();
  assert.equal(cache.get('resource:a'), undefined);
  assert.throws(() => createViewStateCache(0), /Invalid/);
});
