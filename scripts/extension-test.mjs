import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { build } from 'esbuild';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { chromium } from '@playwright/test';
import { createNativeSparseFixtures } from '../tests/vscode/sparse-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const evidence = join(root, 'test-results');
await mkdir(evidence, { recursive: true });
let directory, sparseFixtures, browser, xvfb;
async function stopForSignal(signal) {
  xvfb?.kill();
  try {
    await sparseFixtures?.cleanup();
  } finally {
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
}
const onInterrupt = () => {
  void stopForSignal('SIGINT');
};
const onTerminate = () => {
  void stopForSignal('SIGTERM');
};
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
try {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.MODELDOCK_XVFB) {
    throw new Error(
      'Native VS Code tests require a display on Linux. Run xvfb-run -a npm run test:extension, or supply a working MODELDOCK_XVFB executable. The shared browser tests can run headlessly with npm run test:browser.',
    );
  }
  const outputRoot = resolve(root, '.vscode-test');
  await mkdir(outputRoot, { recursive: true });
  directory = await mkdtemp(join(outputRoot, 'modeldock-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  sparseFixtures = await createNativeSparseFixtures(workspace);
  await writeFile(join(directory, 'large-fixtures.json'), JSON.stringify(sparseFixtures.fixtures));
  const model = join(workspace, 'smoke.Ply');
  const ply = (vertices) =>
    `ply\nformat ascii 1.0\nelement vertex ${vertices}\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 1 0\n${vertices === 4 ? '0 0 1\n' : ''}`;
  await writeFile(model, ply(3));
  await mkdir(join(workspace, '.vscode'));
  await writeFile(
    join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'window.dialogStyle': 'custom',
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      'security.workspace.trust.enabled': false,
    }),
  );
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const suitePath = join(root, 'dist', 'tests', 'vscode.cjs');
  await build({
    entryPoints: [join(root, 'tests', 'vscode', 'suite.ts')],
    outfile: suitePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    target: 'node20',
  });
  const executable =
    process.env.VSCODE_EXECUTABLE_PATH ??
    (await downloadAndUnzipVSCode({
      version: process.env.VSCODE_VERSION ?? '1.96.4',
      cachePath: process.env.VSCODE_CACHE_PATH ?? join(outputRoot, 'cache'),
      timeout: 30_000,
      extractSync: true,
    }));
  const debugPort = await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
  let display = process.env.DISPLAY;
  if (process.platform === 'linux' && !display && process.env.MODELDOCK_XVFB) {
    display = `:${190 + Math.floor(Math.random() * 100)}`;
    xvfb = spawn(
      process.env.MODELDOCK_XVFB,
      [display, '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          ...(process.env.MODELDOCK_XVFB_LIB
            ? { LD_LIBRARY_PATH: process.env.MODELDOCK_XVFB_LIB }
            : {}),
        },
      },
    );
    xvfb.stderr.on('data', (chunk) => process.stderr.write(chunk));
    await delay(700);
    if (xvfb.exitCode !== null) throw new Error('The task-local Xvfb failed to start.');
  }
  let testFinished = false,
    testError;
  const run = runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: root,
    extensionTestsPath: suitePath,
    reuseMachineInstall: false,
    extensionTestsEnv: {
      ...process.env,
      DISPLAY: display,
      MODELDOCK_TEST_DIRECTORY: directory,
      MODELDOCK_TEST_ROOT: root,
      MODELDOCK_TEST_EXTENSION_ID: `${manifest.publisher}.${manifest.name}`,
    },
    launchArgs: [
      workspace,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--disable-workspace-trust',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--user-data-dir=${join(directory, 'user-data')}`,
      `--extensions-dir=${join(directory, 'extensions')}`,
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=127.0.0.1',
    ],
  }).then(
    (code) => {
      testFinished = true;
      return code;
    },
    (error) => {
      testFinished = true;
      testError = error;
      throw error;
    },
  );
  // Attach an error observer immediately while the renderer checks run in parallel.
  run.catch(() => {});
  async function waitFor(check, label, timeout = 60_000) {
    const start = Date.now();
    while (!(await check())) {
      if (testFinished) throw testError ?? new Error(`VS Code exited before ${label}`);
      if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
      await delay(150);
    }
  }
  async function activeFrame(expectedFilename) {
    for (const context of browser.contexts())
      for (const page of context.pages())
        for (const frame of page.frames()) {
          try {
            if ((await frame.locator('.md-app').count()) === 0) continue;
            const state = await frame.locator('.md-app').evaluate((element) => ({
              state: element.dataset.state,
              name: element.dataset.filename,
              message: element.querySelector('[data-role="error-message"]')?.textContent,
            }));
            if (state.state === 'error') throw new Error(`Viewer error: ${state.message}`);
            if (state.state === 'ready' && state.name === expectedFilename) return frame;
          } catch (error) {
            if (String(error).includes('Viewer error:')) throw error;
          }
        }
  }
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        return response.ok;
      } catch {
        return false;
      }
    }, 'VS Code debugging endpoint');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const stageCases = [
      { stage: 'ply', name: 'smoke.Ply' },
      { stage: 'step', name: 'cube.step' },
      ...sparseFixtures.fixtures.map((fixture) => ({ stage: `large-${fixture.kind}`, ...fixture })),
    ];
    const largeChecks = [];
    for (const testCase of stageCases) {
      const { stage, name } = testCase;
      await waitFor(async () => {
        try {
          return JSON.parse(await readFile(join(directory, 'stage.json'), 'utf8')).stage === stage;
        } catch {
          return false;
        }
      }, `native ${stage} stage`);
      let frame;
      await waitFor(
        async () => {
          frame = await activeFrame(name);
          return !!frame;
        },
        `${stage} native rendering`,
        stage.startsWith('large-') ? 240_000 : 120_000,
      );
      const canvas = frame.locator('.md-canvas');
      const app = frame.locator('.md-app');
      if (stage === 'ply') {
        assert.equal(await app.getAttribute('data-vertices'), '3');
        assert.equal(await app.getAttribute('data-triangles'), '0');
        const before = await app.getAttribute('data-camera');
        const rect = await canvas.boundingBox();
        assert.ok(rect && rect.width > 200 && rect.height > 200);
        const page = frame.page();
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
        await page.mouse.down();
        await page.mouse.move(rect.x + rect.width / 2 + 90, rect.y + rect.height / 2 + 40, {
          steps: 10,
        });
        await page.mouse.up();
        await delay(500);
        const rotated = await app.getAttribute('data-camera');
        assert.notEqual(rotated, before, 'Native rotate interaction did not change camera');
        await page.mouse.wheel(0, -160);
        await delay(700);
        // Wait for damping to settle before checking that a reload preserves pose.
        let previousPose = '';
        for (let attempt = 0; attempt < 40; attempt++) {
          const pose = await app.getAttribute('data-camera');
          if (pose === previousPose) break;
          previousPose = pose;
          await delay(100);
        }
        const zoomed = await app.getAttribute('data-camera');
        assert.notEqual(zoomed, rotated, 'Native zoom interaction did not change camera');
        await writeFile(model, ply(4));
        await waitFor(
          async () => (await app.getAttribute('data-vertices')) === '4',
          'native filesystem auto-refresh',
        );
        const oldPose = zoomed.split(',').map(Number);
        const newPose = (await app.getAttribute('data-camera')).split(',').map(Number);
        // A fresh render can advance residual sub-threshold OrbitControls inertia.
        // A fit/reset would move well beyond this 0.1% positional tolerance.
        const cameraDistance = Math.hypot(...oldPose.slice(0, 3));
        assert(
          Math.hypot(...newPose.slice(0, 3).map((value, index) => value - oldPose[index])) <
            cameraDistance * 0.001,
          'Auto-refresh changed the camera position',
        );
        assert.deepEqual(newPose.slice(3), oldPose.slice(3), 'Auto-refresh changed target or zoom');
        await page.screenshot({ path: join(directory, 'ply-native.png') });
      } else if (stage === 'step') {
        assert.ok(
          Number(await app.getAttribute('data-triangles')) >= 12,
          'STEP was not tessellated',
        );
        await frame.page().screenshot({ path: join(directory, 'step-native.png') });
      } else {
        const vertices = Number(await app.getAttribute('data-vertices'));
        const triangles = Number(await app.getAttribute('data-triangles'));
        assert.equal(
          vertices,
          testCase.expectedVertices,
          `${name} exceeded or failed its bounded vertex preview`,
        );
        assert.equal(
          triangles,
          testCase.expectedTriangles,
          `${name} exceeded or failed its bounded triangle preview`,
        );
        const warnings = await frame.locator('[data-role="warnings"]').textContent();
        assert.match(
          warnings,
          /Bounded preview retains/i,
          `${name} did not disclose source sampling`,
        );
        assert.match(
          warnings,
          /unseen records are not validated/i,
          `${name} falsely implied full-file validation`,
        );
        const dimensions = (await frame.locator('[data-role="dimensions"]').textContent())
          .replace(/\s+/g, ' ')
          .trim();
        assert.equal(
          dimensions,
          '3 × 1 × 1',
          `${name} did not retain the far-end sentinel beyond 5 GiB`,
        );
        const rect = await canvas.boundingBox();
        assert.ok(rect && rect.width > 200 && rect.height > 200, `${name} has no native canvas`);
        const shot = `${stage}-native.png`;
        await frame.page().screenshot({ path: join(evidence, shot) });
        largeChecks.push({
          kind: testCase.kind,
          logicalBytes: testCase.logicalBytes,
          allocatedBytes: testCase.allocatedBytes,
          vertices,
          triangles,
          dimensions,
          sourceSamplingDisclosed: true,
          farEndSentinel: true,
        });
      }
      await writeFile(join(directory, `continue-${stage}`), 'verified');
    }
    await run;
    const result = JSON.parse(await readFile(join(directory, 'suite-result.json'), 'utf8'));
    result.rendererChecks = [
      'native webview PLY decoding',
      'rotation',
      'zoom',
      'file watch reload with preserved camera',
      'native STEP WASM tessellation',
      'native >5 GiB PLY bounded host reads',
      'native >5 GiB STL bounded host reads',
      'far-end source sentinels beyond 5 GiB',
      'sampled-source warnings',
    ];
    result.largeFiles = largeChecks;
    result.vscodeVersion = process.env.VSCODE_VERSION ?? '1.96.4';
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
    await writeFile(join(evidence, 'vscode-native.json'), JSON.stringify(result, null, 2));
    await rm(join(evidence, 'vscode-native-failure.log'), { force: true });
    console.log(`Native VS Code smoke passed. Evidence: ${directory}`);
  } catch (error) {
    await writeFile(join(directory, 'abort.json'), JSON.stringify({ error: String(error) }));
    console.error(`Native VS Code smoke failed. Diagnostics: ${directory}`);
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    xvfb?.kill();
  }
} catch (error) {
  const message = String(error?.stack ?? error)
    .replaceAll(directory ?? '<unset-native-directory>', '<native-test>')
    .replaceAll(root, '<project>');
  await writeFile(
    join(evidence, 'vscode-native.json'),
    JSON.stringify(
      { passed: false, error: message, vscodeVersion: process.env.VSCODE_VERSION ?? '1.96.4' },
      null,
      2,
    ),
  );
  await writeFile(join(evidence, 'vscode-native-failure.log'), `${message}\n`);
  throw error;
} finally {
  // Never retain multi-gigabyte sparse sources in diagnostic artifacts, even on failure.
  await browser?.close().catch(() => {});
  xvfb?.kill();
  await sparseFixtures?.cleanup();
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
