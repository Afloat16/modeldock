/** Real native-app bundle + real MCP server; only the Desktop host is simulated. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, open, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createViewerServer } = await tsImport('../src/openai/server.ts', import.meta.url);
const html = await readFile(path.join(root, 'dist/openai/viewer.html'), 'utf8');
const resultsDirectory = path.join(root, 'test-results');
await mkdir(resultsDirectory, { recursive: true });
const fixtureDirectory = await mkdtemp(path.join(resultsDirectory, 'openai-range-sparse-'));
const GiB = 1024 ** 3, files = [], requests = [], subscriptions = [], resourceReads = [];
let selected, mutateDuringNextRange = false, httpServer, browser, server, client;

async function makeSparse(kind) {
  const stride = kind === 'ply' ? 24 : 50, count = Math.ceil(5 * GiB / stride) + 1;
  const filePath = path.join(fixtureDirectory, `native-5gib.${kind}`), handle = await open(filePath, 'w+');
  const header = kind === 'ply'
    ? Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${count}\nproperty double x\nproperty double y\nproperty double z\nend_header\n`)
    : Buffer.alloc(84);
  if (kind === 'stl') header.writeUInt32LE(count, 80);
  const size = header.length + count * stride;
  await handle.truncate(size); await handle.write(header, 0, header.length, 0);
  const record = (x, y, z) => {
    const bytes = Buffer.alloc(stride);
    if (kind === 'ply') { bytes.writeDoubleLE(x, 0); bytes.writeDoubleLE(y, 8); bytes.writeDoubleLE(z, 16); }
    else {
      bytes.writeFloatLE(1, 8);
      [x, y, z, x + 1, y, z, x, y + 1, z].forEach((value, k) => bytes.writeFloatLE(value, 12 + k * 4));
    }
    return bytes;
  };
  for (const [row, coordinates] of [[0, [0, 0, 0]], [Math.floor((count - 1) / 2), [1, 2, 3]], [count - 1, [3, 4, 5]]]) {
    const bytes = record(...coordinates); await handle.write(bytes, 0, bytes.length, header.length + row * stride);
  }
  const disk = await handle.stat();
  const file = { name: path.basename(filePath), path: filePath, uri: `host-selected://${kind}`, handle, size, count, headerLength: header.length, stride, record, allocatedBytes: disk.blocks * 512 };
  files.push(file); return file;
}

async function updateLastVertex(file, coordinates) {
  const bytes = file.record(...coordinates);
  await file.handle.write(bytes, 0, bytes.length, file.headerLength + (file.count - 1) * file.stride);
  const prior = await stat(file.path);
  // Force a distinct revision even on filesystems with coarse timestamp resolution.
  await utimes(file.path, new Date(), new Date(prior.mtimeMs + 2000));
}

const hostHtml = `<!doctype html><html><head><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style></head><body><iframe src="/viewer"></iframe><script>
const child=document.querySelector('iframe');
let input={file:{name:'native-5gib.ply',resourceUri:'host-selected://ply'}};
window.completed=[];
child.addEventListener('load',()=>child.contentDocument.addEventListener('modeldock:loaded',e=>window.completed.push(e.detail)));
const send=message=>child.contentWindow.postMessage({jsonrpc:'2.0',...message},location.origin);
window.selectFile=file=>{input={file};send({method:'ui/notifications/tool-input',params:{arguments:input}});};
window.changed=uri=>send({method:'notifications/resources/updated',params:{uri}});
window.addEventListener('message',async event=>{
  if(event.source!==child.contentWindow||event.origin!==location.origin)return;
  const request=event.data;if(!request||request.jsonrpc!=='2.0'||!request.method)return;
  let result;
  try {
    if(request.method==='ui/initialize'){
      send({method:'ui/notifications/tool-input',params:{arguments:input}});
      result={protocolVersion:request.params.protocolVersion,hostInfo:{name:'ModelDock real-range test host',version:'0.2.0'},hostCapabilities:{experimental:{'openai/resource':{}}},hostContext:{theme:'dark',displayMode:'inline',availableDisplayModes:['inline'],platform:'desktop'}};
    }else if(request.method==='tools/call'){
      // The app never receives the selected path. This HTTP hop represents the host.
      result=await fetch('/tool',{method:'POST',body:JSON.stringify(request.params)}).then(r=>r.json());
    }else if(request.method==='resources/read'){
      result=await fetch('/whole-resource',{method:'POST',body:JSON.stringify(request.params)}).then(r=>r.json());
    }else if(request.method==='resources/subscribe'||request.method==='resources/unsubscribe'){
      await fetch('/subscription',{method:'POST',body:JSON.stringify({method:request.method,uri:request.params.uri})});result={};
    }else result={};
    if(request.id!==undefined)send({id:request.id,result});
  }catch(error){if(request.id!==undefined)send({id:request.id,error:{code:-32603,message:String(error)}});}
});
</script></body></html>`;

const checks = [];
try {
  const ply = await makeSparse('ply'), stl = await makeSparse('stl'); selected = ply;
  server = createViewerServer(async () => html);
  client = new Client({ name: 'modeldock-browser-range-host', version: '0.2.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const advertised = await client.listTools();
  for (const name of ['modeldock_file_info', 'modeldock_read_range']) {
    const tool = advertised.tools.find(t => t.name === name); assert(tool, name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(JSON.stringify(tool.inputSchema).includes('path'), false);
  }
  // Obtain the served app from the real registered MCP resource.
  const resource = await client.readResource({ uri: 'ui://modeldock/viewer' });
  assert.equal(resource.contents[0].text, html);
  httpServer = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/viewer') {
        response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src blob:; worker-src blob:" });
        response.end(resource.contents[0].text); return;
      }
      let body = ''; for await (const chunk of request) body += chunk;
      if (url.pathname === '/tool') {
        const params = JSON.parse(body);
        assert(['modeldock_file_info', 'modeldock_read_range'].includes(params.name));
        assert.equal('path' in (params.arguments || {}), false);
        assert.equal(JSON.stringify(params).includes(fixtureDirectory), false);
        const entry = { name: params.name, arguments: params.arguments, file: selected.name };
        requests.push(entry);
        if (params.name === 'modeldock_read_range' && mutateDuringNextRange) {
          mutateDuringNextRange = false; await updateLastVertex(selected, [9, 8, 7]);
        }
        // Only the trusted host injects this metadata; app arguments cannot select a path.
        const result = await client.callTool({ ...params, _meta: { 'openai/resource': { path: selected.path } } });
        entry.isError = !!result.isError;
        if (params.name === 'modeldock_file_info') entry.info = result.structuredContent;
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result)); return;
      }
      if (url.pathname === '/subscription') { subscriptions.push(JSON.parse(body)); response.end('{}'); return; }
      if (url.pathname === '/whole-resource') { resourceReads.push(JSON.parse(body)); response.end(JSON.stringify({ contents: [] })); return; }
      response.writeHead(200, { 'content-type': 'text/html' }); response.end(hostHtml);
    } catch (error) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: String(error) }] })); }
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.MODELDOCK_BROWSER, headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [], remote = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) remote.push(request.url()); });
  await page.goto(origin);
  const frame = page.frameLocator('iframe'), app = frame.locator('.md-app');
  const waitForLoad = async count => {
    await page.waitForFunction(n => window.completed.length >= n, count, { timeout: 120000 });
    await frame.locator('.md-app[data-state="ready"]').waitFor({ timeout: 120000 });
  };
  await waitForLoad(1);
  assert.equal(await app.getAttribute('data-filename'), ply.name);
  assert.equal(await app.getAttribute('data-vertices'), '300000');
  assert.equal(await app.getAttribute('data-triangles'), '0');
  assert.match(await frame.locator('[data-role="warnings"]').textContent(), /retained samples only/);
  assert.match(await frame.locator('[data-role="comparison"]').textContent(), /sampled preview/);
  assert.equal(await frame.locator('canvas.md-canvas').isVisible(), true);
  checks.push('Actual >5 GiB PLY renders 300,000 sampled points through native OpenAI app and real selected-file MCP tools');
  const firstRanges = requests.filter(r => r.name === 'modeldock_read_range');
  assert(firstRanges.some(r => r.arguments.offset > 4 * GiB));
  assert(firstRanges.some(r => r.arguments.offset > 2 * GiB && r.arguments.offset < 3 * GiB));
  const initialDimensions = await frame.locator('[data-role="dimensions"]').textContent();
  const initialCamera = await app.getAttribute('data-camera');
  await updateLastVertex(ply, [6, 8, 10]);
  await page.evaluate(uri => window.changed(uri), ply.uri);
  await waitForLoad(2);
  assert.notEqual(await frame.locator('[data-role="dimensions"]').textContent(), initialDimensions);
  assert.equal(await app.getAttribute('data-camera'), initialCamera);
  const revisions = requests.filter(r => r.name === 'modeldock_file_info').map(r => r.info?.revision);
  assert.notEqual(revisions[0], revisions[1]);
  checks.push('Resource update obtains a fresh revision, replaces sampled geometry, and preserves camera');
  mutateDuringNextRange = true;
  await page.evaluate(uri => window.changed(uri), ply.uri);
  await frame.locator('[data-role="error"]:visible').waitFor({ timeout: 30000 });
  assert.match(await frame.locator('[data-role="error-message"]').textContent(), /changed while reading/);
  assert(requests.some(r => r.name === 'modeldock_read_range' && r.isError));
  assert.equal(await app.getAttribute('data-vertices'), '300000');
  checks.push('Mutation after metadata lookup is rejected by the real revision guard while prior geometry is retained');
  await page.evaluate(uri => window.changed(uri), ply.uri);
  await waitForLoad(3);
  assert.equal(await frame.locator('[data-role="error"]').isVisible(), false);
  checks.push('A later selected-resource update recovers from the stale revision without whole-file fallback');
  selected = stl;
  await page.evaluate(file => window.selectFile(file), { name: stl.name, resourceUri: stl.uri });
  await waitForLoad(4);
  assert.equal(await app.getAttribute('data-filename'), stl.name);
  assert.equal(await app.getAttribute('data-triangles'), '100000');
  assert.match(await frame.locator('[data-role="warnings"]').textContent(), /do not form a closed surface/);
  const stlRanges = requests.filter(r => r.file === stl.name && r.name === 'modeldock_read_range');
  assert(stlRanges.some(r => r.arguments.offset > 4 * GiB));
  checks.push('Actual >5 GiB STL renders 100,000 sampled surface triangles through the same native entrypoint');
  assert(subscriptions.some(s => s.method === 'resources/unsubscribe' && s.uri === ply.uri));
  assert(subscriptions.some(s => s.method === 'resources/subscribe' && s.uri === stl.uri));
  assert.deepEqual(resourceReads, []);
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
  const ranges = requests.filter(r => r.name === 'modeldock_read_range');
  assert(ranges.every(r => Number.isSafeInteger(r.arguments.offset) && r.arguments.length > 0 && r.arguments.length <= 4 * 1024 ** 2));
  const requestedBytes = ranges.reduce((n, r) => n + r.arguments.length, 0);
  assert(requestedBytes < 64 * 1024 ** 2);
  checks.push('All reads <=4 MiB, offsets exceed 4 GiB, no whole resources/read, no app-supplied paths, no uncaught errors or external requests');
  await page.screenshot({ path: path.join(resultsDirectory, 'openai-range-browser.png') });
  const report = { kind: 'real native app bundle + real SDK InMemory client/server; simulated Desktop host', passed: checks.length, checks, fixtures: files.map(f => ({ name: f.name, logicalBytes: f.size, allocatedBytes: f.allocatedBytes })), rangeRequests: ranges.length, requestedBytes, maximumChunkBytes: Math.max(...ranges.map(r => r.arguments.length)), largestOffset: Math.max(...ranges.map(r => r.arguments.offset)), rejectedRevisions: ranges.filter(r => r.isError).length, wholeResourceReads: resourceReads.length };
  await writeFile(path.join(resultsDirectory, 'openai-range-browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  await client?.close(); await server?.close();
  await Promise.all(files.map(f => f.handle.close()));
  await rm(fixtureDirectory, { recursive: true, force: true });
}
