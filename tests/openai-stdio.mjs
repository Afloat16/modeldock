/** Exercise the distributable CJS server over real MCP stdio, after npm run build. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/sdk/shared/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtHtml = await readFile(path.join(root, 'dist/openai/viewer.html'), 'utf8');
assert(Buffer.byteLength(JSON.stringify(builtHtml)) < 9 * 1024 * 1024, 'The self-contained UI must leave JSON-RPC overhead within the default 10 MiB stdio buffer.');
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/mcp.cjs')], cwd: root, stderr: 'inherit' });
const client = new Client({ name: 'modeldock-stdio-test', version: '1.0.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 3);
    const viewerTool = tools.find(tool => tool.name === 'modeldock_viewer');
    assert.ok(viewerTool);
  assert.equal(viewerTool.name, 'modeldock_viewer');
  assert.equal(viewerTool.annotations?.readOnlyHint, true);
  assert.deepEqual(viewerTool._meta?.ui, { resourceUri: 'ui://modeldock/viewer', visibility: ['app'] });
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map(item => item.uri), ['ui://modeldock/viewer']);
  const resource = await client.readResource({ uri: 'ui://modeldock/viewer' });
  const content = resource.contents[0];
  assert.equal(content.mimeType, 'text/html;profile=mcp-app');
  assert('text' in content && content.text.length > 1_000_000, 'Built HTML must include the bundled viewer and CAD assets');
  assert.equal(content.text, builtHtml);
  const wireBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: resource })) + 1;
  assert(wireBytes < STDIO_DEFAULT_MAX_BUFFER_SIZE, 'The complete JSON-RPC resource response must fit the unmodified SDK stdio buffer.');
  const call = await client.callTool({ name: 'modeldock_viewer', arguments: { file: { name: 'model.ply', resourceUri: 'host-test://selected' } } });
  assert.equal(call.isError, undefined);
  assert.deepEqual(call.content, []);
  await assert.rejects(client.readResource({ uri: 'file:///arbitrary-file' }), /not found|unknown/i);
  const report = {
    kind: 'real SDK client and bundled server over stdio',
    checks: ['initialize', 'tools/list and app-only file metadata', 'resources/list', 'resources/read bundled HTML', 'tools/call without model file access', 'unknown URI rejected'],
    htmlBytes: Buffer.byteLength(content.text),
    resourceJsonBytes: wireBytes,
    defaultStdioMaxBytes: STDIO_DEFAULT_MAX_BUFFER_SIZE,
  };
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/openai-stdio.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await client.close(); }
