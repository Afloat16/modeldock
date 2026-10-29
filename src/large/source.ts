/** No offset is coerced to 32 bits: JavaScript safe integers cover files up to 8 PiB. */
export interface RandomAccessSource {
  name: string;
  size: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Loading cancelled.', 'AbortError');
}

export function safeInteger(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}.`);
  return value;
}

function range(size: number, offset: number, length: number): void {
  safeInteger(size, 'Source size'); safeInteger(offset, 'Read offset'); safeInteger(length, 'Read length');
  if (!Number.isSafeInteger(offset + length) || offset + length > size) throw new Error('Read range is outside the source.');
}

/** File/Blob slicing never materializes the full input. */
export function sourceFromBlob(blob: Blob, name = (blob as File).name || 'model.ply'): RandomAccessSource {
  safeInteger(blob.size, 'Source size');
  return {
    name, size: blob.size,
    async read(offset, length, signal) {
      range(blob.size, offset, length); abortIfNeeded(signal);
      const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
      abortIfNeeded(signal);
      if (bytes.length !== length) throw new Error('Blob range was truncated.');
      return bytes;
    },
  };
}

export interface HttpSourceOptions {
  name?: string;
  size?: number;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

/**
 * Requires genuine 206 ranges; a server returning 200 is cancelled before reading.
 * Cross-origin hosts must expose Content-Range (and preferably ETag) to the browser.
 */
export async function sourceFromHttp(url: string, options: HttpSourceOptions = {}): Promise<RandomAccessSource> {
  const fetcher = options.fetch ?? globalThis.fetch;
  let size = options.size === undefined ? undefined : safeInteger(options.size, 'Source size', 1);
  let validator: string | undefined;
  let validatorHeader: 'etag' | 'last-modified' | undefined;
  const request = async (offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> => {
    abortIfNeeded(signal);
    const headers = new Headers(options.headers);
    headers.set('Range', `bytes=${offset}-${offset + length - 1}`);
    if (validator) headers.set('If-Range', validator);
    const response = await fetcher(url, { headers, signal, cache: 'no-store' });
    const reject = async (message: string): Promise<never> => {
      await response.body?.cancel().catch(() => {});
      throw new Error(message);
    };
    if (response.status !== 206) return reject(`HTTP server must support byte ranges (206), received ${response.status}.`);
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (!match) return reject('Missing or invalid HTTP Content-Range.');
    const [start, end, total] = match.slice(1).map(Number);
    if (![start, end, total].every(Number.isSafeInteger) || total <= 0 || start !== offset || end !== offset + length - 1 || end >= total || (size !== undefined && total !== size)) return reject('HTTP Content-Range does not match the requested range or source size.');
    size ??= total;
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') return reject('Compressed HTTP byte ranges are unsupported.');
    const statedLength = response.headers.get('content-length');
    if (statedLength !== null && (!/^\d+$/.test(statedLength) || Number(statedLength) !== length)) return reject('HTTP Content-Length does not match the range.');
    if (validatorHeader && response.headers.get(validatorHeader) !== validator) return reject('HTTP source changed while loading.');
    if (!validatorHeader) {
      const etag = response.headers.get('etag');
      const modified = response.headers.get('last-modified');
      if (etag && !etag.startsWith('W/')) { validator = etag; validatorHeader = 'etag'; }
      else if (modified) { validator = modified; validatorHeader = 'last-modified'; }
    }
    if (!response.body) return reject('HTTP byte range response has no body.');
    const reader = response.body.getReader();
    const bytes = new Uint8Array(length);
    let written = 0;
    try {
      while (true) {
        abortIfNeeded(signal);
        const next = await reader.read();
        if (next.done) break;
        if (written + next.value.length > length) throw new Error('HTTP range response exceeds the requested length.');
        bytes.set(next.value, written); written += next.value.length;
      }
    } finally { await reader.cancel().catch(() => {}); }
    abortIfNeeded(signal);
    if (written !== length) throw new Error('HTTP byte range response is truncated.');
    return bytes;
  };
  // Probe even when the caller supplied a size: verify range support before loading.
  await request(0, 1, options.signal);
  let name = options.name;
  if (!name) {
    try { name = decodeURIComponent(new URL(url, 'http://localhost').pathname.split('/').pop() || 'model.ply'); }
    catch { name = 'model.ply'; }
  }
  return { name, size: size!, async read(offset, length, signal) {
    range(size!, offset, length); abortIfNeeded(signal);
    return length ? request(offset, length, signal) : new Uint8Array(0);
  } };
}
