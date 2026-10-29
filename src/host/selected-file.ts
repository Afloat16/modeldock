import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { DEFAULT_MAX_FILE_BYTES, MAX_RANGE_BYTES } from '../shared/types.js';
import { isSupported } from '../shared/formats.js';

export interface SelectedFileInfo { name: string; size: number; revision: string }
function revisionOf(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
export function validateRange(offset: number, length: number, size: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_RANGE_BYTES || offset > size || length > size - offset) {
    throw new Error('Invalid byte range: use safe integer offsets and chunks of at most 4 MiB inside the selected file.');
  }
}
async function checkedOpen(filePath: string, maxBytes: number) {
  if (!isAbsolute(filePath) || !isSupported(filePath)) throw new Error('The host must authorize an absolute supported model path.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid source-size limit.');
  const resolved = await realpath(filePath);
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error('The selected source must be a regular file.');
    if (stat.size > maxBytes) throw new Error(`The selected file exceeds the ${maxBytes / 1024 ** 3} GiB source-size limit.`);
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}
/** Only call with a path supplied by a host file selection, never an app tool argument. */
export async function selectedFileInfo(filePath: string, maxBytes = DEFAULT_MAX_FILE_BYTES): Promise<SelectedFileInfo> {
  const { handle, stat } = await checkedOpen(filePath, maxBytes);
  try { return { name: basename(filePath), size: stat.size, revision: revisionOf(stat) }; }
  finally { await handle.close(); }
}
/** Recheck identity before and after each bounded read to avoid mixing file revisions. */
export async function readSelectedRange(filePath: string, revision: string, offset: number, length: number, maxBytes = DEFAULT_MAX_FILE_BYTES, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const { handle, stat } = await checkedOpen(filePath, maxBytes);
  try {
    if (revisionOf(stat) !== revision) throw new Error('The model changed while reading. Reload to use one consistent revision.');
    validateRange(offset, length, stat.size);
    const data = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      signal?.throwIfAborted();
      const result = await handle.read(data, read, length - read, offset + read);
      if (!result.bytesRead) throw new Error('The selected file was truncated while reading.');
      read += result.bytesRead;
    }
    signal?.throwIfAborted();
    if (revisionOf(await handle.stat()) !== revision) throw new Error('The model changed while reading. Reload to use one consistent revision.');
    return data;
  } finally { await handle.close(); }
}
