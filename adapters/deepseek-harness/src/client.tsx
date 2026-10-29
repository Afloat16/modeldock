import { useEffect, useRef, useState } from 'react';
import { workerSource, occtSource, occtWasmBase64 } from 'modeldock:embedded-assets';
import { mountViewer } from '../../../src/viewer/viewer.js';
import viewerStyles from '../../../src/viewer/styles.css?inline';
import { SUPPORTED_EXTENSIONS, isSupported } from '../../../src/shared/formats.js';
import { DEFAULT_MAX_FILE_BYTES, type ViewerHandle, type ViewerViewState } from '../../../src/shared/types.js';
import type { DocumentPreviewInput, HarnessContext, PreviewDefinition } from './contract.js';
import { harnessRangeSource, type HarnessFileRemote } from './range-source.js';
import { createEmbeddedAssetPool, createViewStateCache, nameFromResourceAddress, type AssetLease } from './helpers.js';

const PREVIEW_ID = 'dsh-plugin-modeldock/model';


interface ViewerInjected {
  remote: HarnessFileRemote;
  retainAssets(): AssetLease;
  viewStates: ReturnType<typeof createViewStateCache<ViewerViewState>>;
}

/** Byte content and resource identity are supplied by DSH's existing file tab. */
function ModelPreview(props: DocumentPreviewInput & ViewerInjected) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerHandle | null>(null);
  const revisionRef = useRef(0);
  const previousAddressRef = useRef<string | undefined>(undefined);
  const [failure, setFailure] = useState<string>();
  const name = nameFromResourceAddress(props.resourceAddress);
  const contentRevision = props.content.kind === 'renderer' ? props.content.revision : 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = viewerStyles;
    const container = document.createElement('div');
    container.style.cssText = 'height:100%;width:100%;min-height:360px;';
    shadow.replaceChildren(style, container);
    let lease: AssetLease | undefined;
    let viewer: ViewerHandle | undefined;
    try {
      lease = props.retainAssets();
      const locale = document.documentElement.lang || navigator.language;
      viewer = mountViewer(container, {
        host: 'deepseek',
        assets: lease.assets,
        maxFileBytes: DEFAULT_MAX_FILE_BYTES,
        allowFilePicker: true,
        autoReload: true,
        language: /^zh\b/i.test(locale) ? 'zh-CN' : 'en',
      });
      viewerRef.current = viewer;
      setFailure(undefined);
    } catch (error) {
      lease?.release();
      setFailure(error instanceof Error ? error.message : String(error));
    }
    return () => {
      revisionRef.current++;
      viewerRef.current = null;
      const address = previousAddressRef.current;
      const savedView = viewer?.getViewState?.();
      if (address && savedView) props.viewStates.set(address, savedView);
      previousAddressRef.current = undefined;
      try { viewer?.dispose(); }
      finally {
        lease?.release();
        shadow.replaceChildren();
      }
    };
  }, [props.retainAssets, props.viewStates]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const revision = ++revisionRef.current;
    const abort = new AbortController();
    if (!isSupported(name)) { setFailure(`ModelDock cannot preview this file type: ${name}`); return; }
    setFailure(undefined);
    const preserveView = previousAddressRef.current === props.resourceAddress;
    const savedView = preserveView ? undefined : props.viewStates.get(props.resourceAddress);
    previousAddressRef.current = props.resourceAddress;
    props.addResource?.(props.resourceAddress);
    void harnessRangeSource(props.remote, props.resourceAddress, name, abort.signal).then(async source => {
      if (revision !== revisionRef.current || abort.signal.aborted) return;
      await viewer.load(source, { preserveView });
      if (revision !== revisionRef.current || abort.signal.aborted) return;
      if (savedView) viewer.setViewState?.(savedView);
      if (props.content.kind === 'renderer') props.content.loaded(source.revision!);
    }).catch(error => {
      if (revision === revisionRef.current && !abort.signal.aborted) {
        setFailure(error instanceof Error ? error.message : String(error));
        if (props.content.kind === 'renderer') props.content.failed();
      }
    });
    return () => { abort.abort(); revisionRef.current++; };
  }, [contentRevision, name, props.resourceAddress, props.remote, props.retainAssets, props.viewStates]);

  return <div style={{ position: 'relative', height: '100%', minHeight: 360, overflow: 'hidden' }}>
    <div ref={hostRef} data-modeldock-preview style={{ height: '100%', minHeight: 360 }} />
    {failure && <div role="alert" style={{
      position: 'absolute', inset: '12px 12px auto', zIndex: 10,
      padding: 12, borderRadius: 8, background: '#412725', color: '#ffe4de',
      font: '13px/1.6 system-ui, sans-serif', whiteSpace: 'pre-wrap',
    }}>{failure}</div>}
  </div>;
}

/** Runtime service names, distinct from the package names in dsh.client.inject. */
export const inject = ['documentPreviews', 'slots', 'remote', 'remote.workspaceFiles'];

export function apply(ctx: HarnessContext): void {
  const pool = createEmbeddedAssetPool({ workerSource, occtSource, occtWasmBase64 });
  const viewStates = createViewStateCache<ViewerViewState>(32);
  ctx.effect(() => () => pool.dispose(), 'modeldock: embedded assets');
  ctx.effect(() => () => viewStates.clear(), 'modeldock: view state');
  const definition: PreviewDefinition = {
    id: PREVIEW_ID,
    extensions: SUPPORTED_EXTENSIONS,
    // GLB is always binary. PLY/STL may be ASCII and retain source-view alternatives.
    binaryExtensions: ['glb'],
    priority: 'extension',
    title: () => 'ModelDock · 3D',
    loading: 'renderer',
    wrap: false,
  };
  ctx.effect(() => ctx.documentPreviews.register(definition), 'modeldock: preview metadata');
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document',
    key: PREVIEW_ID,
    inject: (): ViewerInjected => ({ retainAssets: pool.retain, viewStates, remote: ctx.remote }),
  }, ModelPreview)), 'modeldock: preview body');
}
