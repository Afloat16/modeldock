import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 60_000,
): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await delay(100);
  }
}

/** Runs inside an actual isolated Extension Development Host. */
export async function run(): Promise<void> {
  const directory = process.env.MODELDOCK_TEST_DIRECTORY!;
  const root = process.env.MODELDOCK_TEST_ROOT!;
  const extensionId = process.env.MODELDOCK_TEST_EXTENSION_ID!;
  const plyPath = join(directory, 'workspace', 'smoke.Ply');
  const uri = vscode.Uri.file(plyPath);
  const before = await readFile(plyPath);
  await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
  await until(() => {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return active instanceof vscode.TabInputCustom && active.viewType === 'modeldock.preview';
  }, 'default click-to-open custom editor');
  assert.ok(vscode.extensions.getExtension(extensionId)?.isActive, 'ModelDock was not activated');
  assert.deepEqual(await readFile(plyPath), before, 'Preview modified the model');

  async function stage(name: string, path = plyPath): Promise<void> {
    await writeFile(join(directory, 'stage.json'), JSON.stringify({ stage: name, path }));
    await until(
      async () => {
        try {
          const message = JSON.parse(await readFile(join(directory, 'abort.json'), 'utf8'));
          throw new Error(message.error);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        try {
          await readFile(join(directory, `continue-${name}`));
          return true;
        } catch {
          return false;
        }
      },
      `renderer verification for ${name}`,
      240_000,
    );
  }
  await stage('ply');

  const step = vscode.Uri.file(join(root, 'fixtures', 'cube.step'));
  const stepBefore = await vscode.workspace.fs.readFile(step);
  await vscode.commands.executeCommand('modeldock.open', step);
  await until(() => {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return active instanceof vscode.TabInputCustom && active.uri.toString() === step.toString();
  }, 'CAD custom editor');
  await stage('step');
  assert.deepEqual(
    await vscode.workspace.fs.readFile(step),
    stepBefore,
    'CAD preview modified the file',
  );

  const largeFixtures = JSON.parse(
    await readFile(join(directory, 'large-fixtures.json'), 'utf8'),
  ) as Array<{ kind: string; path: string; logicalBytes: number }>;
  async function boundedSnapshot(path: string): Promise<object> {
    const info = await stat(path);
    const file = await open(path, 'r');
    try {
      // Never read a multi-gigabyte fixture wholesale, including during assertions.
      const first = Buffer.alloc(128),
        last = Buffer.alloc(64);
      await file.read(first, 0, first.length, 0);
      await file.read(last, 0, last.length, info.size - last.length);
      return { size: info.size, mtimeMs: info.mtimeMs, first, last };
    } finally {
      await file.close();
    }
  }
  for (const fixture of largeFixtures) {
    assert.ok(fixture.logicalBytes > 5 * 1024 ** 3, 'Native large source must exceed 5 GiB');
    const before = await boundedSnapshot(fixture.path);
    const source = vscode.Uri.file(fixture.path);
    await vscode.commands.executeCommand('modeldock.open', source);
    await until(
      () => {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return (
          active instanceof vscode.TabInputCustom && active.uri.toString() === source.toString()
        );
      },
      `native >5 GiB ${fixture.kind} custom editor`,
      120_000,
    );
    await stage(`large-${fixture.kind}`, fixture.path);
    assert.deepEqual(
      await boundedSnapshot(fixture.path),
      before,
      `Native large ${fixture.kind} preview modified the source`,
    );
    // Release a renderer before opening the next substantial sampled preview.
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }

  await vscode.commands.executeCommand('modeldock.reopenAsText', uri);
  await until(() => {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return active instanceof vscode.TabInputText && active.uri.toString() === uri.toString();
  }, 'Reopen as Text command');
  await writeFile(
    join(directory, 'suite-result.json'),
    JSON.stringify(
      {
        passed: true,
        extensionId,
        checks: [
          'default mixed-case file association',
          'extension activation',
          'read-only PLY and CAD preview',
          'native >5 GiB PLY bounded preview',
          'native >5 GiB STL bounded preview',
          'read-only sparse source snapshots',
          'Reopen as Text command',
        ],
      },
      null,
      2,
    ),
  );
  console.log('ModelDock native VS Code extension suite passed.');
}
