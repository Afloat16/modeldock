import type { ModelSource } from '../../../src/shared/types.js';
import { DEFAULT_MAX_FILE_BYTES, MAX_RANGE_BYTES } from '../../../src/shared/types.js';

type Result<T> = { ok: true; value: T } | { ok: false; error: { message?: string; code?: string } };
export interface HarnessFileStat { absolutePath: string; version: string; bytes?: number }
export interface HarnessFileBytes extends HarnessFileStat { offset: number; data: Uint8Array; eof: boolean }
export interface HarnessFileRemote {
  workspaceFiles: {
    stat(sessionId: string, path: string, signal: AbortSignal): Promise<Result<HarnessFileStat>>;
    readBytes(sessionId: string, path: string, options: { range: { offset: number; length: number } }, signal: AbortSignal): Promise<Result<HarnessFileBytes>>;
  };
}
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message ?? 'The host refused the selected file read.');
  return result.value;
}
export function parseHarnessSelection(address: string): { sessionId: string; path: string } {
  const url = new URL(address);
  if (url.protocol !== 'dsh-resource:' || url.hostname !== 'file' || url.search || url.hash) throw new Error('Unsupported Harness file resource.');
  const segments = url.pathname.split('/').slice(1).map(decodeURIComponent);
  if (segments[0] !== 'session' || !segments[1] || /[\\/\0]/.test(segments[1]) || segments.length < 3) {
    throw new Error('Open this file from a Harness session workspace, or use Add models to select a local file.');
  }
  const path = segments.slice(2).join('/');
  if (!path || path.includes('\0')) throw new Error('Invalid Harness file selection.');
  return { sessionId: segments[1], path };
}
/** The host resolves permissions and paths; every transfer is a bounded byte window. */
export async function harnessRangeSource(remote: HarnessFileRemote, address: string, name: string, signal: AbortSignal): Promise<ModelSource> {
  const selected = parseHarnessSelection(address);
  const info = unwrap(await remote.workspaceFiles.stat(selected.sessionId, selected.path, signal));
  signal.throwIfAborted();
  if (!Number.isSafeInteger(info.bytes) || info.bytes! < 1 || info.bytes! > DEFAULT_MAX_FILE_BYTES) throw new Error('The selected file size is unavailable or exceeds the 8 GiB source ceiling.');
  return {
    name, size: info.bytes, revision: info.version,
    readRange: async (offset, length, readSignal) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > MAX_RANGE_BYTES || offset + length > info.bytes!) throw new Error('Invalid bounded byte range.');
      const output = new Uint8Array(length);
      for (let consumed = 0; consumed < length;) {
        signal.throwIfAborted(); readSignal?.throwIfAborted();
        const count = Math.min(length - consumed, 512 * 1024);
        const combined = readSignal ? AbortSignal.any([signal, readSignal]) : signal;
        const frame = unwrap(await remote.workspaceFiles.readBytes(selected.sessionId, info.absolutePath, { range: { offset: offset + consumed, length: count } }, combined));
        combined.throwIfAborted();
        if (frame.version !== info.version || frame.bytes !== info.bytes) throw new Error('The model changed while reading; reload to avoid mixing revisions.');
        if (frame.offset !== offset + consumed || !(frame.data instanceof Uint8Array) || frame.data.byteLength !== count) throw new Error('The host returned an invalid or truncated byte window.');
        output.set(frame.data, consumed);
        consumed += count;
      }
      return output;
    },
  };
}
