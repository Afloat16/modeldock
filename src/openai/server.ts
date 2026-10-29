import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SUPPORTED_EXTENSIONS, isSupported } from '../shared/formats.js';
import { getResourcePath } from '@openai/mcp-extensions';
import { selectedFileInfo, readSelectedRange } from '../host/selected-file.js';
import { MAX_RANGE_BYTES } from '../shared/types.js';

export const VIEWER_RESOURCE_URI = 'ui://modeldock/viewer';
export const VIEWER_TOOL_NAME = 'modeldock_viewer';
export const VIEWER_MIME_TYPE = 'text/html;profile=mcp-app';

export const VIEWER_TOOL_METADATA = {
  ui: { resourceUri: VIEWER_RESOURCE_URI, visibility: ['app'] },
  'openai/ui': {
    entrypoints: [{ type: 'file', extensions: SUPPORTED_EXTENSIONS.map(extension => `.${extension}`) }],
  },
};

/**
 * Registers a read-only UI and bounded reads of the selected host file. Paths
 * come exclusively from host-injected metadata, never from app tool arguments.
 */
export function createViewerServer(readViewerHtml: () => Promise<string>): McpServer {
  const server = new McpServer({ name: 'modeldock', version: '0.2.0' }, {
    instructions: 'ModelDock is a read-only 3D file viewer. Open a supported model file through a Desktop file entrypoint. The host authorizes file bytes through an opaque resource URI; this server provides no arbitrary file-read, upload, or write tools.',
  });

  const selectedFileTool = {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  };
  const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: error && typeof error === 'object' && 'code' in error ? 'The selected host file is unavailable or cannot be read.' : error instanceof Error ? error.message : 'Unable to read the selected host file.' }] });
  server.registerTool('modeldock_file_info', {
    ...selectedFileTool, title: 'Selected model metadata',
    description: 'Read the size and revision of the host-selected model, without loading its bytes. Requires host-injected file context.',
    inputSchema: z.object({}).strict(),
  }, async (_args, extra) => {
    try {
      const filePath = getResourcePath(extra._meta);
      if (!filePath) return { isError: true, structuredContent: { reason: 'HOST_FILE_CONTEXT_REQUIRED' }, content: [{ type: 'text' as const, text: 'The host did not supply selected-file context. Use its file entrypoint or select a local model.' }] };
      return { content: [], structuredContent: { ...await selectedFileInfo(filePath) } };
    } catch (error) { return failure(error); }
  });
  server.registerTool('modeldock_read_range', {
    ...selectedFileTool, title: 'Read selected model byte range',
    description: 'Read up to 4 MiB from the host-selected model. The caller cannot choose a filesystem path.',
    inputSchema: z.object({ offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), length: z.number().int().min(1).max(MAX_RANGE_BYTES), revision: z.string().min(1).max(250) }).strict(),
  }, async ({ offset, length, revision }, extra) => {
    try {
      const filePath = getResourcePath(extra._meta);
      if (!filePath) throw new Error('The host did not supply selected-file context.');
      const bytes = await readSelectedRange(filePath, revision, offset, length, undefined, extra.signal);
      return { content: [], structuredContent: { offset, length, revision, base64: Buffer.from(bytes).toString('base64') } };
    } catch (error) { return failure(error); }
  });

  server.registerResource('ModelDock 3D Viewer', VIEWER_RESOURCE_URI, {
    title: 'ModelDock 3D & CAD Preview',
    description: 'A bundled local viewer for reconstruction models and CAD files.',
    mimeType: VIEWER_MIME_TYPE,
  }, async uri => ({
    contents: [{
      uri: uri.href,
      mimeType: VIEWER_MIME_TYPE,
      text: await readViewerHtml(),
      _meta: {
        ui: {
          prefersBorder: false,
          csp: {
            // Only local object URLs; the preview has no network service.
            connectDomains: ['blob:'],
            resourceDomains: ['blob:'],
          },
        },
      },
    }],
  }));

  server.registerTool(VIEWER_TOOL_NAME, {
    title: 'ModelDock 3D Viewer',
    description: 'Read-only preview of the model file selected through the host file viewer.',
    inputSchema: {
      file: z.object({
        name: z.string().min(1).max(1024).refine(name => !/[\\/]/.test(name), 'Expected a filename, not a path.'),
        resourceUri: z.string().trim().min(1).max(16384),
      }).strict(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: VIEWER_TOOL_METADATA,
  }, async ({ file }) => {
    if (!isSupported(file.name)) {
      return { isError: true, content: [{ type: 'text' as const, text: 'This file extension is not supported by ModelDock.' }] };
    }
    // Input is delivered separately to the MCP App. Do not echo the URI or read it here.
    return { content: [] };
  });

  return server;
}
