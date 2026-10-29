/** Serializable, host-independent data shared by the adapters, decoder and viewer. */
export interface ModelPrimitive {
  name: string;
  mode: 'triangles' | 'points' | 'lines';
  positions: Float32Array;
  normals?: Float32Array;
  colors?: Float32Array;
  indices?: Uint32Array;
  color?: [number, number, number];
}

export interface ParsedModel {
  primitives: ModelPrimitive[];
  warnings: string[];
  sourceFormat: string;
  units: string;
  /** Positions are local to this double-precision source origin when rebased. */
  origin?: [number, number, number];
}

/** Source-size ceiling, independent from decoded preview and transport budgets. */
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 ** 3;
export const IN_MEMORY_FILE_BYTES = 128 * 1024 ** 2;
export const MAX_RANGE_BYTES = 4 * 1024 ** 2;

export interface DecodeOptions {
  cadQuality: 'low' | 'medium' | 'high';
  maxVertices: number;
  maxTriangles: number;
}

export const DEFAULT_LIMITS: DecodeOptions = {
  cadQuality: 'medium',
  maxVertices: 10_000_000,
  maxTriangles: 10_000_000,
};

export interface ViewerAssets {
  worker: string;
  occtJs: string;
  occtWasm: string;
}

export interface ModelSource {
  name: string;
  url?: string;
  data?: ArrayBuffer;
  revision?: string;
  size?: number;
  /** Browser-selected files remain sliceable; do not materialize large files. */
  blob?: Blob;
  /** Host-authorized bounded reads; never serialized into HTML config. */
  readRange?: (offset: number, length: number, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Opaque host capability used by the VS Code bridge. */
  sourceId?: string;
}

export interface ViewerConfig extends Partial<DecodeOptions> {
  host: 'vscode' | 'standalone' | 'deepseek' | 'openai';
  assets: ViewerAssets;
  maxFileBytes?: number;
  initialFile?: ModelSource;
  allowFilePicker?: boolean;
  autoReload?: boolean;
  metadataUrl?: string;
  language?: 'en' | 'zh-CN';
  /** Optional native multi-file picker (e.g. remote VS Code workspace). */
  pickFiles?: () => Promise<ModelSource[]>;
}

export interface ViewerHandle {
  load(source: ModelSource, options?: { preserveView?: boolean }): Promise<void>;
  add?(source: ModelSource): Promise<void>;
  dispose(): void;
  showError?(message: string): void;
  getViewState?(): ViewerViewState | undefined;
  setViewState?(state: ViewerViewState): void;
}

/** Small, geometry-free state for hosts that recreate their preview on updates. */
export interface ViewerViewState {
  position: [number, number, number];
  target: [number, number, number];
  upAxis: 'y' | 'z';
  projection: 'perspective' | 'orthographic';
  zoom: number;
  orthographicHeight?: number;
}
