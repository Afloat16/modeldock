import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
await mkdir('test-results', { recursive: true });
const ply = (z) =>
  `ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 ${z}\n1 0 ${z}\n0 1 ${z}\n3 0 1 2\n`;
const live = path.join(root, 'test-results/comparison-live.ply');
await writeFile(live, ply(0.03));
const server = spawn(process.execPath, ['dist/cli.cjs', live], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const url = await new Promise((resolve, reject) => {
  let output = '';
  const timer = setTimeout(() => reject(Error('Server timeout')), 15000);
  server.stdout.on('data', (b) => {
    output += b;
    const m = output.match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\//);
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  });
  server.once('error', reject);
});
let browser;
const checks = [];
try {
  browser = await chromium.launch({
    executablePath: process.env.MODELDOCK_BROWSER,
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-webgl',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  const app = page.locator('.md-app');
  await expect(app).toHaveAttribute('data-state', 'ready');
  await page.locator('[data-role="add-input"]').setInputFiles({
    name: 'ground-truth.stl',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(
      'solid gt\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid gt',
    ),
  });
  await expect(app).toHaveAttribute('data-model-count', '2');
  const rows = page.locator('[data-model-id]');
  const source = await rows.nth(0).getAttribute('data-model-id'),
    reference = await rows.nth(1).getAttribute('data-model-id');
  await page.locator('[data-field="reference"]').selectOption(reference);
  await page.locator('[data-field="target"]').selectOption(source);
  await page.locator('[data-compare-action="compare"]').click();
  await expect(app).toHaveAttribute('data-comparison-state', 'error');
  assert.match(
    await page.locator('[data-role="comparison-result"]').textContent(),
    /Choose the same known coordinate unit/,
  );
  checks.push('Unknown PLY/STL units require explicit coordinate-unit selection');
  for (const id of [source, reference])
    await page.locator(`[data-field="unit"][data-id="${id}"]`).selectOption('mm');
  await page.locator('[data-compare-action="compare"]').click();
  await expect(app).toHaveAttribute('data-comparison-state', 'ready', { timeout: 30000 });
  const getReport = async () => {
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-compare-action="json"]').click();
    const download = await downloadPromise;
    return JSON.parse(await readFile(await download.path(), 'utf8'));
  };
  let report = await getReport();
  assert(Math.abs(report.comparisons[0].accuracy.rmse - 0.03) < 1e-6);
  assert.equal(report.comparisons[0].reference.name, 'ground-truth.stl');
  assert.equal(report.comparisons[0].alignment.method, 'none');
  checks.push(
    'Preserved source coordinates produce known 0.03mm surface RMSE against STL without automatic alignment',
  );
  await expect(page.locator('[data-role="deviation-legend"]')).toBeVisible();
  await page.locator('[data-field="mode"]').selectOption('split');
  await expect(app).toHaveAttribute('data-compare-mode', 'split');
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('canvas').count(), 1);
  await page.locator('[data-field="mode"]').selectOption('overlay');
  checks.push('Overlay and synchronized side-by-side share a responsive WebGL canvas');
  await page.locator('.md-comparison summary').click();
  await page.locator('[data-manual="tz"]').fill('-.03');
  await page.locator('[data-compare-action="manual"]').click();
  await page.locator('[data-compare-action="compare"]').click();
  await expect(app).toHaveAttribute('data-comparison-state', 'ready');
  report = await getReport();
  assert(report.comparisons[0].accuracy.rmse < 1e-7);
  assert.equal(report.comparisons[0].alignment.method, 'manual');
  assert.deepEqual(report.comparisons[0].alignment.transform.translation, [0, 0, -0.03]);
  checks.push('Explicit manual transform yields zero surface distance and is recorded in JSON');
  await page.locator('[data-compare-action="reset"]').click();
  await page.locator('[data-compare-action="align"]').click();
  await expect(app).toHaveAttribute('data-comparison-state', 'aligned', { timeout: 30000 });
  await page.locator('[data-compare-action="compare"]').click();
  await expect(app).toHaveAttribute('data-comparison-state', 'ready');
  report = await getReport();
  assert(report.comparisons[0].accuracy.rmse < 0.005);
  assert.equal(report.comparisons[0].alignment.method, 'rigid-icp');
  checks.push('One-click local rigid ICP recovers known surface translation');
  await page.locator('[data-role="add-input"]').setInputFiles({
    name: 'third.ply',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(ply(0.06)),
  });
  await expect(app).toHaveAttribute('data-model-count', '3');
  const third = await rows.nth(2).getAttribute('data-model-id');
  await page.locator(`[data-field="unit"][data-id="${third}"]`).selectOption('mm');
  await page.locator('[data-compare-action="all"]').click();
  await expect(app).toHaveAttribute('data-comparison-state', 'ready');
  report = await getReport();
  assert.equal(report.comparisons.length, 2);
  checks.push('Three-model each-to-reference evaluation creates both pair reports');
  const csvPromise = page.waitForEvent('download');
  await page.locator('[data-compare-action="csv"]').click();
  const csv = await csvPromise;
  assert.match(await readFile(await csv.path(), 'utf8'), /rotation_row_major/);
  checks.push('CSV and JSON downloads contain transforms and sampling provenance');
  await page.screenshot({ path: 'test-results/comparison-internal.png' });
  await writeFile(live, ply(0.04));
  await expect(app).toHaveAttribute('data-filename', 'comparison-live.ply', { timeout: 15000 });
  await expect(app).toHaveAttribute('data-model-count', '3');
  assert.equal(await page.locator('[data-field="reference"]').inputValue(), reference);
  await expect(page.locator(`[data-field="unit"][data-id="${source}"]`)).toHaveValue('mm');
  await page.locator('[data-field="target"]').selectOption(source);
  await page.locator('[data-compare-action="compare"]').click();
  await expect(app).toHaveAttribute('data-comparison-state', 'ready');
  report = await getReport();
  assert.equal(report.comparisons[0].alignment.method, 'rigid-icp');
  assert(Math.abs(report.comparisons[0].accuracy.rmse - 0.01) < 0.001);
  checks.push('Per-source refresh preserves secondary models and selected STL ground truth');
  await page.setViewportSize({ width: 600, height: 700 });
  await page.locator('[data-action="inspect"]').click();
  await page.locator('[data-action="inspect"]').click();
  assert.deepEqual(errors, []);
  checks.push(
    'Comparison workflow has no uncaught browser exceptions at desktop and narrow widths',
  );
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
