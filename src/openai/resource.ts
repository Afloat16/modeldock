import type { OpenAIResources, OpenAIResourceReadResult } from '@openai/mcp-extensions/app';
import { isSupported } from '../shared/formats.js';
import type { ModelSource } from '../shared/types.js';

export const MAX_OPENAI_FILE_BYTES = 128 * 1024 * 1024;

export interface OpenedFile {
  readonly name: string;
  readonly resourceUri: string;
}

export type ResourceBridge = Pick<OpenAIResources, 'read' | 'subscribe' | 'unsubscribe' | 'addUpdateHandler'>;
export type BridgeStatus = 'loading' | 'ready' | 'warning' | 'error' | 'unsupported';

/** Reject an oversized payload before allocating the decoded binary buffer. */
export function decodeBoundedBase64(base64: string, maxBytes = MAX_OPENAI_FILE_BYTES): ArrayBuffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid preview byte limit.');
  if (base64.length > Math.ceil(maxBytes / 3) * 4) throw new Error('File exceeds the 128 MiB preview limit.');
  if (base64.length % 4 !== 0) throw new Error('Host returned invalid base64 file content.');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const size = base64.length / 4 * 3 - padding;
  if (size > maxBytes) throw new Error('File exceeds the 128 MiB preview limit.');
  if (size <= 0) throw new Error('The model file is empty.');
  const bytes = new Uint8Array(size);
  let written = 0;
  try {
    // Multiples of four preserve base64 boundaries while limiting temporary strings.
    for (let offset = 0; offset < base64.length; offset += 65536) {
      const decoded = atob(base64.slice(offset, offset + 65536));
      if (written + decoded.length > size) throw new Error('Invalid base64 length.');
      for (let index = 0; index < decoded.length; index++) bytes[written++] = decoded.charCodeAt(index);
    }
  } catch {
    throw new Error('Host returned invalid base64 file content.');
  }
  if (written !== size) throw new Error('Host returned invalid base64 file content.');
  return bytes.buffer;
}

/** Request blob representation, but handle conforming hosts that return UTF-8 text. */
export function modelFromResource(
  file: OpenedFile,
  result: OpenAIResourceReadResult,
  maxBytes = MAX_OPENAI_FILE_BYTES,
): ModelSource {
  const content = result.contents.find(item => item.uri === file.resourceUri);
  if (!content) throw new Error('The host did not return the selected file resource.');
  let data: ArrayBuffer;
  if ('blob' in content && typeof content.blob === 'string') {
    data = decodeBoundedBase64(content.blob, maxBytes);
  } else if ('text' in content && typeof content.text === 'string') {
    if (content.text.length > maxBytes) throw new Error('File exceeds the 128 MiB preview limit.');
    // encodeInto checks UTF-8 bytes without creating an unbounded secondary copy.
    const capacity = Math.min(maxBytes + 1, content.text.length * 3);
    const buffer = new Uint8Array(capacity);
    const encoded = new TextEncoder().encodeInto(content.text, buffer);
    if (encoded.read !== content.text.length || encoded.written > maxBytes) {
      throw new Error('File exceeds the 128 MiB preview limit.');
    }
    if (!encoded.written) throw new Error('The model file is empty.');
    data = buffer.slice(0, encoded.written).buffer;
  } else {
    throw new Error('The host returned neither binary nor text model data.');
  }
  return { name: file.name, data, revision: content.openaiMetadata?.etag };
}

export interface ResourceControllerOptions {
  getResources(): ResourceBridge | undefined;
  display(source: ModelSource, options: { preserveView: boolean }): Promise<void>;
  status(status: BridgeStatus, detail?: string): void;
  maxBytes?: number;
  /** Prefer a host-authorized random-access source, with bounded fallback for old hosts. */
  getSource?(file: OpenedFile, signal: AbortSignal): Promise<ModelSource | undefined>;
}

/**
 * Owns only the one host-authorized file currently supplied to the entrypoint.
 * Subscription operations are serialized, so rapid A -> B -> A switching cannot
 * let a late unsubscribe cancel the newest subscription to A.
 */
export function createFileResourceController(options: ResourceControllerOptions) {
  let current: { file: OpenedFile; bridge: ResourceBridge; generation: number } | undefined;
  let generation = 0;
  let readRevision = 0;
  let readAbort: AbortController | undefined;
  let displayedUri: string | undefined;
  let disposed = false;
  let unsubscribeUpdates: (() => void) | undefined;
  let subscribed: { bridge: ResourceBridge; uri: string } | undefined;
  let subscriptionFailure = '';
  let subscriptionQueue: Promise<void> = Promise.resolve();

  const unsubscribeCurrent = async (): Promise<void> => {
    const old = subscribed;
    subscribed = undefined;
    if (old) {
      try { await old.bridge.unsubscribe({ uri: old.uri }, { timeout: 5000 }); }
      catch { /* Cleanup is best effort if the host has already disconnected. */ }
    }
  };

  const reload = async (): Promise<void> => {
    const active = current;
    if (!active || disposed) return;
    const revision = ++readRevision;
    readAbort?.abort();
    const abort = new AbortController();
    readAbort = abort;
    options.status('loading');
    try {
      let source = await options.getSource?.(active.file, abort.signal);
      if (!source) {
        const result = await active.bridge.read({ uri: active.file.resourceUri, representation: 'blob' }, { signal: abort.signal, timeout: 60000 });
        source = modelFromResource(active.file, result, options.maxBytes);
      }
      if (disposed || current !== active || revision !== readRevision) return;
      await options.display(source, { preserveView: displayedUri === active.file.resourceUri });
      if (disposed || current !== active || revision !== readRevision) return;
      displayedUri = active.file.resourceUri;
      options.status(subscriptionFailure ? 'warning' : 'ready', subscriptionFailure || undefined);
    } catch (error) {
      if (!disposed && current === active && revision === readRevision && !abort.signal.aborted) {
        options.status('error', error instanceof Error ? error.message : String(error));
      }
    }
  };

  const open = async (file: OpenedFile): Promise<void> => {
    if (disposed) return;
    if (!file.name.trim() || /[\\/]/.test(file.name) || !isSupported(file.name)) {
      options.status('error', `Unsupported model filename: ${file.name}`);
      return;
    }
    if (!file.resourceUri.trim()) {
      options.status('error', 'The host did not provide a file resource URI.');
      return;
    }
    const bridge = options.getResources();
    if (!bridge) {
      options.status('unsupported', 'This host does not expose OpenAI file resources. Use a supported Desktop file entrypoint, the VS Code extension, or the ModelDock local viewer.');
      return;
    }
    if (current?.file.resourceUri === file.resourceUri && current.bridge === bridge) {
      current.file = file;
      await reload();
      return;
    }
    readRevision++;
    readAbort?.abort();
    unsubscribeUpdates?.();
    subscriptionFailure = '';
    const active = { file, bridge, generation: ++generation };
    current = active;
    options.status('loading');
    unsubscribeUpdates = bridge.addUpdateHandler(async notification => {
      if (current === active && notification.params.uri === active.file.resourceUri) await reload();
    });

    subscriptionQueue = subscriptionQueue.then(async () => {
      await unsubscribeCurrent();
      if (disposed || current !== active) return;
      try {
        await bridge.subscribe({ uri: file.resourceUri }, { timeout: 5000 });
        subscribed = { bridge, uri: file.resourceUri };
        if (disposed || current !== active) await unsubscribeCurrent();
      } catch {
        if (current === active && !disposed) {
          subscriptionFailure = 'The host did not enable live updates. Use Reload file after changing the model.';
        }
      }
    });
    await subscriptionQueue;
    if (!disposed && current === active) await reload();
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    generation++;
    readRevision++;
    current = undefined;
    readAbort?.abort();
    unsubscribeUpdates?.();
    unsubscribeUpdates = undefined;
    subscriptionQueue = subscriptionQueue.then(unsubscribeCurrent);
    await subscriptionQueue;
  };

  return { open, reload, dispose };
}
