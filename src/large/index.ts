import type { ParsedModel } from '../shared/types';
import { abortIfNeeded, safeInteger, type RandomAccessSource } from './source';
import { loadBinaryPly } from './ply';
import { loadBinaryStl } from './stl';
export { sourceFromBlob, sourceFromHttp, type RandomAccessSource, type HttpSourceOptions } from './source';

export interface LargePreviewMetadata {
  sourceBytes: number;
  originalVertices: number;
  originalTriangles?: number;
  originalFaces?: number;
  sampledVertices: number;
  sampledTriangles: number;
  sampling: 'stratified-blocks' | 'all';
  /** Fraction of vertex records (PLY) or triangle records (STL) retained; not spatial coverage. */
  coverage: number;
  origin: [number, number, number];
  readBytes: number;
  readCalls: number;
  maxReadChunkBytes: number;
  /** True only if every geometry record, including topology, was decoded and validated. */
  fullyValidated: boolean;
  representation: 'points' | 'surface';
  topologyOmitted: boolean;
}

export interface LargeParsedModel extends ParsedModel {
  origin: [number, number, number];
  preview: LargePreviewMetadata;
}

export interface LargeLoadProgress {
  phase: 'header' | 'geometry';
  readBytes: number;
  totalBytes: number;
  completedRecords: number;
  totalRecords: number;
}

export interface LargeLoadOptions {
  maxPoints?: number;
  maxTriangles?: number;
  /** Total input I/O budget, including the header; never a source-size cap. */
  maxReadBytes?: number;
  chunkBytes?: number;
  maxHeaderBytes?: number;
  /** Allocation budget for geometry attributes, including conversion working arrays. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onProgress?: (progress: LargeLoadProgress) => void;
}

export interface LoadContext {
  source: RandomAccessSource;
  options: Required<Omit<LargeLoadOptions, 'signal' | 'onProgress'>> & Pick<LargeLoadOptions, 'signal' | 'onProgress'>;
  readBytes: number;
  readCalls: number;
  maxReadChunkBytes: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  progress(phase: LargeLoadProgress['phase'], completedRecords: number, totalRecords: number): void;
}

/** Deterministic, non-overlapping blocks covering the entire record-index range, including both ends. */
export function sampleWindows(total: number, retained: number): { start: number; count: number }[] {
  safeInteger(total, 'Record count', 1); safeInteger(retained, 'Retained count', 1);
  if (retained > total) throw new Error('Retained count exceeds original records.');
  if (retained === total) return [{ start: 0, count: total }];
  const windows = Math.min(128, retained), result = [];
  let emitted = 0;
  for (let i = 0; i < windows; i++) {
    const count = Math.floor(retained / windows) + (i < retained % windows ? 1 : 0);
    const gap = i === windows - 1 && windows > 1 ? total - retained : windows > 1 ? Math.floor(i * ((total - retained) / (windows - 1))) : 0;
    result.push({ start: emitted + gap, count }); emitted += count;
  }
  return result;
}

export function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} is non-finite.`);
  return value;
}

export function floatPosition(value: number): number {
  finiteNumber(value, 'Position');
  if (!Number.isFinite(Math.fround(value))) throw new Error('Rebased coordinate exceeds the Float32 render range.');
  return value;
}

export function product(a: number, b: number, label: string): number {
  return safeInteger(a * b, label);
}

/**
 * A bounded preview loader, not a whole-file decoder. Only fixed-record binary formats
 * are random-accessible without building a potentially enormous external index.
 */
export async function loadLargeModel(source: RandomAccessSource, options: LargeLoadOptions = {}): Promise<LargeParsedModel> {
  safeInteger(source.size, 'Source size', 1);
  const resolved: LoadContext['options'] = {
    maxPoints: options.maxPoints ?? 250_000,
    maxTriangles: options.maxTriangles ?? 150_000,
    maxReadBytes: options.maxReadBytes ?? 64 * 1024 ** 2,
    chunkBytes: options.chunkBytes ?? 1024 ** 2,
    maxHeaderBytes: options.maxHeaderBytes ?? 1024 ** 2,
    maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 ** 2,
    signal: options.signal, onProgress: options.onProgress,
  };
  for (const key of ['maxPoints', 'maxTriangles', 'maxReadBytes', 'chunkBytes', 'maxHeaderBytes', 'maxOutputBytes'] as const) safeInteger(resolved[key], key, 1);
  if (resolved.chunkBytes > 16 * 1024 ** 2) throw new Error('chunkBytes cannot exceed 16 MiB.');
  if (resolved.maxHeaderBytes > 16 * 1024 ** 2) throw new Error('maxHeaderBytes cannot exceed 16 MiB.');
  abortIfNeeded(options.signal);
  const context: LoadContext = {
    source, options: resolved, readBytes: 0, readCalls: 0, maxReadChunkBytes: 0,
    async read(offset, length) {
      abortIfNeeded(resolved.signal); safeInteger(offset, 'Read offset'); safeInteger(length, 'Read length');
      if (!Number.isSafeInteger(offset + length) || offset + length > source.size) throw new Error('Binary input is truncated or a range is outside the source.');
      if (length > resolved.chunkBytes) throw new Error('Read exceeds chunkBytes.');
      if (context.readBytes + length > resolved.maxReadBytes) throw new Error('Preview input I/O budget exceeded.');
      const bytes = await source.read(offset, length, resolved.signal);
      abortIfNeeded(resolved.signal);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error('Random-access source returned a truncated or invalid range.');
      context.readBytes += length; context.readCalls++;
      context.maxReadChunkBytes = Math.max(context.maxReadChunkBytes, length);
      return bytes;
    },
    progress(phase, completedRecords, totalRecords) {
      abortIfNeeded(resolved.signal);
      resolved.onProgress?.({ phase, readBytes: context.readBytes, totalBytes: source.size, completedRecords, totalRecords });
    },
  };
  const extension = source.name.split('.').pop()?.toLowerCase();
  let model: LargeParsedModel;
  if (extension === 'ply') model = await loadBinaryPly(context);
  else if (extension === 'stl') model = await loadBinaryStl(context);
  else throw new Error(`Large-file preview supports binary PLY and binary STL. ${extension?.toUpperCase() || 'This format'} requires a bounded conversion or external out-of-core tessellation; a 5 GiB CAD file cannot be safely passed to the in-memory WASM decoder.`);
  model.preview.readBytes = context.readBytes;
  model.preview.readCalls = context.readCalls;
  model.preview.maxReadChunkBytes = context.maxReadChunkBytes;
  if (model.preview.sampling !== 'all') model.warnings.push(`Bounded preview retains ${(model.preview.coverage * 100).toPrecision(4)}% of source records in deterministic blocks spread across the file. Bounds and comparisons describe retained samples only; unseen records are not validated.`);
  return model;
}
