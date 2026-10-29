import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderViewerHtml, readWebviewCommand, serializeConfig } from '../src/extension/webview';
import { parseArgs } from '../src/cli/args';

test('a malicious filename cannot escape the JSON config script', () => {
  const name = '</script><script>alert("injected")</script> & \u2028';
  const config = { host: 'vscode' as const, assets: { worker: 'worker', occtJs: 'cad', occtWasm: 'wasm' }, initialFile: { name } };
  const html = renderViewerHtml({ config, script: 'local://viewer.js', stylesheet: 'local://styles.css', nonce: 'abc', csp: "default-src 'none'" });
  assert.equal((html.match(/<script /g) ?? []).length, 2);
  assert.equal(html.includes('<script>alert('), false);
  const encoded = html.match(/id="modeldock-config"[^>]*>(.*?)<\/script>/s)?.[1];
  assert.ok(encoded);
  assert.equal(JSON.parse(encoded).initialFile.name, name);
  assert.deepEqual(JSON.parse(serializeConfig(config)), config);
});

test('webview messages cannot choose arbitrary paths or command names', () => {
  for (const message of [null, [], 'reload', { type: 'readFile', path: '/etc/passwd' }, { type: 'reload', path: '/etc/passwd' }, { type: 'executeCommand', command: 'workbench.action.terminal.new' }]) {
    assert.equal(readWebviewCommand(message), undefined);
  }
  assert.equal(readWebviewCommand({ type: 'ready' }), 'ready');
  assert.equal(readWebviewCommand({ type: 'reload' }), 'reload');
  assert.equal(readWebviewCommand({ type: 'openAsText' }), 'openAsText');
});

test('CLI accepts paths with spaces without evaluating them', () => {
  const path = 'a model; $(never-run).ply';
  assert.equal(parseArgs([path, '--port', '0', '--max-size-mb', '256']).filePath, path);
  assert.equal(parseArgs(['--', '-model.ply']).filePath, '-model.ply');
  assert.equal(parseArgs(['--open']).open, true);
  assert.equal(parseArgs(['--no-reload']).autoReload, false);
});

test('CLI rejects invalid or ambiguous arguments', () => {
  for (const args of [['--port'], ['--port', '65536'], ['--port', '-1'], ['--max-size-mb', '0'], ['--max-size-mb', '1.5'], ['--max-size-mb', 'NaN'], ['a.ply', 'b.ply'], ['--host', '0.0.0.0']]) {
    assert.throws(() => parseArgs(args));
  }
});
