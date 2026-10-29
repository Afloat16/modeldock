import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
await mkdir('test-results', { recursive: true });
const liveFile = path.join(root, 'test-results/live.ply');
await copyFile('fixtures/demo-arch-cloud.ply', liveFile);
const processHandle = spawn(process.execPath, ['dist/cli.cjs', liveFile], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const url = await new Promise((resolve, reject) => {
  let output = '';
  const timer = setTimeout(() => reject(new Error('Local server did not start.')), 15000);
  processHandle.stdout.on('data', (data) => {
    output += data;
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\//);
    if (match) {
      clearTimeout(timer);
      resolve(match[0]);
    }
  });
  processHandle.stderr.on('data', (data) => process.stderr.write(data));
  processHandle.once('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  processHandle.once('exit', (code) => {
    if (!output.includes('http://')) {
      clearTimeout(timer);
      reject(new Error('Server exited ' + code));
    }
  });
});
const executablePath = process.env.MODELDOCK_BROWSER;
let browser;
const passed = [];
try {
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-webgl',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    locale: 'en-US',
  });
  const page = await context.newPage();
  const errors = [],
    remote = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:'))
      remote.push(request.url());
  });
  const model = page.locator('.md-app');
  const ready = () => expect(model).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
  const camera = () => model.getAttribute('data-camera');
  const loaded = async (name) => {
    await expect(model).toHaveAttribute('data-filename', name, { timeout: 60000 });
    await ready();
  };
  const upload = async (name) => {
    await page.locator('[data-role="file-input"]').setInputFiles(path.join(root, 'fixtures', name));
    await loaded(name);
  };
  await page.goto(url);
  await ready();
  assert.equal(await model.getAttribute('data-vertices'), '48000');
  assert.equal(await model.getAttribute('data-triangles'), '0');
  await page.screenshot({ path: 'test-results/point-cloud.png' });
  passed.push('48,000-point binary PLY renders through the real Worker');
  const canvas = page.locator('canvas.md-canvas');
  const rectangle = await canvas.boundingBox();
  assert(rectangle);
  const x = rectangle.x + rectangle.width * 0.52,
    y = rectangle.y + rectangle.height * 0.48;
  let before = await camera();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 110, y + 55, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  assert.notEqual(await camera(), before);
  passed.push('Left-drag rotation changes the camera');
  before = await camera();
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x - 65, y + 20, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(450);
  const afterPan = await camera();
  assert.notEqual(afterPan, before);
  assert.notEqual(
    afterPan.split(',').slice(3, 6).join(','),
    before.split(',').slice(3, 6).join(','),
  );
  passed.push('Right-drag pan moves the target');
  before = await camera();
  await page.mouse.wheel(0, -250);
  await page.waitForTimeout(500);
  assert.notEqual(await camera(), before);
  passed.push('Wheel zoom changes the view');
  await page.locator('[data-action="front"]').click();
  await page.locator('[data-control="projection"]').selectOption('orthographic');
  assert.equal(await page.locator('[data-role="projection-label"]').textContent(), 'Orthographic');
  await page.locator('[data-control="up"]').selectOption('z');
  await page.locator('[data-action="top"]').click();
  await page.locator('[data-control="up"]').selectOption('y');
  await page.locator('[data-control="projection"]').selectOption('perspective');
  await page.locator('[data-action="reset"]').click();
  passed.push('Presets, orthographic camera and Y/Z up-axis switches');
  await page.waitForTimeout(300);
  before = await camera();
  await copyFile('fixtures/colored-mesh.ply', liveFile + '.tmp');
  await rename(liveFile + '.tmp', liveFile);
  await expect(model).toHaveAttribute('data-triangles', '4096', { timeout: 15000 });
  await ready();
  assert.equal(await camera(), before);
  passed.push('Atomic model replacement refreshes geometry and preserves the camera');
  await writeFile(liveFile, 'not a valid PLY');
  await page.locator('[data-role="error"]').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await model.getAttribute('data-triangles'), '4096');
  await copyFile('fixtures/demo-arch-cloud.ply', liveFile);
  await ready();
  passed.push('Malformed rewrite preserves the last model and a later valid rewrite recovers');
  for (const file of [
    'triangle-big.ply',
    'triangle-little.ply',
    'triangle-ascii.stl',
    'triangle-binary.stl',
    'pyramid.obj',
    'triangle.off',
    'points.xyz',
    'points.pcd',
  ])
    await upload(file);
  passed.push('PLY endian variants, ASCII/binary STL, OBJ, OFF, XYZ and PCD load in the browser');
  await upload('mounting-bracket.step');
  assert(Number(await model.getAttribute('data-triangles')) > 100);
  await page.screenshot({ path: 'test-results/cad-preview.png' });
  for (const mode of ['wireframe', 'normals', 'points', 'solid'])
    await page.locator('[data-control="display"]').selectOption(mode);
  await page.locator('[data-control="clip"]').selectOption('x');
  await page.locator('[data-control="clipPosition"]').fill('20');
  await page.locator('[data-control="clip"]').selectOption('off');
  passed.push('Real OpenCascade STEP tessellation, display modes and clipping plane');
  await upload('cube.iges');
  await upload('cube.brep');
  passed.push('IGES and BREP run through the bundled WASM kernel');
  await upload('textured-cube.glb');
  await page.screenshot({ path: 'test-results/gltf-preview.png' });
  await upload('textured-cube.gltf');
  passed.push('Embedded textured GLB and glTF render without external requests');
  await upload('cube.step');
  await page.locator('[data-action="front"]').click();
  await page.locator('[data-action="measure"]').click();
  await page.mouse.click(x - 20, y);
  await page.mouse.click(x + 20, y + 20);
  assert.match(
    await page.locator('[data-role="measure-text"]').textContent(),
    /Approximate mesh distance:/,
  );
  await page.locator('[data-action="measure"]').click();
  passed.push('Two-point measurement on tessellated CAD surfaces');
  const modelBytes = await readFile('fixtures/colored-mesh.ply');
  await page
    .locator('[data-role="file-input"]')
    .setInputFiles({
      name: '模型#final.Ply',
      mimeType: 'application/octet-stream',
      buffer: modelBytes,
    });
  await loaded('模型#final.Ply');
  passed.push('Unicode, hash and mixed-case model filenames');
  await page.setViewportSize({ width: 600, height: 680 });
  await page.reload();
  await ready();
  assert.equal(await page.locator('[data-role="inspector"]').isVisible(), false);
  await page.locator('[data-action="inspect"]').click();
  await page.locator('[data-control="projection"]').selectOption('orthographic');
  await page.locator('[data-action="inspect"]').click();
  await page.screenshot({ path: 'test-results/narrow-preview.png' });
  passed.push('Narrow layout and inspector toggle');
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  passed.push('No uncaught browser exceptions or remote asset requests');
  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
  await writeFile(
    'test-results/browser-report.json',
    JSON.stringify({ passed: passed.length, checks: passed }, null, 2) + '\n',
  );
} catch (error) {
  console.error(error);
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      await page.screenshot({ path: 'test-results/failure.png' });
      console.error(await page.locator('body').innerText());
    }
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  processHandle.kill('SIGTERM');
}
