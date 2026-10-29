/** Real browser/worker test with a simulated MCP App host, not a Desktop install. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewerHtml = await readFile(path.join(root, 'dist/openai/viewer.html'));
let selected = { name: 'demo-arch-cloud.ply', uri: 'host-selected://one' };
let bytes = await readFile(path.join(root, 'fixtures', selected.name));
const reads = [];
const subscriptions = [];
const hostHtml = `<!doctype html><html><head><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style></head><body><iframe src="/viewer"></iframe><script>
const child=document.querySelector('iframe');
const supported=new URL(location.href).searchParams.get('cap')!=='0';
let input={file:{name:'demo-arch-cloud.ply',resourceUri:'host-selected://one'}};
const send=message=>child.contentWindow.postMessage({jsonrpc:'2.0',...message},location.origin);
window.selectFile=file=>{input={file};send({method:'ui/notifications/tool-input',params:{arguments:input}});};
window.changed=uri=>send({method:'notifications/resources/updated',params:{uri}});
window.addEventListener('message',async event=>{
  if(event.source!==child.contentWindow||event.origin!==location.origin)return;
  const request=event.data;
  if(!request||request.jsonrpc!=='2.0'||!request.method)return;
  let result;
  if(request.method==='ui/initialize'){
    // Exercise early input delivery while connect() is still completing.
    send({method:'ui/notifications/tool-input',params:{arguments:input}});
    result={protocolVersion:request.params.protocolVersion,hostInfo:{name:'ModelDock protocol test host',version:'1.0.0'},hostCapabilities:supported?{experimental:{'openai/resource':{}}}:{},hostContext:{theme:'dark',displayMode:'inline',availableDisplayModes:['inline'],platform:'desktop'}};
  }else if(request.method==='resources/read'){
    result=await fetch('/resource?uri='+encodeURIComponent(request.params.uri)).then(r=>r.json());
  }else if(request.method==='resources/subscribe'||request.method==='resources/unsubscribe'){
    await fetch('/subscription',{method:'POST',body:JSON.stringify({method:request.method,uri:request.params.uri})});result={};
  }else if(request.id!==undefined){result={};}
  if(request.id!==undefined)send({id:request.id,result});
});
</script></body></html>`;

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/viewer') {
    // A controlled sandbox permits WASM but not JS eval. Real hosts choose their policy.
    response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src blob:; worker-src blob:" });
    response.end(viewerHtml.toString('utf8').replace('<script>', '<script nonce="modeldock-test-nonce">'));
  } else if (url.pathname === '/resource') {
    const uri = url.searchParams.get('uri'); reads.push(uri);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ contents: uri === selected.uri ? [{ uri, blob: bytes.toString('base64'), _meta: { 'openai/resource': { etag: String(bytes.length) } } }] : [] }));
  } else if (url.pathname === '/subscription') {
    let body = ''; for await (const chunk of request) body += chunk;
    subscriptions.push(JSON.parse(body)); response.end('{}');
  } else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(hostHtml); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = [];
try {
  browser = await chromium.launch({ executablePath: process.env.MODELDOCK_BROWSER, headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, locale: 'en-US' });
  const errors = [], remote = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) remote.push(request.url()); });
  await page.goto(origin);
  const frame = page.frameLocator('iframe');
  const model = frame.locator('.md-app');
  await model.locator('[data-role="vertices"]').waitFor();
  await frame.locator('.md-app[data-state="ready"][data-vertices="48000"]').waitFor({ timeout: 60000 });
  assert.equal(await frame.locator('#bridge-status').isVisible(), false);
  assert.equal(await frame.locator('script[src^="blob:"]').evaluate(element => element.nonce), 'modeldock-test-nonce');
  assert.deepEqual(reads, [selected.uri]);
  checks.push('Early tool input survives the SDK handshake and 48,000-point PLY renders through a Blob worker');
  const canvas = frame.locator('canvas.md-canvas');
  const rect = await canvas.boundingBox(); assert(rect);
  const before = await model.getAttribute('data-camera');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2 + 100, rect.y + rect.height / 2 + 40, { steps: 10 }); await page.mouse.up();
  // OrbitControls damping continues after mouse-up; wait for a stable pose.
  let previousPose = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    const pose = await model.getAttribute('data-camera');
    if (pose === previousPose) break;
    previousPose = pose;
    await page.waitForTimeout(100);
  }
  assert.notEqual(await model.getAttribute('data-camera'), before);
  const rotated = await model.getAttribute('data-camera');
  bytes = await readFile(path.join(root, 'fixtures/colored-mesh.ply'));
  await page.evaluate(uri => window.changed(uri), selected.uri);
  await frame.locator('.md-app[data-state="ready"][data-triangles="4096"]').waitFor({ timeout: 30000 });
  const oldPose = rotated.split(',').map(Number);
  const newPose = (await model.getAttribute('data-camera')).split(',').map(Number);
  // OrbitControls can retain sub-threshold inertia after it stops requesting
  // frames. A subsequent render may advance it slightly; fitting a new model
  // would move far beyond this 0.1% positional tolerance.
  const cameraDistance = Math.hypot(...oldPose.slice(0, 3));
  assert(Math.hypot(...newPose.slice(0, 3).map((value, index) => value - oldPose[index])) < cameraDistance * 0.001);
  assert.deepEqual(newPose.slice(3), oldPose.slice(3));
  checks.push('Resource-update notification replaces geometry and preserves the rotated camera within 0.1% damping tolerance');
  selected = { name: 'mounting-bracket.step', uri: 'host-selected://two' };
  bytes = await readFile(path.join(root, 'fixtures', selected.name));
  await page.evaluate(file => window.selectFile(file), { name: selected.name, resourceUri: selected.uri });
  await frame.locator('.md-app[data-state="ready"][data-filename="mounting-bracket.step"]').waitFor({ timeout: 60000 });
  assert(Number(await model.getAttribute('data-triangles')) > 100);
  checks.push('STEP renders with embedded OpenCascade WASM under a controlled CSP without JavaScript unsafe-eval');
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test-results/openai-simulated-host.png') });
  assert(subscriptions.some(item => item.method === 'resources/unsubscribe' && item.uri === 'host-selected://one'));
  assert(subscriptions.some(item => item.method === 'resources/subscribe' && item.uri === 'host-selected://two'));
  checks.push('Switching the selected file releases the previous host resource subscription');
  await page.goto(`${origin}/?cap=0`);
  await page.frameLocator('iframe').locator('#bridge-status[data-state="unsupported"]').waitFor({ timeout: 15000 });
  assert.equal(await page.frameLocator('iframe').locator('.md-app').count(), 0);
  checks.push('A host without openai/resource receives a clear unsupported-host message');
  const readsBeforeUnsupportedBrowser = reads.length;
  await page.addInitScript(() => { Object.defineProperty(window, 'DecompressionStream', { value: undefined, configurable: true }); });
  await page.goto(origin);
  await page.frameLocator('iframe').getByText(/Update the Desktop application, or use the ModelDock VS Code extension or local viewer/).waitFor();
  assert.equal(reads.length, readsBeforeUnsupportedBrowser);
  checks.push('Compressed startup preserves an injected script nonce and gives an actionable error when DecompressionStream is unavailable');
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  checks.push('No uncaught page errors or external network requests');
  const report = { kind: 'simulated MCP App host; not a real Desktop installation', passed: checks.length, checks };
  await writeFile(path.join(root, 'test-results/openai-browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
