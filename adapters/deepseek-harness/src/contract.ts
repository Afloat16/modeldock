import type { ComponentType } from 'react';
import type { HarnessFileRemote } from './range-source.js';

/**
 * Deliberately narrow structural boundary, matched to DSH 0.2.2-alpha.2.
 * The full DSH workspace is not a runtime or build dependency of this adapter.
 * Authoritative types: ui-sidebar-documentpreview/src/client/document/{contract,registry}.ts.
 */
export interface DocumentPreviewInput {
  readonly resourceAddress: string;
  readonly content:
    | { readonly kind: 'bytes'; readonly data: Uint8Array }
    | { readonly kind: 'text'; readonly text: string; readonly eof: boolean }
    | { readonly kind: 'renderer'; readonly revision: number; readonly loaded: (version: string) => void; readonly failed: () => void; readonly reload: () => void };
  readonly addResource?: (address: string) => void;
}

export interface PreviewDefinition {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly binaryExtensions?: readonly string[];
  readonly priority: 'extension';
  readonly title: () => string;
  readonly loading: 'renderer';
  readonly wrap: false;
}

type Dispose = () => void;

/** Only these documented services cross from the Harness runtime into ModelDock. */
export interface HarnessContext {
  remote: HarnessFileRemote;
  effect(effect: () => Dispose | void, label?: string): unknown;
  documentPreviews: { register(definition: PreviewDefinition): Dispose };
  slots: {
    inject(name: 'sidebar.right.tab.document', register: () => Dispose): Dispose;
    register<Injected extends object>(
      options: {
        name: 'sidebar.right.tab.document';
        key: string;
        inject: () => Injected;
      },
      component: ComponentType<DocumentPreviewInput & Injected>,
    ): Dispose;
  };
}
