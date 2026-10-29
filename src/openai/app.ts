/// <reference path="../../adapters/deepseek-harness/src/embedded.d.ts" />
import { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from '@openai/mcp-extensions/app';
import { workerSource, occtSource, occtWasmBase64 } from 'modeldock:embedded-assets';
import viewerStyles from '../viewer/styles.css?inline';
import { mountViewer } from '../viewer/viewer.js';
import { DEFAULT_MAX_FILE_BYTES, type ViewerHandle } from '../shared/types.js';
import { createEmbeddedAssetPool, type AssetLease } from '../../adapters/deepseek-harness/src/helpers.js';
import { createFileResourceController, MAX_OPENAI_FILE_BYTES } from './resource.js';
import { openAISelectedRangeSource } from './range.js';

/** Mount one host-authorized file; the app never receives or follows a filesystem path. */
async function start(): Promise<void> {
  const style = document.createElement('style');
  style.textContent = `${viewerStyles}\nhtml,body{margin:0;width:100%;height:100%;overflow:hidden;background:#10141c;color:#e6ecf5}#modeldock-app{height:100vh;min-height:360px}#bridge-status{position:fixed;left:12px;right:12px;top:12px;z-index:1000;padding:12px 14px;background:#1c2738;border:1px solid #38506b;border-radius:8px;font:13px/1.6 system-ui,sans-serif;white-space:pre-wrap}#bridge-status[hidden]{display:none}#bridge-status[data-state=error],#bridge-status[data-state=unsupported]{background:#3d2828;border-color:#84504a}#bridge-reload{margin-left:10px;padding:5px 9px;border-radius:5px;color:inherit;background:#33445c;border:1px solid #67809e;cursor:pointer}`;
  document.head.appendChild(style);
  const mount = document.createElement('div');
  mount.id = 'modeldock-app';
  const status = document.createElement('div');
  status.id = 'bridge-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const statusText = document.createElement('span');
  statusText.textContent = 'Connecting ModelDock to the file viewer…';
  const reload = document.createElement('button');
  reload.id = 'bridge-reload';
  reload.type = 'button';
  reload.textContent = 'Reload file';
  reload.hidden = true;
  status.append(statusText, reload);
  document.body.replaceChildren(mount, status);

  const app = new App({ name: 'ModelDock', version: '0.2.0' }, {}, { autoResize: false });
  const extensions = new OpenAIExtensions(app);
  const assets = createEmbeddedAssetPool({ workerSource, occtSource, occtWasmBase64 });
  let viewer: ViewerHandle | undefined;
  let lease: AssetLease | undefined;
  let disposed = false;
  let connected = false;
  let pendingInput: unknown;

  const showStatus = (state: string, detail?: string): void => {
    if (disposed) return;
    status.dataset.state = state;
    status.hidden = state === 'ready';
    statusText.textContent = detail ?? (state === 'loading' ? 'Reading the selected model…' : 'ModelDock is ready. Open a supported model file.');
    reload.hidden = state !== 'error' && state !== 'warning';
  };

  const controller = createFileResourceController({
    getResources: () => extensions.resources,
    getSource: (file, signal) => openAISelectedRangeSource(file, (name, args, requestSignal) => app.callServerTool({ name, arguments: args }, { signal: requestSignal, timeout: 60000 }), signal),
    status: showStatus,
    display: async (source, options) => {
      if (disposed) return;
      if (!viewer) {
        lease = assets.retain();
        try {
          viewer = mountViewer(mount, {
            host: 'openai',
            assets: lease.assets,
            maxFileBytes: DEFAULT_MAX_FILE_BYTES,
            allowFilePicker: true,
            autoReload: true,
            language: /^zh\b/i.test(navigator.language) ? 'zh-CN' : 'en',
          });
        } catch (error) {
          lease.release();
          lease = undefined;
          throw error;
        }
      }
      await viewer.load(source, options);
    },
  });
  reload.addEventListener('click', () => { void controller.reload(); });

  const receive = (args: unknown): void => {
    const parsed = OpenAIFileEntrypointInputSchema.safeParse(args);
    if (!parsed.success) {
      showStatus('error', 'Open this viewer by clicking a supported model file. No valid file entrypoint input was supplied.');
      return;
    }
    void controller.open(parsed.data.file).catch(error => {
      showStatus('error', error instanceof Error ? error.message : String(error));
    });
  };
  app.addEventListener('toolinput', ({ arguments: args }) => {
    // Keep the first input even if it arrives while the SDK handshake is finishing.
    if (!connected) pendingInput = args;
    else receive(args);
  });
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    viewer?.dispose();
    lease?.release();
    assets.dispose();
    await controller.dispose();
  };
  app.onteardown = async () => { await dispose(); return {}; };
  window.addEventListener('pagehide', () => { void dispose(); }, { once: true });
  try {
    await app.connect(undefined, { timeout: 10000 });
    connected = true;
    if (!extensions.resources) {
      showStatus('unsupported', 'This host does not support OpenAI file resources. Native viewing requires a supported Desktop file entrypoint. Use the ModelDock VS Code extension or local viewer in other environments.');
      return;
    }
    if (pendingInput !== undefined) receive(pendingInput);
    else showStatus('waiting', 'ModelDock is connected. Open a PLY, mesh, or CAD file to begin.');
  } catch (error) {
    showStatus('error', `Unable to connect to the host file viewer. ${error instanceof Error ? error.message : String(error)}`);
  }
}

void start().catch(error => {
  const errorElement = document.createElement('pre');
  errorElement.textContent = `ModelDock could not start: ${error instanceof Error ? error.message : String(error)}`;
  document.body.replaceChildren(errorElement);
});
