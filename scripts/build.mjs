import { build } from 'esbuild';
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  cp,
  access,
  chmod,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { patchOcct } from './patch-occt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const out = path.join(root, 'dist');
await mkdir(path.join(out, 'web'), { recursive: true });
await mkdir(path.join(root, 'releases'), { recursive: true });
const base = {
  bundle: true,
  sourcemap: false,
  logLevel: 'warning',
  legalComments: 'eof',
  target: 'es2022',
};
await build({
  ...base,
  entryPoints: ['src/core/worker.ts'],
  outfile: 'dist/web/worker.js',
  platform: 'browser',
  format: 'iife',
  minify: true,
});
await build({
  ...base,
  entryPoints: ['src/viewer/entry.ts'],
  outfile: 'dist/web/viewer.js',
  platform: 'browser',
  format: 'iife',
  minify: true,
});
await copyFile('src/viewer/styles.css', 'dist/web/styles.css');
await patchOcct();
await copyFile(
  'node_modules/occt-import-js/dist/occt-import-js.wasm',
  'dist/web/occt-import-js.wasm',
);
await build({
  ...base,
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.cjs',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
});
await build({
  ...base,
  entryPoints: ['src/cli/cli.ts'],
  outfile: 'dist/cli.cjs',
  platform: 'node',
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
});
await chmod('dist/cli.cjs', 0o755);

const embedded = {
  workerSource: await readFile('dist/web/worker.js', 'utf8'),
  occtSource: await readFile('dist/web/occt-import-js.js', 'utf8'),
  occtWasmBase64: (await readFile('dist/web/occt-import-js.wasm')).toString('base64'),
};
const embeddedPlugin = {
  name: 'modeldock-embedded-assets',
  setup(builder) {
    builder.onResolve({ filter: /^modeldock:embedded-assets$/ }, () => ({
      path: 'assets',
      namespace: 'modeldock',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'modeldock' }, () => ({
      contents: Object.entries(embedded)
        .map(([name, value]) => `export const ${name}=${JSON.stringify(value)};`)
        .join('\n'),
      loader: 'js',
    }));
    builder.onResolve({ filter: /\?inline$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -7)),
      namespace: 'inline',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'inline' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

await mkdir('adapters/deepseek-harness/lib', { recursive: true });
const harness = await build({
  ...base,
  entryPoints: ['adapters/deepseek-harness/src/client.tsx'],
  write: false,
  platform: 'browser',
  format: 'cjs',
  minify: true,
  external: ['react', 'react/jsx-runtime'],
  plugins: [embeddedPlugin],
});
await writeFile(
  'adapters/deepseek-harness/lib/client.js',
  `window.__ModuleLoader__.load({id:'dsh-plugin-modeldock',factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${harness.outputFiles[0].text}\nreturn module.exports;}});\n`,
);
await build({
  ...base,
  entryPoints: ['adapters/deepseek-harness/src/index.ts'],
  outfile: 'adapters/deepseek-harness/lib/index.js',
  platform: 'node',
  format: 'esm',
});

let hasOpenAI = false;
try {
  await access('src/openai/app.ts');
  hasOpenAI = true;
} catch {}
if (hasOpenAI) {
  await mkdir('dist/openai', { recursive: true });
  const app = await build({
    ...base,
    entryPoints: ['src/openai/app.ts'],
    write: false,
    platform: 'browser',
    format: 'iife',
    minify: true,
    plugins: [embeddedPlugin],
  });
  // The bundled WASM's base64 makes an uncompressed UI larger than the MCP
  // SDK's default 10 MiB stdio message limit. Compress the IIFE, then use the
  // browser's streaming decompressor and an already-declared local Blob script.
  // This preserves the self-contained resource without JavaScript eval or a CDN.
  const compressedApp = gzipSync(Buffer.from(app.outputFiles[0].text), { level: 9 }).toString(
    'base64',
  );
  const bootstrap = `(async()=>{
    const nonce=document.currentScript?.nonce;
    let scriptUrl;
    try {
      if(typeof DecompressionStream!=='function')throw new Error('This desktop webview cannot unpack ModelDock. Update the Desktop application, or use the ModelDock VS Code extension or local viewer.');
      const packed=Uint8Array.from(atob(${JSON.stringify(compressedApp)}),character=>character.charCodeAt(0));
      const unpacked=await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).blob();
      scriptUrl=URL.createObjectURL(unpacked.slice(0,unpacked.size,'text/javascript'));
      await new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        if(nonce)script.nonce=nonce;
        script.src=scriptUrl;
        script.onload=resolve;
        script.onerror=()=>reject(new Error('The host blocked the local ModelDock script. Use a supported Desktop file viewer, the VS Code extension, or the local viewer.'));
        document.head.appendChild(script);
      });
    } catch(error) {
      const message=document.createElement('pre');
      message.style.cssText='padding:24px;white-space:pre-wrap;font:14px/1.6 system-ui,sans-serif;color:#e6ecf5;background:#10141c';
      message.textContent='ModelDock could not start: '+(error instanceof Error?error.message:String(error));
      document.body.replaceChildren(message);
    } finally { if(scriptUrl)URL.revokeObjectURL(scriptUrl); }
  })();`;
  const css = await readFile('src/viewer/styles.css', 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ModelDock</title><style>html,body,#app{height:100%;min-height:480px;margin:0;overflow:hidden}${css}</style></head><body><div id="app"></div><script>${bootstrap}</script></body></html>`;
  if (Buffer.byteLength(JSON.stringify(html)) > 9 * 1024 * 1024) {
    throw new Error(
      'The OpenAI UI exceeds its 9 MiB transport budget; reduce the bundled payload before packaging.',
    );
  }
  await writeFile('dist/openai/viewer.html', html);
  await build({
    ...base,
    entryPoints: ['src/openai/mcp.ts'],
    outfile: 'dist/mcp.cjs',
    platform: 'node',
    format: 'cjs',
    banner: { js: '#!/usr/bin/env node' },
  });
  await chmod('dist/mcp.cjs', 0o755);
  await mkdir('adapters/openai/dist/openai', { recursive: true });
  await copyFile('dist/mcp.cjs', 'adapters/openai/dist/mcp.cjs');
  await copyFile('dist/openai/viewer.html', 'adapters/openai/dist/openai/viewer.html');
}

// Preserve complete license texts for all production dependencies in distributable packages.
// Rebuild the generated inventory after dependency upgrades; do not retain old versions.
await rm('dist/licenses', { recursive: true, force: true });
await mkdir('dist/licenses', { recursive: true });
await cp('third_party/licenses', 'dist/licenses', { recursive: true });
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const packagePaths = Object.entries(lock.packages)
  .filter(([dir, info]) => dir && info.dev !== true)
  .map(([dir]) => path.join(root, dir));
const rows = [];
for (const dir of packagePaths) {
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const id = `${pkg.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${pkg.version}`;
  const licenseFiles = (await readdir(dir)).filter((name) =>
    /^(LICEN[CS]E|COPYING|NOTICE)(\.|$)/i.test(name),
  );
  for (const file of licenseFiles)
    await copyFile(path.join(dir, file), path.join('dist/licenses', `${id}-${file}`));
  rows.push(
    `| ${pkg.name} | ${pkg.version} | ${typeof pkg.license === 'string' ? pkg.license : 'See package'} |`,
  );
}
// The shared Harness entry intentionally relies on host-provided React (not a bundled runtime).
const notice = `# Third-party notices\n\nModelDock's original source is MIT licensed. Each dependency retains its license.\nAll runtime files are bundled locally; viewing does not require a CDN or a cloud conversion service.\n\n## CAD kernel\n\n**occt-import-js 0.0.23** is distributed under LGPL-2.1 and includes an OpenCascade Technology 7.6.1 WebAssembly build.\nThe WebAssembly is unmodified. The JavaScript glue has a hash-guarded patch using static Emscripten invoker closures so it runs without JavaScript unsafe-eval; see scripts/patch-occt.mjs and docs/cad-source.md. Both remain replaceable components. Complete LGPL and OCCT exception texts are in dist/licenses/ (or licenses/ in native adapter packages).\nWrapper source: https://github.com/kovacsv/occt-import-js/tree/c2148e54b456b571238d35cac037d304053d64b2 .\nOpenCascade source: https://github.com/Open-Cascade-SAS/OCCT/tree/d2abb6d844231cb8f29be6894440874a4700e4a5 .\nThe complete source release includes matching unmodified archives in third_party/cad-source/. See docs/cad-source.md for checksums, source lineage and rebuild steps using Emscripten 3.1.69.\nYou may replace dist/web/occt-import-js.js and dist/web/occt-import-js.wasm, or rebuild all embedded adapters with npm run build.\nThe MIT license of the surrounding application does not relicense the CAD kernel. Distribute the corresponding source package alongside binary releases.\n\n## Runtime dependency inventory\n\n| Package | Version | License |\n| --- | --- | --- |\n${[...new Set(rows)].sort().join('\n')}\n\nFull available license and notice texts are shipped in dist/licenses/. Build and test tooling is listed in package-lock.json.\nReact in the DeepSeek Harness adapter is provided by the host and is not copied into the adapter.\n`;
await writeFile('THIRD_PARTY_NOTICES.md', notice);
for (const target of ['adapters/deepseek-harness', ...(hasOpenAI ? ['adapters/openai'] : [])]) {
  await copyFile('LICENSE', `${target}/LICENSE`);
  await copyFile('THIRD_PARTY_NOTICES.md', `${target}/THIRD_PARTY_NOTICES.md`);
  await copyFile('docs/cad-source.md', `${target}/CAD_SOURCE.md`);
  await rm(`${target}/licenses`, { recursive: true, force: true });
  await cp('dist/licenses', `${target}/licenses`, { recursive: true });
}
console.log(
  'Built VS Code extension, local viewer, DeepSeek Harness' +
    (hasOpenAI ? ' and OpenAI file viewer' : '') +
    '.',
);
