import { DEFAULT_MAX_FILE_BYTES } from '../shared/types.js';
export interface CliOptions {
  filePath?: string;
  port: number;
  maxFileBytes: number;
  open: boolean;
  autoReload: boolean;
  help: boolean;
}

export function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = { port: 0, maxFileBytes: DEFAULT_MAX_FILE_BYTES, open: false, autoReload: true, help: false };
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && (arg === '--help' || arg === '-h')) { result.help = true; continue; }
    if (!positionalOnly && arg === '--open') { result.open = true; continue; }
    if (!positionalOnly && arg === '--no-reload') { result.autoReload = false; continue; }
    if (!positionalOnly && (arg === '--port' || arg === '--max-size-mb')) {
      const raw = args[++i];
      if (!raw || !/^\d+$/.test(raw)) throw new Error(`${arg} requires a positive integer${arg === '--port' ? ' (or 0 for an automatic port)' : ''}.`);
      const value = Number(raw);
      if (arg === '--port') {
        if (value > 65535) throw new Error('--port must be between 0 and 65535.');
        result.port = value;
      } else {
        if (value < 1 || value > 1048576) throw new Error('--max-size-mb must be between 1 and 1048576.');
        result.maxFileBytes = value * 1048576;
      }
      continue;
    }
    if (!positionalOnly && arg.startsWith('-')) throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
    if (result.filePath) throw new Error('Select one model file at a time. Open another ModelDock instance for another file.');
    result.filePath = arg;
  }
  return result;
}

export const HELP = `ModelDock — local 3D model preview

Usage: modeldock [model-file | directory] [options]

  --open              Open the private viewer URL in the default browser
  --port N            Local port (default: 0, choose an available port)
  --max-size-mb N      Source ceiling in MiB (default: 8192; maximum: 1048576)
  --no-reload          Disable automatic refresh for a selected file
  -h, --help          Show this help
  --                  Treat remaining arguments as filenames

Supported: PLY, STL, OBJ, OFF, XYZ, PCD, GLB, glTF, STEP, IGES, BREP.
With no file (or a directory), use Open model or drag a model into the viewer.
Large binary PLY/STL use bounded sampled previews. Add comparison files in the viewer.
Only the explicitly selected model is served. Directories are never exposed.
Keep the process running; press Ctrl+C to stop the private local server.
`;
