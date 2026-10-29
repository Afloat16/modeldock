import { CAD_EXTENSIONS, extensionOf } from '../shared/formats';
import type { DecodeOptions, ParsedModel } from '../shared/types';
import { parseCad, type OcctModule } from './cad';
import { optionsWithDefaults, validateModel } from './common';
import { parseOff, parseObj, parseStl, parseXyz } from './mesh';
import { parsePcd } from './pcd';
import { parsePly } from './ply';

export type { OcctModule, OcctFactory, OcctResult } from './cad';
export { validateModel, optionsWithDefaults } from './common';

/** Pure decoding API; no file-system, network or DOM access. */
export function decodeModel(buffer: ArrayBuffer, filename: string, partialOptions: Partial<DecodeOptions> = {}, occt?: OcctModule): ParsedModel {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) throw new Error('The model file is empty or has no readable bytes.');
  const options = optionsWithDefaults(partialOptions);
  const extension = extensionOf(filename);
  let model: ParsedModel;
  if (CAD_EXTENSIONS.has(extension)) model = parseCad(buffer, extension, options, occt);
  else switch (extension) {
    case 'ply': model = parsePly(buffer, options); break;
    case 'stl': model = parseStl(buffer, options); break;
    case 'obj': model = parseObj(buffer, options); break;
    case 'off': model = parseOff(buffer, options); break;
    case 'xyz': model = parseXyz(buffer, options); break;
    case 'pcd': model = parsePcd(buffer, options); break;
    case 'glb': case 'gltf': throw new Error('glTF files must be opened with the scene loader.');
    default: throw new Error(`Unsupported model format: .${extension || '(none)'}`);
  }
  return validateModel(model, options);
}
