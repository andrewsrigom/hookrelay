import { createServer } from 'vite';
import { startLocal } from '../packages/runtime/local.js';
import { loadEnvFile } from 'node:process';

try {
  loadEnvFile('.env');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
    throw error;
  }
}

const app = await startLocal({
  directory: process.env['HOOKRELAY_DATA_DIR'] ?? '.local',
  apiPort: Number(process.env['API_PORT'] ?? 4310),
  receiverPort: Number(process.env['RECEIVER_PORT'] ?? 4311),
  webPort: Number(process.env['WEB_PORT'] ?? 4317),
});

const vite = await createServer();

await vite.listen();

process.stdout.write(`
HookRelay is running
Panel: http://localhost:${process.env['WEB_PORT'] ?? 4317}
API: ${app.apiOrigin}
Receiver: ${app.receiverOrigin}
Data: ${process.env['HOOKRELAY_DATA_DIR'] ?? '.local'}/hookrelay.sqlite

`);

let stopping = false;

async function stop() {
  if (stopping) {
    return;
  }

  stopping = true;
  await vite.close();
  await app.stop();
  process.exit(0);
}

process.on('SIGINT', () => {
  void stop();
});

process.on('SIGTERM', () => {
  void stop();
});
