import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { decodeModel, type OcctFactory, type OcctModule } from '../src/core/index';
// The patch is a build-time JavaScript utility. Its exact source is shipped.
// @ts-expect-error The project deliberately does not emit declaration files for build scripts.
import { patchOcctSource, OCCT_ORIGINAL_SHA256 } from '../scripts/patch-occt.mjs';

const sourceUrl = new URL('../node_modules/occt-import-js/dist/occt-import-js.js', import.meta.url);
const wasmUrl = new URL('../node_modules/occt-import-js/dist/occt-import-js.wasm', import.meta.url);

async function initialise(source: string, allowStringCode: boolean): Promise<OcctModule> {
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, WebAssembly,
    TextDecoder, TextEncoder, Uint8Array, Int8Array, Uint16Array, Int16Array,
    Uint32Array, Int32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
    setTimeout, clearTimeout, performance, console: { log() {}, warn() {}, error() {} },
  }, { codeGeneration: { strings: allowStringCode, wasm: true } });
  new vm.Script(source, { filename: 'occt-import-js.cjs' }).runInContext(context);
  const factory = context.module.exports as OcctFactory;
  return factory({ wasmBinary: new Uint8Array(await readFile(wasmUrl)), print() {}, printErr() {} });
}

async function modelBytes(name: string): Promise<ArrayBuffer> {
  const b = await readFile(new URL(`../fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

test('CAD glue patch checks its exact upstream input and removes all known dynamic-code paths', async () => {
  const original = await readFile(sourceUrl, 'utf8');
  assert.equal(createHash('sha256').update(original).digest('hex'), OCCT_ORIGINAL_SHA256);
  const patched = patchOcctSource(original) as string;
  assert.match(patched, /ModelDock modification 2026-10-29/);
  assert.match(patched, /LGPL-2\.1/);
  assert.doesNotMatch(patched, /\bnewFunc\b|\bcreateJsInvoker\b|\beval\s*\(|\bnew\s+Function\b|return\s+Function\b/);
  assert.throws(() => patchOcctSource(original + '\n'), /pinned to/);
  assert.throws(() => patchOcctSource(patched), /pinned to/);
});

test('the strict no-string-code sandbox rejects the unpatched CAD runtime', async () => {
  await assert.rejects(initialise(await readFile(sourceUrl, 'utf8'), false), /Code generation from strings disallowed|EvalError|Aborted/);
});

test('patched runtime runs real CAD in a no-eval sandbox and preserves upstream geometry', async () => {
  const original = await readFile(sourceUrl, 'utf8');
  const reference = await initialise(original, true);
  const patched = await initialise(patchOcctSource(original), false);
  for (const name of ['cube.step', 'cube.iges', 'cube.brep', 'mounting-bracket.step', 'cube.step']) {
    const bytes = await modelBytes(name);
    const expected = decodeModel(bytes, name, {}, reference);
    const actual = decodeModel(bytes, name, {}, patched);
    // Compare every decoded coordinate, normal, index, colour, name and warning.
    // OCCT's mesh-array .map() preserves each VM's Array prototype. Clone into
    // this realm so the comparison checks data instead of VM identity.
    assert.deepEqual(structuredClone(actual), structuredClone(expected), `${name} geometry changed under the static-closure patch`);
    assert.ok(actual.primitives.every(primitive => primitive.indices!.length >= 3));
  }
});
