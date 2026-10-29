import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FileHandle } from 'node:fs/promises';
import { DEFAULT_LIMITS, DEFAULT_MAX_FILE_BYTES, MAX_RANGE_BYTES, type ModelSource, type ViewerConfig } from '../shared/types';
import { isSupported } from '../shared/formats';
import { renderViewerHtml } from '../extension/webview';

const STATIC_FILES = new Map([
  ['viewer.js', 'text/javascript; charset=utf-8'],
  ['styles.css', 'text/css; charset=utf-8'],
  ['worker.js', 'text/javascript; charset=utf-8'],
  ['occt-import-js.js', 'text/javascript; charset=utf-8'],
  ['occt-import-js.wasm', 'application/wasm'],
]);

export interface ViewerServerOptions {
  filePath?: string;
  assetsPath?: string;
  port?: number;
  maxFileBytes?: number;
  autoReload?: boolean;
  language?: 'en' | 'zh-CN';
}

export interface ViewerServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * A private, loopback-only viewer. A random capability URL authorizes exactly the
 * selected file and a fixed list of packaged assets; there is no directory route.
 * The capability is never forwarded to third-party hosts or stored in cookies.
 */
export async function startViewerServer(options: ViewerServerOptions = {}): Promise<ViewerServer> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 1024 ** 4) {
    throw new Error('maxFileBytes must be an integer between 1 byte and 1 TiB.');
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  const assetsPath = await realpath(options.assetsPath ?? resolve('dist', 'web'));
  const modelPath = options.filePath ? resolve(options.filePath) : undefined;
  if (modelPath && !isSupported(modelPath)) throw new Error('Unsupported model file extension.');
  const modelRealPath = modelPath ? await realpath(modelPath) : undefined;
  const token = randomBytes(32).toString('hex');
  const routeRoot = `/${token}/`;
  const assetRoute = `${routeRoot}assets/`;
  let boundPort = port;

  async function openModel(): Promise<FileHandle> {
    if (!modelPath || !modelRealPath) throw new HttpError(404, 'No model was selected. Use Open model or drop a file into the viewer.');
    try {
      // A symlink being repointed after startup must not expose a different file.
      if (await realpath(modelPath) !== modelRealPath) throw new HttpError(403, 'The selected model path now resolves to a different file. Restart ModelDock to select it.');
      const handle = await open(modelRealPath, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new HttpError(400, 'The selected path is not a regular file.');
        if (info.size > maxFileBytes) throw new HttpError(413, `The file exceeds the ${(maxFileBytes / 1048576).toFixed(0)} MiB size limit.`);
        return handle;
      } catch (error) { await handle.close(); throw error; }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(404, 'The selected file is unavailable. It may have been moved or deleted.');
    }
  }

  async function metadata(): Promise<ModelSource> {
    const handle = await openModel();
    try {
      const info = await handle.stat();
      const revision = `${info.mtimeMs}-${info.ctimeMs}-${info.size}`;
      return { name: basename(modelPath!), size: info.size, url: `${routeRoot}api/model?revision=${encodeURIComponent(revision)}`, revision };
    } finally { await handle.close(); }
  }

  // Fail early for a nonexistent, oversized or non-regular model.
  if (modelPath) await metadata();

  function send(response: ServerResponse, request: IncomingMessage, code: number, body: string, contentType = 'application/json; charset=utf-8') {
    response.statusCode = code;
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  async function streamHandle(handle: FileHandle, request: IncomingMessage, response: ServerResponse, type: string, model = false) {
    let ownsHandle = true;
    try {
      const info = await handle.stat();
      let start = 0, end = info.size - 1;
      if (model) {
        response.setHeader('Accept-Ranges', 'bytes');
        const requestedRevision = new URL(request.url ?? '', 'http://localhost').searchParams.get('revision');
        const revision = `${info.mtimeMs}-${info.ctimeMs}-${info.size}`;
        response.setHeader('ETag', `"${revision}"`);
        if (requestedRevision && requestedRevision !== revision) throw new HttpError(409, 'The model changed while reading. Reload the preview.');
        if (request.headers.range) {
          const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
          if (!match) { response.setHeader('Content-Range', `bytes */${info.size}`); throw new HttpError(416, 'Use one explicit byte range.'); }
          start = Number(match[1]); end = Number(match[2]);
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= info.size || end >= info.size || end - start + 1 > MAX_RANGE_BYTES) {
            response.setHeader('Content-Range', `bytes */${info.size}`);
            throw new HttpError(416, 'Invalid byte range; request at most 4 MiB within the selected file.');
          }
          response.statusCode = 206;
          response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
        }
      }
      response.setHeader('Content-Type', type);
      response.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (request.method === 'HEAD') { response.end(); return; }
      if (model && request.headers.range) {
        // A bounded buffer lets us verify one revision before returning any bytes.
        const bytes = Buffer.alloc(end - start + 1);
        let consumed = 0;
        while (consumed < bytes.length) {
          const next = await handle.read(bytes, consumed, bytes.length - consumed, start + consumed);
          if (!next.bytesRead) throw new HttpError(409, 'The selected file was truncated while reading.');
          consumed += next.bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new HttpError(409, 'The model changed during this byte range. Reload the preview.');
        response.end(bytes);
        return;
      }
      // createReadStream uses the checked descriptor, never a second path lookup.
      const stream = handle.createReadStream({ autoClose: true, ...(info.size ? { start, end } : {}) });
      ownsHandle = false;
      await pipeline(stream, response);
    } finally { if (ownsHandle) await handle.close(); }
  }

  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    void (async () => {
      const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
      const host = request.headers.host;
      if (!host || !allowedHosts.has(host)) throw new HttpError(403, 'Invalid local host.');
      if (request.headers.origin && request.headers.origin !== `http://${host}`) {
        throw new HttpError(403, 'Cross-origin access is not allowed.');
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site access is not allowed.');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        throw new HttpError(405, 'Only GET and HEAD are supported.');
      }
      const rawPath = (request.url ?? '').split('?', 1)[0];
      // No decoding or path normalization: only these exact routes are served.
      if (!rawPath.startsWith(routeRoot)) throw new HttpError(404, 'Not found. Use the private URL printed by ModelDock.');

      if (rawPath === routeRoot) {
        const nonce = randomBytes(24).toString('base64');
        const csp = [
          "default-src 'none'", `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
          "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
          "connect-src 'self' blob:", "worker-src 'self' blob:",
          "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
        ].join('; ');
        response.setHeader('Content-Security-Policy', csp);
        const config: ViewerConfig & { metadataUrl?: string } = {
          host: 'standalone', ...DEFAULT_LIMITS, maxFileBytes,
          // Workers execute from blob: URLs; their dependencies must be absolute.
          assets: { worker: `http://${host}${assetRoute}worker.js`, occtJs: `http://${host}${assetRoute}occt-import-js.js`, occtWasm: `http://${host}${assetRoute}occt-import-js.wasm` },
          allowFilePicker: true, autoReload: options.autoReload !== false,
          language: options.language ?? 'en',
          ...(modelPath ? { initialFile: await metadata(), metadataUrl: `${routeRoot}api/model.json` } : {}),
        };
        send(response, request, 200, renderViewerHtml({
          config, script: `${assetRoute}viewer.js`, stylesheet: `${assetRoute}styles.css`, nonce, csp,
        }), 'text/html; charset=utf-8');
        return;
      }
      if (rawPath === `${routeRoot}api/model.json`) {
        send(response, request, 200, JSON.stringify(await metadata()));
        return;
      }
      if (rawPath === `${routeRoot}api/model`) {
        await streamHandle(await openModel(), request, response, 'application/octet-stream', true);
        return;
      }
      if (rawPath.startsWith(assetRoute)) {
        const name = rawPath.slice(assetRoute.length);
        const mime = STATIC_FILES.get(name);
        if (!mime) throw new HttpError(404, 'Not found.');
        const target = join(assetsPath, name);
        // The five assets must be ordinary files in the packaged asset directory.
        if (await realpath(target) !== target) throw new HttpError(403, 'Invalid packaged asset.');
        const handle = await open(target, 'r');
        const info = await handle.stat();
        if (!info.isFile()) { await handle.close(); throw new HttpError(404, 'Not found.'); }
        await streamHandle(handle, request, response, mime);
        return;
      }
      throw new HttpError(404, 'Not found.');
    })().catch((error: unknown) => {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'Unable to read the packaged viewer. Rebuild with npm run build.';
      send(response, request, status, JSON.stringify({ error: message }));
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind local viewer.');
  boundPort = address.port;
  return {
    url: `http://127.0.0.1:${boundPort}${routeRoot}`, port: boundPort,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
      server.closeAllConnections();
    }),
  };
}
