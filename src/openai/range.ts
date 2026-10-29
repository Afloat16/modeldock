import { DEFAULT_MAX_FILE_BYTES, MAX_RANGE_BYTES, type ModelSource } from '../shared/types.js';
import { decodeBoundedBase64, type OpenedFile } from './resource.js';

export interface ServerToolResult { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ type: string; text?: string; [key: string]: unknown }> }
export type CallFileTool = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ServerToolResult>;
function toolError(result: ServerToolResult): string {
  return result.content?.find(item => item.type === 'text')?.text ?? 'The host could not read the selected model.';
}
/** Filesystem paths stay in host-injected metadata on the server side. */
export async function openAISelectedRangeSource(file: OpenedFile, call: CallFileTool, signal: AbortSignal): Promise<ModelSource | undefined> {
  let response: ServerToolResult;
  try { response = await call('modeldock_file_info', {}, signal); }
  catch (error) {
    signal.throwIfAborted();
    if (/method not found|unknown tool|not supported/i.test(String(error))) return undefined;
    throw error;
  }
  signal.throwIfAborted();
  if (response.structuredContent?.reason === 'HOST_FILE_CONTEXT_REQUIRED') return undefined;
  if (response.isError) throw new Error(toolError(response));
  const info = response.structuredContent;
  if (!info) return undefined; // Older hosts can retain the existing bounded resource path.
  if (info.name !== file.name || !Number.isSafeInteger(info.size) || Number(info.size) < 1 || Number(info.size) > DEFAULT_MAX_FILE_BYTES || typeof info.revision !== 'string') throw new Error('Invalid selected-file metadata or source above the 8 GiB ceiling.');
  const size = Number(info.size), revision = info.revision;
  return { name: file.name, size, revision, readRange: async (offset, length, readSignal) => {
    signal.throwIfAborted(); readSignal?.throwIfAborted();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > MAX_RANGE_BYTES || offset + length > size) throw new Error('Invalid bounded file range.');
    const combined = readSignal ? AbortSignal.any([signal, readSignal]) : signal;
    const result = await call('modeldock_read_range', { offset, length, revision }, combined);
    combined.throwIfAborted();
    if (result.isError) throw new Error(toolError(result));
    const range = result.structuredContent;
    if (!range || range.offset !== offset || range.length !== length || range.revision !== revision || typeof range.base64 !== 'string') throw new Error('The host returned a different model revision or invalid byte range.');
    const data = new Uint8Array(decodeBoundedBase64(range.base64, length));
    if (data.byteLength !== length) throw new Error('The host returned a truncated model range.');
    return data;
  } };
}
