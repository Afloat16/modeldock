/** Pure geometry API. Coordinates and thresholds share one explicitly chosen unit. */
export type Vec3 = [number, number, number];
export interface RigidTransform {
  /** Row-major proper rotation; p' = R p + t. Never includes scale or reflection. */
  rotation: [number, number, number, number, number, number, number, number, number];
  translation: Vec3;
}
export interface ComparePrimitive {
  positions: Float32Array | Float64Array;
  indices?: Uint32Array;
  mode: 'triangles' | 'points' | 'lines';
}
export interface CompareModel {
  id: string;
  name?: string;
  unit?: string;
  units?: string;
  /** Positions are relative to this double precision source origin. */
  origin?: Vec3;
  primitives: ComparePrimitive[];
  /** Large-file preview provenance is carried into every report. */
  preview?: object;
}
export interface Progress { stage: string; completed: number; total: number }
export interface WorkOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  /** Number of query samples per model; default 10,000, maximum 200,000. */
  sampleBudget?: number;
  seed?: number;
}
export interface EvaluationOptions extends WorkOptions {
  threshold: number;
  /** Explicit acknowledgment that both coordinate sets use this unit. No conversion occurs. */
  unit?: string;
  sourceTransform?: RigidTransform;
  alignment?: 'none' | 'rigid-icp' | 'landmarks' | 'manual';
  /** Exact triangle targets below this bound; default 200,000; maximum 500,000. */
  maxSurfaceTriangles?: number;
  /** Full cloud targets below this bound; otherwise a deterministic subset. */
  targetPointBudget?: number;
  includeDistances?: boolean;
}
export interface AlignmentOptions extends WorkOptions {
  unit?: string;
  maxIterations?: number;
  maxCorrespondenceDistance?: number;
  minInlierFraction?: number;
  /** Closest fraction of valid correspondences retained for each fit. Default .9. */
  trimFraction?: number;
  tolerance?: number;
  initialTransform?: RigidTransform;
}
export interface AlignmentResult {
  transform: RigidTransform;
  converged: boolean;
  iterations: number;
  initialRmse: number;
  finalRmse: number;
  inlierFraction: number;
  diagnostics: string[];
  sampleBudget: number;
  seed: number;
}
export interface DistanceSummary {
  count: number;
  mean: number;
  rmse: number;
  median: number;
  p95: number;
  /** Maximum among query samples. This is never an exact Hausdorff distance. */
  approximateMax: number;
  withinThreshold: number;
}
export interface SamplingInfo {
  method: 'area-weighted-surface' | 'uniform-point-subset';
  queries: number;
  availablePoints: number;
  availableTriangles: number;
  queryCoverage: 'sampled-surface' | 'all-points' | 'sampled-points';
  targetMethod: 'exact-triangle-bvh' | 'all-points-kdtree' | 'sampled-points-kdtree' | 'sampled-surface-kdtree';
  targetCount: number;
  sourcePreview?: object;
}
export interface ComparisonReport {
  schema: 'modeldock.comparison.v1';
  createdAt: string;
  source: { id: string; name?: string; origin: Vec3; sampling: SamplingInfo };
  reference: { id: string; name?: string; origin: Vec3; sampling: SamplingInfo };
  unit: string;
  threshold: number;
  sampleBudget: number;
  seed: number;
  alignment: { method: string; applied: boolean; transform: RigidTransform; scale: 1 };
  accuracy: DistanceSummary;
  completeness: DistanceSummary;
  chamfer: { value: number; definition: '0.5 * (mean(source-to-reference distance) + mean(reference-to-source distance))'; squared: false };
  precision: number;
  recall: number;
  fScore: number;
  warnings: string[];
  /** Optional values for a sample heatmap, in absolute source coordinates after alignment. */
  distances?: { sourcePoints: number[]; sourceToReference: number[]; referencePoints: number[]; referenceToSource: number[] };
}
export function identityTransform(): RigidTransform {
  return { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] };
}
export function validateBudget(value: number | undefined, fallback: number, max: number, name: string): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 3 || n > max) throw new Error(`${name} must be an integer between 3 and ${max}.`);
  return n;
}
export async function checkpoint(options: WorkOptions, stage: string, completed: number, total: number): Promise<void> {
  if (options.signal?.aborted) throw new DOMException('Comparison cancelled.', 'AbortError');
  options.onProgress?.({ stage, completed, total });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (options.signal?.aborted) throw new DOMException('Comparison cancelled.', 'AbortError');
}
