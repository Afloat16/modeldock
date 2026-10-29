import type { DecodeOptions, ParsedModel } from '../shared/types';
import { finite, makeModel, srgbToLinear } from './common';

export interface OcctResult {
  success: boolean;
  meshes?: Array<{
    name?: string;
    color?: number[];
    brep_faces?: Array<{ first: number; last: number; color?: number[] | null }>;
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index: { array: number[] };
  }>;
}
export interface OcctModule {
  ReadStepFile(bytes: Uint8Array, parameters: Record<string, string | number>): OcctResult;
  ReadIgesFile(bytes: Uint8Array, parameters: Record<string, string | number>): OcctResult;
  ReadBrepFile(bytes: Uint8Array, parameters: Record<string, string | number>): OcctResult;
}
export type OcctFactory = (options?: { locateFile?: (path: string) => string; print?: (message: string) => void; printErr?: (message: string) => void; wasmBinary?: Uint8Array }) => Promise<OcctModule>;

export function parseCad(buffer: ArrayBuffer, extension: string, options: DecodeOptions, occt?: OcctModule): ParsedModel {
  if (!occt) throw new Error('The CAD decoder is not ready. The OpenCascade WebAssembly assets must be installed.');
  const deflections = { low: [0.005, 0.5], medium: [0.001, 0.25], high: [0.0002, 0.1] };
  const [linearDeflection, angularDeflection] = deflections[options.cadQuality];
  const parameters = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection, angularDeflection };
  let result: OcctResult;
  const bytes = new Uint8Array(buffer);
  if (extension === 'step' || extension === 'stp') result = occt.ReadStepFile(bytes, parameters);
  else if (extension === 'iges' || extension === 'igs') result = occt.ReadIgesFile(bytes, parameters);
  else result = occt.ReadBrepFile(bytes, parameters);
  if (!result.success || !result.meshes?.length) throw new Error('OpenCascade could not import a triangulated surface from this CAD file. Check that it is a valid STEP, IGES or BREP solid/surface.');
  let vertices = 0, triangles = 0;
  const warnings: string[] = ['CAD is tessellated for viewing. This preview does not edit parametric features or preserve exact B-rep measurements.'];
  let faceColors = false;
  const primitives = result.meshes.map((mesh, i) => {
    const positions = mesh.attributes?.position?.array, indices = mesh.index?.array, normals = mesh.attributes?.normal?.array;
    if (!positions?.length || positions.length % 3 || !indices?.length || indices.length % 3) throw new Error('OpenCascade returned an invalid mesh.');
    vertices += positions.length / 3; triangles += indices.length / 3;
    if (vertices > options.maxVertices || triangles > options.maxTriangles) throw new Error('CAD tessellation exceeds the configured geometry limit. Try Low CAD quality or a smaller assembly.');
    for (const index of indices) if (!Number.isSafeInteger(index) || index < 0 || index >= positions.length / 3) throw new Error('OpenCascade returned an invalid vertex index.');
    if (mesh.brep_faces?.some(face => face.color)) faceColors = true;
    const color = mesh.color?.length === 3 ? mesh.color.map(c => srgbToLinear(finite(c, 'CAD colour'))) as [number, number, number] : undefined;
    return { name: mesh.name?.trim() || `CAD part ${i + 1}`, mode: 'triangles' as const, positions: new Float32Array(positions), normals: normals ? new Float32Array(normals) : undefined, indices: new Uint32Array(indices), color };
  });
  if (faceColors) warnings.push('Part colours are retained; face-level CAD colours are not reproduced.');
  const brep = extension === 'brep' || extension === 'brp';
  if (brep) warnings.push('BREP has no standard unit metadata. Dimensions use the stored model coordinates.');
  return makeModel(primitives, extension === 'stp' ? 'STEP' : extension === 'igs' ? 'IGES' : extension.toUpperCase(), warnings, brep ? 'model units' : 'mm');
}
