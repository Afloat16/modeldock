import type { ViewerAssets } from '../../../src/shared/types.js';

/** A resource address is opaque for access; only its displayed filename is used. */
export function nameFromResourceAddress(address: string): string {
  const withoutQuery = address.split(/[?#]/, 1)[0] ?? '';
  const encodedName = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  let decodedName = encodedName;
  try { decodedName = decodeURIComponent(encodedName); } catch { /* Keep malformed escapes literal. */ }
  return decodedName.replace(/\\/g, '/').split('/').pop() || 'model';
}

/** Copy borrowed Harness data before a decoder transfers ownership to its Worker. */
export function copyDocumentBytes(bytes: Uint8Array): ArrayBuffer {
  const result = new Uint8Array(bytes.byteLength);
  result.set(bytes);
  return result.buffer;
}

/** Small session-only cache: host reloads may destroy and recreate a preview. */
export function createViewStateCache<T>(limit = 32) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid view-state cache limit.');
  const entries = new Map<string, T>();
  return {
    get(address: string): T | undefined {
      const value = entries.get(address);
      if (value === undefined) return undefined;
      entries.delete(address);
      entries.set(address, value);
      return structuredClone(value);
    },
    set(address: string, value: T): void {
      entries.delete(address);
      entries.set(address, structuredClone(value));
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
    clear(): void { entries.clear(); },
  };
}

export interface EmbeddedSources {
  workerSource: string;
  occtSource: string;
  occtWasmBase64: string;
}

export interface AssetLease {
  readonly assets: ViewerAssets;
  release(): void;
}

export interface BlobUrlApi {
  create(blob: Blob): string;
  revoke(url: string): void;
}

/**
 * One lazy, reference-counted pool per plugin instance. Multiple preview tabs
 * share the sizable CAD runtime bytes; the final close releases every Blob URL.
 */
export function createEmbeddedAssetPool(
  sources: EmbeddedSources,
  api: BlobUrlApi = {
    create: blob => URL.createObjectURL(blob),
    revoke: url => URL.revokeObjectURL(url),
  },
): { retain(): AssetLease; dispose(): void } {
  let assets: ViewerAssets | undefined;
  let holders = 0;
  let disposed = false;

  const revoke = (): void => {
    if (!assets) return;
    for (const url of Object.values(assets)) api.revoke(url);
    assets = undefined;
  };

  return {
    retain(): AssetLease {
      if (disposed) throw new Error('ModelDock plugin has been unloaded.');
      if (!assets) {
        const created: string[] = [];
        const create = (blob: Blob): string => {
          const url = api.create(blob);
          created.push(url);
          return url;
        };
        try {
          const binary = atob(sources.occtWasmBase64);
          const wasm = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) wasm[i] = binary.charCodeAt(i);
          assets = {
            worker: create(new Blob([sources.workerSource], { type: 'text/javascript' })),
            occtJs: create(new Blob([sources.occtSource], { type: 'text/javascript' })),
            occtWasm: create(new Blob([wasm], { type: 'application/wasm' })),
          };
        } catch (error) {
          for (const url of created) api.revoke(url);
          throw error;
        }
      }
      holders++;
      let released = false;
      const currentAssets = assets;
      return {
        assets: currentAssets,
        release(): void {
          if (released) return;
          released = true;
          holders = Math.max(0, holders - 1);
          if (!holders) revoke();
        },
      };
    },
    dispose(): void {
      disposed = true;
      revoke();
    },
  };
}
