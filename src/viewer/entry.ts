import { mountViewer } from './viewer';
import type { ModelSource, ViewerConfig, ViewerHandle } from '../shared/types';

declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage(value: unknown): void;
      getState(): unknown;
      setState(value: unknown): void;
    };
  }
}
const app = document.getElementById('app');
const configElement = document.getElementById('modeldock-config');
if (!app || !configElement) throw new Error('ModelDock bootstrap elements are missing.');
document.documentElement.style.height = '100%';
document.body.style.cssText = 'height:100%;margin:0;overflow:hidden';
app.style.height = '100%';
const config = JSON.parse(configElement.textContent || '{}') as ViewerConfig;
const vscode = config.host === 'vscode' ? window.acquireVsCodeApi?.() : undefined;
const pending = new Map<string, { resolve(value: any): void; reject(reason: Error): void; cleanup(): void }>();
let requestSequence = 0;
function hostRequest(type: 'readRange' | 'pickModels', args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted();
  if (!vscode) return Promise.reject(new Error('Native file bridge unavailable.'));
  const requestId = `md_${++requestSequence}`;
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(requestId); };
    const abort = () => { finish(); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { finish(); reject(new Error('The host did not respond to the file request.')); }, type === 'pickModels' ? 600000 : 60000);
    signal?.addEventListener('abort', abort, { once: true });
    pending.set(requestId, { resolve, reject, cleanup: finish });
    vscode.postMessage({ type, requestId, ...args });
  });
}
function bindSource(source: ModelSource): ModelSource {
  if (!vscode || !source.sourceId || !source.revision) return source;
  return { ...source, readRange: async (offset, length, signal) => {
    const result = await hostRequest('readRange', { sourceId: source.sourceId, revision: source.revision, offset, length }, signal);
    if (typeof result.base64 !== 'string' || result.base64.length > Math.ceil(length / 3) * 4) throw new Error('Invalid bounded host response.');
    const decoded = atob(result.base64);
    if (decoded.length !== length) throw new Error('The host returned a truncated byte range.');
    return Uint8Array.from(decoded, character => character.charCodeAt(0));
  } };
}
let viewer: ViewerHandle;
if (vscode) {
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'modeldock-response' && typeof message.requestId === 'string') {
      const waiting = pending.get(message.requestId);
      if (!waiting) return;
      waiting.cleanup();
      if (typeof message.error === 'string') waiting.reject(new Error(message.error));
      else waiting.resolve(message);
    } else if (message?.type === 'load' && typeof message.source?.name === 'string') {
      void viewer?.load(bindSource(message.source), { preserveView: message.preserveView === true });
    } else if (message?.type === 'host-error' && typeof message.message === 'string') viewer?.showError?.(message.message);
  });
  if (config.initialFile) config.initialFile = bindSource(config.initialFile);
  config.pickFiles = async () => {
    const result = await hostRequest('pickModels', {});
    if (!Array.isArray(result.sources)) throw new Error('Invalid native file selection.');
    return result.sources.map(bindSource);
  };
}
viewer = mountViewer(app, config);
let revision = config.initialFile?.revision;
let currentName = config.initialFile?.name;
let stop = false,
  timer: ReturnType<typeof setTimeout> | undefined;
if (vscode) vscode.postMessage({ type: 'ready' });

// A locally picked file supersedes the command-line file; do not unexpectedly switch it back.
let followServer = true;
app.addEventListener('modeldock:localfile', () => {
  followServer = false;
});
app.addEventListener('modeldock:loaded', (event) => {
  const detail = (event as CustomEvent).detail;
  if (
    config.host === 'standalone' &&
    currentName && detail.add !== true &&
    detail.name !== currentName.replace(/\\/g, '/').split('/').pop()
  )
    followServer = false;
});
async function poll(): Promise<void> {
  try {
    if (!stop && followServer && config.metadataUrl && document.visibilityState !== 'hidden') {
      const response = await fetch(config.metadataUrl, { cache: 'no-store' });
      if (response.ok) {
        const source = (await response.json()) as ModelSource;
        if (
          typeof source.name === 'string' &&
          typeof source.url === 'string' &&
          typeof source.revision === 'string' &&
          source.revision !== revision
        ) {
          revision = source.revision;
          currentName = source.name;
          await viewer.load(source, { preserveView: true });
        }
      }
    }
  } catch {
    /* Retry transient atomic writes or server restarts at the next tick. */
  } finally {
    if (!stop) timer = setTimeout(() => void poll(), 1200);
  }
}
if (config.autoReload !== false && config.metadataUrl) timer = setTimeout(() => void poll(), 1200);
window.addEventListener(
  'pagehide',
  () => {
    stop = true;
    clearTimeout(timer);
    for (const item of pending.values()) { item.cleanup(); item.reject(new Error('Viewer closed.')); }
    viewer.dispose();
  },
  { once: true },
);
