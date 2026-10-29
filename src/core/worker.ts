import { CAD_EXTENSIONS, extensionOf } from '../shared/formats';
import type { DecodeOptions, ParsedModel, ViewerAssets } from '../shared/types';
import { decodeModel, type OcctFactory, type OcctModule } from './index';

interface DecodeRequest {
  type: 'decode';
  id: number;
  buffer: ArrayBuffer;
  name: string;
  options?: Partial<DecodeOptions>;
  assets: Pick<ViewerAssets, 'occtJs' | 'occtWasm'>;
}
interface WorkerGlobal {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  importScripts(...urls: string[]): void;
  occtimportjs?: OcctFactory;
}
const scope = globalThis as unknown as WorkerGlobal;
let occtPromise: Promise<OcctModule> | undefined;

function transferables(model: ParsedModel): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const primitive of model.primitives) for (const attribute of [primitive.positions, primitive.normals, primitive.colors, primitive.indices]) {
    if (attribute?.buffer instanceof ArrayBuffer) buffers.add(attribute.buffer);
  }
  return [...buffers];
}

scope.onmessage = async ({ data }) => {
  if (!data || data.type !== 'decode') return;
  const { id, buffer, name, options, assets } = data;
  try {
    let occt: OcctModule | undefined;
    if (CAD_EXTENSIONS.has(extensionOf(name))) {
      scope.postMessage({ type: 'progress', id, message: 'Loading local CAD kernel…' });
      if (!occtPromise) {
        occtPromise = (async () => {
          if (!assets?.occtJs || !assets?.occtWasm) throw new Error('The CAD runtime assets are missing.');
          scope.importScripts(assets.occtJs);
          if (!scope.occtimportjs) throw new Error('The CAD runtime could not initialise.');
          return scope.occtimportjs({ locateFile: () => assets.occtWasm, print: () => {}, printErr: () => {} });
        })();
        occtPromise.catch(() => { occtPromise = undefined; });
      }
      occt = await occtPromise;
      scope.postMessage({ type: 'progress', id, message: 'Tessellating CAD surfaces…' });
    } else scope.postMessage({ type: 'progress', id, message: 'Decoding model geometry…' });
    const model = decodeModel(buffer, name, options, occt);
    scope.postMessage({ type: 'result', id, model }, transferables(model));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The model could not be decoded.';
    scope.postMessage({ type: 'error', id, message });
  }
};
