import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createViewerServer } from './server.js';

/** Bundled as dist/mcp.cjs, beside the openai/viewer.html payload. */
async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('ModelDock MCP file viewer\n\nRun this entry through a local MCP host over stdio.\nExample: codex mcp add modeldock -- node /absolute/path/modeldock/dist/mcp.cjs\n\nDesktop file-entrypoint support is required for native model viewing.\nCodex CLI itself has no graphical preview; use the VS Code extension or modeldock CLI.\n');
    return;
  }
  const viewerPath = path.join(__dirname, 'openai', 'viewer.html');
  let cachedHtml: Promise<string> | undefined;
  const server = createViewerServer(() => cachedHtml ??= readFile(viewerPath, 'utf8'));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const stop = (): void => { void server.close().catch(() => {}).finally(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch(error => {
  // stdout is reserved for JSON-RPC while serving.
  process.stderr.write(`ModelDock MCP: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
