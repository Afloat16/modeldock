import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { fileNameOf, isSupported, SUPPORTED_EXTENSIONS } from '../shared/formats';
import { DEFAULT_LIMITS, DEFAULT_MAX_FILE_BYTES, IN_MEMORY_FILE_BYTES, type ModelSource, type ViewerConfig } from '../shared/types';
import { selectedFileInfo, readSelectedRange } from '../host/selected-file';
import { boundedInteger, readWebviewCommand, readWebviewRequest, renderViewerHtml } from './webview';

const VIEW_TYPE = 'modeldock.preview';

class ModelDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void { /* The preview never owns or changes the source file. */ }
}

function settings(uri: vscode.Uri) {
  const config = vscode.workspace.getConfiguration('modeldock', uri);
  const maxFileSizeMB = boundedInteger(config.get('maxFileSizeMB'), 8192, 1, 1048576);
  const quality = config.get<string>('cadQuality', 'medium');
  return {
    maxFileBytes: maxFileSizeMB * 1024 * 1024 || DEFAULT_MAX_FILE_BYTES,
    maxVertices: boundedInteger(config.get('maxVertices'), DEFAULT_LIMITS.maxVertices, 1, 50_000_000),
    maxTriangles: boundedInteger(config.get('maxTriangles'), DEFAULT_LIMITS.maxTriangles, 1, 50_000_000),
    cadQuality: (quality === 'low' || quality === 'high' ? quality : 'medium') as ViewerConfig['cadQuality'],
    autoReload: config.get<boolean>('autoReload', true) !== false,
    language: (vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en') as ViewerConfig['language'],
  };
}

async function checkedStat(uri: vscode.Uri, maxFileBytes: number): Promise<vscode.FileStat> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (!(stat.type & vscode.FileType.File)) throw new Error('ModelDock can only preview files.');
  if (stat.size > maxFileBytes) {
    throw new Error(`This file is ${(stat.size / 1048576).toFixed(1)} MiB; the current ModelDock limit is ${maxFileBytes / 1048576} MiB. Change modeldock.maxFileSizeMB to allow a larger file.`);
  }
  return stat;
}

function sourceFor(webview: vscode.Webview, uri: vscode.Uri, stat: vscode.FileStat, sequence = 0): ModelSource {
  // Watchers can observe same-size writes within one filesystem timestamp tick.
  const revision = `${stat.mtime}-${stat.size}-${sequence}`;
  const mapped = webview.asWebviewUri(uri);
  const query = `${mapped.query ? `${mapped.query}&` : ''}modeldockRevision=${encodeURIComponent(revision)}`;
  return { name: fileNameOf(uri.path), size: stat.size, url: mapped.with({ query }).toString(), revision };
}

class ModelPreviewProvider implements vscode.CustomReadonlyEditorProvider<ModelDocument> {
  constructor(private readonly extensionUri: vscode.Uri) {}

  async openCustomDocument(uri: vscode.Uri): Promise<ModelDocument> {
    if (!isSupported(uri.path)) throw new Error('This file extension is not supported by ModelDock.');
    await checkedStat(uri, settings(uri).maxFileBytes);
    return new ModelDocument(uri);
  }

  async resolveCustomEditor(document: ModelDocument, panel: vscode.WebviewPanel): Promise<void> {
    const assetsRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'web');
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      // The active model only, not the whole workspace. No sidecar file requests are allowed.
      localResourceRoots: [assetsRoot, document.uri],
    };
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, name)).toString();
    const config = settings(document.uri);
    const initialStat = await checkedStat(document.uri, config.maxFileBytes);
    type Entry = { uri: vscode.Uri; source: ModelSource; diskRevision?: string };
    const sources = new Map<string, Entry>();
    const primaryId = randomBytes(16).toString('hex');
    const registerSource = async (uri: vscode.Uri, id = randomBytes(16).toString('hex'), sequence = 0): Promise<ModelSource> => {
      const stat = await checkedStat(uri, config.maxFileBytes);
      const source = { ...sourceFor(webview, uri, stat, sequence), sourceId: id };
      let diskRevision: string | undefined;
      if (uri.scheme === 'file') {
        const info = await selectedFileInfo(uri.fsPath, config.maxFileBytes);
        diskRevision = info.revision;
        source.size = info.size;
        source.revision = `${info.revision}:${sequence}`;
      } else if (stat.size > IN_MEMORY_FILE_BYTES) {
        throw new Error('This filesystem provider does not expose bounded byte reads. Use a workspace extension host with local file access or select the file with the local file picker.');
      }
      sources.set(id, { uri, source, diskRevision });
      return source;
    };
    const initial = await registerSource(document.uri, primaryId);
    let lastSignature = `${initialStat.mtime}-${initialStat.size}`;
    let contentSequence = 0;
    let ready = false;
    let hasBeenReady = false;
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshSerial = 0;
    const disposables: vscode.Disposable[] = [];

    const postError = (error: unknown) => {
      if (!disposed && ready) void webview.postMessage({
        type: 'host-error', message: error instanceof Error ? error.message : 'The source file is unavailable.',
      });
    };

    const refresh = async (force = false) => {
      if (disposed || !ready) { pending = true; return; }
      const serial = ++refreshSerial;
      try {
        const stat = await checkedStat(document.uri, settings(document.uri).maxFileBytes);
        if (disposed || serial !== refreshSerial) return;
        const signature = `${stat.mtime}-${stat.size}`;
        if (!force && signature === lastSignature) return;
        const source = await registerSource(document.uri, primaryId, ++contentSequence);
        lastSignature = signature;
        await webview.postMessage({ type: 'load', source, preserveView: true });
      } catch (error) {
        if (serial === refreshSerial) postError(error);
      }
    };

    const schedule = (uri: vscode.Uri) => {
      if (uri.toString() !== document.uri.toString() || !settings(document.uri).autoReload) return;
      if (timer) clearTimeout(timer);
      // Atomic save often produces delete + create. Wait for the replacement to settle.
      timer = setTimeout(() => { timer = undefined; void refresh(true); }, 300);
    };

    const directory = vscode.Uri.joinPath(document.uri, '..');
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, '*'));
    disposables.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule));
    disposables.push(webview.onDidReceiveMessage((message: unknown) => {
      const request = readWebviewRequest(message);
      if (request) {
        void (async () => {
          try {
            if (request.type === 'pickModels') {
              const selected = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, title: 'Add models / ground truth', filters: { '3D models': [...SUPPORTED_EXTENSIONS] } });
              if ((selected?.length ?? 0) + sources.size > 16) throw new Error('Keep at most 16 selected files in one comparison workspace.');
              const added: ModelSource[] = [];
              for (const uri of selected ?? []) added.push(await registerSource(uri));
              if (!disposed) await webview.postMessage({ type: 'modeldock-response', requestId: request.requestId, sources: added });
            } else {
              const entry = sources.get(request.sourceId);
              if (!entry || entry.source.revision !== request.revision) throw new Error('The selected model revision is no longer available. Reload it.');
              let bytes: Uint8Array;
              if (entry.diskRevision) bytes = await readSelectedRange(entry.uri.fsPath, entry.diskRevision, request.offset, request.length, config.maxFileBytes);
              else {
                const stat = await checkedStat(entry.uri, IN_MEMORY_FILE_BYTES);
                if (request.offset + request.length > stat.size) throw new Error('Invalid source byte range.');
                const all = await vscode.workspace.fs.readFile(entry.uri);
                bytes = all.slice(request.offset, request.offset + request.length);
              }
              if (sources.get(request.sourceId) !== entry) throw new Error('The source changed during this read.');
              if (!disposed) await webview.postMessage({ type: 'modeldock-response', requestId: request.requestId, base64: Buffer.from(bytes).toString('base64') });
            }
          } catch (error) {
            if (!disposed) await webview.postMessage({ type: 'modeldock-response', requestId: request.requestId, error: error instanceof Error ? error.message : 'Unable to read the selected file.' });
          }
        })();
        return;
      }
      switch (readWebviewCommand(message)) {
        case 'ready': {
          ready = true;
          // A hidden webview can be reconstructed from its original HTML. Always
          // supply current bytes on later handshakes, even if no new fs event fired.
          const changedBeforeReady = pending || hasBeenReady;
          hasBeenReady = true;
          pending = false;
          void refresh(changedBeforeReady);
          break;
        }
        case 'reload': void refresh(true); break;
        case 'openAsText':
          void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', panel.viewColumn);
          break;
      }
    }));
    panel.onDidDispose(() => {
      disposed = true;
      refreshSerial++;
      sources.clear();
      if (timer) clearTimeout(timer);
      for (const disposable of disposables) disposable.dispose();
    });

    const nonce = randomBytes(24).toString('base64');
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob:`,
      `connect-src ${webview.cspSource} blob:`,
      'worker-src blob:',
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');
    webview.html = renderViewerHtml({
      config: {
        ...config, host: 'vscode', allowFilePicker: true,
        assets: { worker: asset('worker.js'), occtJs: asset('occt-import-js.js'), occtWasm: asset('occt-import-js.wasm') },
        initialFile: initial,
      },
      script: asset('viewer.js'), stylesheet: asset('styles.css'), nonce, csp,
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(
    VIEW_TYPE, new ModelPreviewProvider(context.extensionUri),
    { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: false } },
  ));
  context.subscriptions.push(vscode.commands.registerCommand('modeldock.open', async (selected?: vscode.Uri) => {
    const uri = selected instanceof vscode.Uri ? selected : (await vscode.window.showOpenDialog({
      canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
      title: 'Open a model in ModelDock', filters: { '3D models': [...SUPPORTED_EXTENSIONS] },
    }))?.[0];
    if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('modeldock.reopenAsText', async (selected?: vscode.Uri) => {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const uri = selected instanceof vscode.Uri ? selected
      : active instanceof vscode.TabInputCustom ? active.uri : vscode.window.activeTextEditor?.document.uri;
    if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  }));
}

export function deactivate(): void { /* VS Code disposes subscriptions and panels. */ }
