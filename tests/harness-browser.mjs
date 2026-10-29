/** Native Harness UI smoke test. Start an isolated host and set MODELDOCK_HARNESS_URL. */
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { copyFile, rename, mkdir, writeFile, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostUrl = process.env.MODELDOCK_HARNESS_URL;
if (!hostUrl) throw new Error('Set MODELDOCK_HARNESS_URL to the URL printed by an isolated dsh --profile web host.');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(hostUrl).hostname)) throw new Error('This smoke test expects a local, isolated Harness host.');
const liveName = `harness-live-${process.pid}.ply`;
const livePath = path.join(root, 'test-results', liveName);
await mkdir(path.join(root, 'test-results'), { recursive: true });
await copyFile(path.join(root, 'fixtures/demo-arch-cloud.ply'), livePath);
const largePlyName = `harness-5gib-${process.pid}.ply`;
const largeStlName = `harness-5gib-${process.pid}.stl`;
const largePlyPath = path.join(root, 'test-results', largePlyName);
const largeStlPath = path.join(root, 'test-results', largeStlName);
const vertexCount = Math.ceil(5 * 1024 ** 3 / 24) + 1;
const header = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${vertexCount}\nproperty double x\nproperty double y\nproperty double z\nend_header\n`);
const ply = await open(largePlyPath, 'w+');
await ply.truncate(header.length + vertexCount * 24);
await ply.write(header, 0, header.length, 0);
for (const [row, x] of [[0, 1], [Math.floor((vertexCount - 1) / 2), 2], [vertexCount - 1, 3]]) {
  const record = Buffer.alloc(24); record.writeDoubleLE(x);
  await ply.write(record, 0, 24, header.length + row * 24);
}
await ply.close();
const triangleCount = Math.ceil(5 * 1024 ** 3 / 50);
const stl = await open(largeStlPath, 'w+');
await stl.truncate(84 + triangleCount * 50);
const stlHeader = Buffer.alloc(84); stlHeader.writeUint32LE(triangleCount, 80);
await stl.write(stlHeader, 0, 84, 0);
for (const [row, x] of [[0, 1], [Math.floor((triangleCount - 1) / 2), 2], [triangleCount - 1, 3]]) {
  const record = Buffer.alloc(50); record.writeFloatLE(1, 8);
  [x,0,0,x,1,0,x,0,1].forEach((value, i) => record.writeFloatLE(value, 12 + i * 4));
  await stl.write(record, 0, 50, 84 + row * 50);
}
await stl.close();
let browser, page;
const checks = [];
const byteRanges = [], rangeWireSamples = [];
let unboundedByteReads = 0;
const pass = text => { checks.push(text); console.log(`PASS: ${text}`); };
try {
  browser = await chromium.launch({ executablePath: process.env.MODELDOCK_BROWSER, headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: 'en-US' });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    // Native Harness carries unary Remote calls over HTTP; WebSockets carry watches.
    if (!new URL(request.url()).pathname.endsWith('/api/workspaceFiles/readBytes')) return;
    const text = request.postData() || '';
    if (rangeWireSamples.length < 3) rangeWireSamples.push(text.slice(0, 3000));
    try {
      const before = byteRanges.length;
      const walk = node => {
        if (!node || typeof node !== 'object') return;
        if (node.range && Number.isSafeInteger(node.range.offset) && Number.isSafeInteger(node.range.length)) byteRanges.push({ offset: node.range.offset, length: node.range.length });
        for (const value of Object.values(node)) walk(value);
      };
      walk(JSON.parse(text));
      if (byteRanges.length === before) unboundedByteReads++;
    } catch { unboundedByteReads++; }
  });
  const response = await page.goto(hostUrl);
  assert.notEqual(response.status(), 401, 'Harness requires its complete printed authenticated URL, including the task-local token.');
  await page.getByRole('button', { name: 'Plugins', exact: true }).waitFor();
  await page.waitForTimeout(700);
  const notice = page.getByRole('button', { name: 'Continue', exact: true });
  if (await notice.isVisible()) { await notice.click(); await page.waitForTimeout(500); }
  const dismiss = page.getByRole('button', { name: 'Close', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  const chooser = page.getByRole('button', { name: 'Choose workspace', exact: true });
  const workspaceName = (await chooser.innerText()).trim();
  if (workspaceName === 'Choose workspace') {
    await chooser.click();
    await page.getByRole('button', { name: 'Edit path', exact: true }).click();
    // The path input has an implicit text type; [type=text] would select search instead.
    await page.locator('input').last().fill(root);
    await page.locator('input').last().press('Enter');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(chooser).toHaveText(path.basename(root));
  } else {
    assert.equal(workspaceName, path.basename(root), 'Start this test in an isolated profile using the ModelDock repository workspace.');
  }
  await page.getByRole('button', { name: 'Open right sidebar', exact: true }).click();
  await page.getByText('Workspace files', { exact: true }).click();
  await page.getByText('fixtures', { exact: true }).click();
  await page.getByText('demo-arch-cloud.ply', { exact: true }).click();
  await page.locator('.md-app[data-state="ready"][data-vertices="48000"]').waitFor({ timeout: 60000 });
  assert(await page.getByText('ModelDock · 3D', { exact: true }).isVisible());
  pass('Single-click PLY in the actual Harness file tree automatically selects ModelDock and renders 48,000 points');
  await page.screenshot({ path: path.join(root, 'test-results/harness-native-ply.png') });
  const model = page.locator('.md-app');
  const canvas = model.locator('canvas.md-canvas');
  const rect = await canvas.boundingBox(); assert(rect);
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  let pose = await model.getAttribute('data-camera');
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 70, y + 30, { steps: 10 }); await page.mouse.up();
  await expect.poll(() => model.getAttribute('data-camera')).not.toBe(pose);
  pose = await model.getAttribute('data-camera');
  await page.mouse.move(x, y); await page.mouse.down({ button: 'right' }); await page.mouse.move(x - 45, y + 20, { steps: 10 }); await page.mouse.up({ button: 'right' });
  await expect.poll(async () => (await model.getAttribute('data-camera')).split(',').slice(3, 6).join(',')).not.toBe(pose.split(',').slice(3, 6).join(','));
  pose = await model.getAttribute('data-camera');
  await page.mouse.wheel(0, -250);
  await expect.poll(() => model.getAttribute('data-camera')).not.toBe(pose);
  pass('Rotation, right-button pan, and wheel zoom work inside the native shadow-root preview');

  await page.getByText('Files', { exact: true }).click();
  await page.getByText('test-results', { exact: true }).click();
  await page.getByText(liveName, { exact: true }).click();
  const liveModel = page.locator(`.md-app[data-filename="${liveName}"]`);
  await expect(liveModel).toHaveAttribute('data-vertices', '48000', { timeout: 30000 });
  await liveModel.locator('[data-action="front"]').click();
  await expect.poll(() => liveModel.getAttribute('data-camera')).toMatch(/^0\.00000,0\.00000,/);
  const before = await liveModel.getAttribute('data-camera');
  await copyFile(path.join(root, 'fixtures/colored-mesh.ply'), `${livePath}.tmp`);
  await rename(`${livePath}.tmp`, livePath);
  await expect(liveModel).toHaveAttribute('data-triangles', '4096', { timeout: 30000 });
  await expect(liveModel).toHaveAttribute('data-state', 'ready');
  await expect.poll(() => liveModel.getAttribute('data-camera'), { timeout: 15000 }).toBe(before);
  pass('Atomic replacement refreshes to 4,096 triangles and preserves the exact front camera through renderer-owned reload');

  await page.getByText('Files', { exact: true }).click();
  const stepFile = page.getByText('mounting-bracket.step', { exact: true });
  if (!await stepFile.isVisible()) await page.getByText('fixtures', { exact: true }).click();
  await stepFile.click();
  const cad = page.locator('.md-app[data-filename="mounting-bracket.step"]');
  await expect(cad).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  assert.equal(await cad.getAttribute('data-vertices'), '1280');
  assert.equal(await cad.getAttribute('data-triangles'), '1276');
  await page.screenshot({ path: path.join(root, 'test-results/harness-native-step.png') });
  pass('Native STEP preview tessellates the mounting bracket to 1,280 vertices and 1,276 triangles');
  for (const [name, expectedVertices, expectedTriangles] of [[largePlyName, '300000', '0'], [largeStlName, '300000', '100000']]) {
    await page.getByText('Files', { exact: true }).click();
    if (!await page.getByText(name, { exact: true }).isVisible()) await page.getByText('test-results', { exact: true }).click();
    await page.getByText(name, { exact: true }).click();
    const largeModel = page.locator(`.md-app[data-filename="${name}"]`);
    await expect(largeModel).toHaveAttribute('data-state', 'ready', { timeout: 120000 });
    assert.equal(await largeModel.getAttribute('data-vertices'), expectedVertices);
    assert.equal(await largeModel.getAttribute('data-triangles'), expectedTriangles);
    pass(`Native single-click >5 GiB ${name.endsWith('.ply') ? 'PLY' : 'STL'} renders through authorized bounded workspace byte ranges`);
  }
  await page.screenshot({ path: path.join(root, 'test-results/harness-native-large.png') });
  await writeFile(path.join(root, 'test-results/harness-native-range-wire.json'), JSON.stringify(rangeWireSamples, null, 2) + '\n');
  assert(byteRanges.length > 0, 'Observe native workspaceFiles/readBytes calls at the actual unary HTTP transport.');
  assert.equal(unboundedByteReads, 0, 'Every native readBytes invocation must contain an explicit bounded range.');
  assert(byteRanges.every(range => range.length > 0 && range.length <= 512 * 1024));
  assert(byteRanges.some(range => range.offset > 4 * 1024 ** 3));
  assert(byteRanges.some(range => range.offset > 2 * 1024 ** 3 && range.offset < 3 * 1024 ** 3));
  pass('Actual native transport uses <=512 KiB byte ranges, including middle-of-file and >4 GiB offsets');
  assert.deepEqual(errors, []);
  pass('No uncaught browser errors; no API key configured and no chat message submitted');
  const report = { host: 'DeepSeek Harness 0.2.2-alpha.2 Web', kind: 'actual installed native plugin', passed: checks.length, checks,
    rangeRequests: byteRanges.length, requestedBytes: byteRanges.reduce((sum, range) => sum + range.length, 0),
    maximumChunkBytes: Math.max(...byteRanges.map(range => range.length)), largestOffset: Math.max(...byteRanges.map(range => range.offset)), unboundedByteReads };
  await writeFile(path.join(root, 'test-results/harness-native.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  await page?.screenshot({ path: path.join(root, 'test-results/harness-native-failure.png') }).catch(() => {});
  const text = await page?.locator('body').innerText().catch(() => '');
  const modelErrors = page ? await page.locator('[data-role="error-message"], [data-modeldock-preview] + [role="alert"]').allTextContents().catch(() => []) : [];
  await writeFile(path.join(root, 'test-results/harness-native-failure.txt'), (text || '').slice(-16000));
  await writeFile(path.join(root, 'test-results/harness-native.json'), JSON.stringify({ kind: 'actual installed native plugin', status: 'failed', passed: checks.length, checks, error: detail, modelErrors }, null, 2) + '\n');
  console.error(JSON.stringify({ error: detail, modelErrors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await unlink(livePath).catch(() => {});
  await unlink(largePlyPath).catch(() => {});
  await unlink(largeStlPath).catch(() => {});
  await unlink(`${livePath}.tmp`).catch(() => {});
}
