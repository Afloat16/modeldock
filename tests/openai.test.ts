import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { OpenAIResourceReadResult } from '@openai/mcp-extensions/app';
import { SUPPORTED_EXTENSIONS } from '../src/shared/formats.js';
import {
  createFileResourceController, decodeBoundedBase64, modelFromResource,
  type BridgeStatus, type ResourceBridge,
} from '../src/openai/resource.js';
import {
  createViewerServer, VIEWER_MIME_TYPE, VIEWER_RESOURCE_URI, VIEWER_TOOL_NAME,
} from '../src/openai/server.js';

function resource(uri: string, text = 'model'): OpenAIResourceReadResult {
  return { contents: [{ uri, blob: Buffer.from(text).toString('base64'), openaiMetadata: { etag: text } }] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class FakeResources implements ResourceBridge {
  handlers = new Set<Parameters<ResourceBridge['addUpdateHandler']>[0]>();
  operations: string[] = [];
  read: ResourceBridge['read'] = async ({ uri, representation }) => {
    assert.equal(representation, 'blob');
    this.operations.push(`read:${uri}`);
    return resource(uri);
  };
  subscribe: ResourceBridge['subscribe'] = async ({ uri }) => {
    this.operations.push(`subscribe:${uri}`);
    return {};
  };
  unsubscribe: ResourceBridge['unsubscribe'] = async ({ uri }) => {
    this.operations.push(`unsubscribe:${uri}`);
    return {};
  };
  addUpdateHandler: ResourceBridge['addUpdateHandler'] = handler => {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  };
  async update(uri: string) {
    await Promise.all([...this.handlers].map(handler => handler({
      method: 'notifications/resources/updated', params: { uri },
    })));
  }
}

test('OpenAI binary decoding preserves multi-chunk bytes and rejects invalid or oversized payloads', () => {
  const bytes = Buffer.alloc(80003);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  assert.deepEqual(Buffer.from(decodeBoundedBase64(bytes.toString('base64'), bytes.length)), bytes);
  assert.throws(() => decodeBoundedBase64(bytes.toString('base64'), bytes.length - 1), /limit/);
  assert.throws(() => decodeBoundedBase64('????'), /invalid base64/);
  assert.throws(() => decodeBoundedBase64('YQ='), /invalid base64/);
  assert.throws(() => decodeBoundedBase64(''), /empty/);
  assert.throws(() => decodeBoundedBase64('YQ==', 0), /byte limit/);

  const originalAtob = globalThis.atob;
  let called = false;
  globalThis.atob = () => { called = true; throw new Error('Should not decode'); };
  try {
    assert.throws(() => decodeBoundedBase64('QUJDRA==', 2), /limit/);
    assert.equal(called, false, 'Byte limit must be enforced before decoding');
  } finally { globalThis.atob = originalAtob; }
});

test('OpenAI host resources require the selected URI and bound UTF-8 bytes', () => {
  const file = { name: 'sample.ply', resourceUri: 'host-file://selected' };
  const model = modelFromResource(file, resource(file.resourceUri, 'abc'));
  assert.equal(model.revision, 'abc');
  assert.equal(new TextDecoder().decode(model.data), 'abc');
  assert.throws(() => modelFromResource(file, resource('host-file://other')), /selected file/);
  const utf8 = { contents: [{ uri: file.resourceUri, text: '模型' }] };
  assert.equal(modelFromResource(file, utf8, 6).data?.byteLength, 6);
  assert.throws(() => modelFromResource(file, utf8, 5), /limit/);
});

test('OpenAI subscriptions refresh only the selected resource, preserve view, and dispose', async () => {
  const bridge = new FakeResources();
  const displays: Array<{ name: string; preserve: boolean }> = [];
  const states: BridgeStatus[] = [];
  const controller = createFileResourceController({
    getResources: () => bridge,
    display: async (source, options) => { displays.push({ name: source.name, preserve: options.preserveView }); },
    status: state => { states.push(state); },
  });
  await controller.open({ name: 'sample.ply', resourceUri: 'opaque:one' });
  assert.deepEqual(displays, [{ name: 'sample.ply', preserve: false }]);
  await bridge.update('opaque:other');
  assert.equal(displays.length, 1);
  await bridge.update('opaque:one');
  assert.deepEqual(displays[1], { name: 'sample.ply', preserve: true });
  assert.equal(states.at(-1), 'ready');
  await controller.dispose();
  assert.equal(bridge.handlers.size, 0);
  assert.equal(bridge.operations.at(-1), 'unsubscribe:opaque:one');
  await bridge.update('opaque:one');
  assert.equal(displays.length, 2);
});

test('OpenAI ignores a stale read after switching files', async () => {
  const bridge = new FakeResources();
  const firstRead = deferred<OpenAIResourceReadResult>();
  const readStarted = deferred<void>();
  bridge.read = async ({ uri }) => {
    if (uri === 'opaque:first') { readStarted.resolve(); return firstRead.promise; }
    return resource(uri);
  };
  const shown: string[] = [];
  const controller = createFileResourceController({
    getResources: () => bridge,
    display: async source => { shown.push(source.name); },
    status: () => {},
  });
  const openingFirst = controller.open({ name: 'first.ply', resourceUri: 'opaque:first' });
  await readStarted.promise;
  await controller.open({ name: 'second.stl', resourceUri: 'opaque:second' });
  firstRead.resolve(resource('opaque:first'));
  await openingFirst;
  assert.deepEqual(shown, ['second.stl']);
  await controller.dispose();
});

test('OpenAI rapid A/B/A switching serializes subscriptions without losing the last one', async () => {
  const bridge = new FakeResources();
  const firstSubscribe = deferred<void>();
  const subscribeStarted = deferred<void>();
  let calls = 0;
  bridge.subscribe = async ({ uri }) => {
    bridge.operations.push(`subscribe:${uri}`);
    if (++calls === 1) { subscribeStarted.resolve(); await firstSubscribe.promise; }
    return {};
  };
  const shown: string[] = [];
  const controller = createFileResourceController({
    getResources: () => bridge,
    display: async source => { shown.push(source.name); }, status: () => {},
  });
  const a1 = controller.open({ name: 'first.ply', resourceUri: 'opaque:a' });
  await subscribeStarted.promise;
  const b = controller.open({ name: 'second.ply', resourceUri: 'opaque:b' });
  const a2 = controller.open({ name: 'first.ply', resourceUri: 'opaque:a' });
  firstSubscribe.resolve();
  await Promise.all([a1, b, a2]);
  assert.deepEqual(bridge.operations, ['subscribe:opaque:a', 'unsubscribe:opaque:a', 'subscribe:opaque:a', 'read:opaque:a']);
  assert.deepEqual(shown, ['first.ply']);
  assert.equal(bridge.handlers.size, 1);
  await controller.dispose();
});

test('OpenAI missing capability and failed subscriptions produce usable status messages', async () => {
  const states: Array<{ state: BridgeStatus; detail?: string }> = [];
  const unsupported = createFileResourceController({
    getResources: () => undefined, display: async () => { assert.fail('Must not display'); },
    status: (state, detail) => { states.push({ state, detail }); },
  });
  await unsupported.open({ name: 'sample.ply', resourceUri: 'opaque:a' });
  assert.equal(states.at(-1)?.state, 'unsupported');
  await unsupported.dispose();

  const bridge = new FakeResources();
  bridge.subscribe = async () => { throw new Error('Subscriptions unavailable'); };
  let displays = 0;
  const fallback = createFileResourceController({
    getResources: () => bridge, display: async () => { displays++; },
    status: (state, detail) => { states.push({ state, detail }); },
  });
  await fallback.open({ name: 'sample.ply', resourceUri: 'opaque:a' });
  assert.equal(displays, 1);
  assert.equal(states.at(-1)?.state, 'warning');
  assert.match(states.at(-1)?.detail ?? '', /Reload file/);
  await fallback.reload();
  assert.equal(displays, 2);
  await fallback.dispose();
});

test('OpenAI MCP protocol advertises one read-only app file entrypoint and one HTML resource', async () => {
  let htmlReads = 0;
  const server = createViewerServer(async () => { htmlReads++; return '<!doctype html><title>ModelDock</title>'; });
  const client = new Client({ name: 'modeldock-test', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 3);
    const viewerTool = tools.find(tool => tool.name === 'modeldock_viewer');
    assert.ok(viewerTool);
    assert.equal(viewerTool?.name, VIEWER_TOOL_NAME);
    assert.equal(viewerTool?.annotations?.readOnlyHint, true);
    assert.deepEqual(viewerTool?._meta?.ui, { resourceUri: VIEWER_RESOURCE_URI, visibility: ['app'] });
    assert.deepEqual(viewerTool?._meta?.['openai/ui'], {
      entrypoints: [{ type: 'file', extensions: SUPPORTED_EXTENSIONS.map(extension => `.${extension}`) }],
    });
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map(item => item.uri), [VIEWER_RESOURCE_URI]);
    const html = await client.readResource({ uri: VIEWER_RESOURCE_URI });
    assert.equal(html.contents[0]?.mimeType, VIEWER_MIME_TYPE);
    assert.equal(htmlReads, 1);
    assert.ok('text' in html.contents[0]!);
    assert.deepEqual((html.contents[0]?._meta?.ui as { csp: object }).csp, {
      connectDomains: ['blob:'], resourceDomains: ['blob:'],
    });
    const valid = await client.callTool({ name: VIEWER_TOOL_NAME, arguments: { file: { name: 'a.ply', resourceUri: 'opaque:selected' } } });
    assert.equal(valid.isError, undefined);
    assert.deepEqual(valid.content, []);
    assert.equal(htmlReads, 1, 'Tool invocation must not read model bytes or even read the HTML resource');
    const invalid = await client.callTool({ name: VIEWER_TOOL_NAME, arguments: { file: { name: 'secret.txt', resourceUri: 'file:///unrelated' } } });
    assert.equal(invalid.isError, true);
    await assert.rejects(client.readResource({ uri: 'file:///unrelated' }), /not found|unknown/i);
  } finally { await client.close(); await server.close(); }
});
