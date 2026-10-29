import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startViewerServer } from './server';
import { HELP, parseArgs } from './args';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  let filePath = options.filePath ? resolve(options.filePath) : undefined;
  if (filePath && (await stat(filePath)).isDirectory()) filePath = undefined;
  const server = await startViewerServer({
    filePath, assetsPath: join(__dirname, 'web'), port: options.port,
    maxFileBytes: options.maxFileBytes, autoReload: options.autoReload,
    language: /^(zh)/i.test(process.env.LANG ?? '') ? 'zh-CN' : 'en',
  });
  process.stdout.write(`ModelDock is ready.\n${server.url}\n\n${filePath ? 'Watching the selected model for updates.' : 'Choose a model in the viewer.'}\nPress Ctrl+C to stop.\n`);
  if (options.open) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', server.url] : [server.url];
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.on('error', () => process.stderr.write('The browser could not be opened automatically. Open the printed URL manually.\n'));
    child.unref();
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`ModelDock: ${error instanceof Error ? error.message : 'Unable to start.'}\n`);
  process.exitCode = 1;
});
