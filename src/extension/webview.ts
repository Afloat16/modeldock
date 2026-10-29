import type { ViewerConfig } from '../shared/types';

/** Keep arbitrary filenames out of executable HTML, including </script> payloads. */
export function serializeConfig(config: object): string {
  return JSON.stringify(config)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

export function renderViewerHtml(options: {
  config: ViewerConfig;
  script: string;
  stylesheet: string;
  nonce: string;
  csp: string;
}): string {
  return `<!doctype html>
<html lang="${options.config.language === 'zh-CN' ? 'zh-CN' : 'en'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(options.csp)}">
  <meta name="referrer" content="no-referrer">
  <title>ModelDock · 3D Preview</title>
  <link rel="stylesheet" href="${escapeAttribute(options.stylesheet)}">
</head>
<body>
  <div id="app"></div>
  <script id="modeldock-config" type="application/json" nonce="${escapeAttribute(options.nonce)}">${serializeConfig(options.config)}</script>
  <script nonce="${escapeAttribute(options.nonce)}" src="${escapeAttribute(options.script)}"></script>
</body>
</html>`;
}

export type WebviewCommand = 'ready' | 'reload' | 'openAsText';

export type WebviewRequest = { type: 'pickModels'; requestId: string } | {
  type: 'readRange'; requestId: string; sourceId: string; revision: string; offset: number; length: number;
};
export function readWebviewRequest(message: unknown): WebviewRequest | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const value = message as Record<string, unknown>;
  if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.requestId)) return;
  if (value.type === 'pickModels' && Object.keys(value).length === 2) return value as WebviewRequest;
  const fields = ['type', 'requestId', 'sourceId', 'revision', 'offset', 'length'];
  if (value.type !== 'readRange' || Object.keys(value).some(key => !fields.includes(key)) || Object.keys(value).length !== fields.length) return;
  if (typeof value.sourceId !== 'string' || !/^[a-f0-9]{32}$/.test(value.sourceId) || typeof value.revision !== 'string' || value.revision.length > 250) return;
  if (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0 || !Number.isSafeInteger(value.length) || (value.length as number) < 1 || (value.length as number) > 4 * 1024 ** 2) return;
  return value as WebviewRequest;
}

export function readWebviewCommand(message: unknown): WebviewCommand | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const record = message as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'type')) return;
  if (record.type === 'ready' || record.type === 'reload' || record.type === 'openAsText') {
    return record.type;
  }
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value : fallback;
}
