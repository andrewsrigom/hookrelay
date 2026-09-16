import { startLocal } from '../../packages/runtime/local.js';

const app = await startLocal({
  directory: process.env['HOOKRELAY_DATA_DIR'] ?? '.local',
  staticDirectory: 'dist/web',
  apiPort: Number(process.env['API_PORT'] ?? 4310),
  receiverPort: Number(process.env['RECEIVER_PORT'] ?? 4311),
});

process.stdout.write(`HookRelay: ${app.apiOrigin}
`);

let stopping = false;

async function stop() {
  if (stopping) {
    return;
  }

  stopping = true;
  await app.stop();
  process.exit(0);
}

process.on('SIGINT', () => {
  void stop();
});

process.on('SIGTERM', () => {
  void stop();
});
