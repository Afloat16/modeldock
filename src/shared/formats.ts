export const SUPPORTED_EXTENSIONS = [
  'ply',
  'stl',
  'obj',
  'off',
  'xyz',
  'pcd',
  'glb',
  'gltf',
  'step',
  'stp',
  'iges',
  'igs',
  'brep',
  'brp',
] as const;
export const CAD_EXTENSIONS = new Set<string>(['step', 'stp', 'iges', 'igs', 'brep', 'brp']);
export function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}
export function isSupported(name: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}
export function fileNameOf(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() || name;
}
