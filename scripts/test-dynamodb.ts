import { access, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';

const toolsRoot = resolve(process.env.HOOKRELAY_TOOLS_DIR ?? '.local/tools');

const directory = resolve(toolsRoot, 'dynamodb');

const jar = resolve(directory, 'DynamoDBLocal.jar');

try {
  await access(jar);
} catch {
  throw new Error('Run pnpm local:setup first. Java 17+ must also be available.');
}

async function unusedPort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();

  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a local port');
  }

  await new Promise<void>((resolveClose, reject) =>
    socket.close((error) => (error ? reject(error) : resolveClose())),
  );

  return address.port;
}

const localJavaRoot = resolve(toolsRoot, 'temurin17');

const localJavaFolders = await readdir(localJavaRoot, { withFileTypes: true }).catch(() => []);

let java = process.env.HOOKRELAY_JAVA_BIN ?? 'java';

if (java === 'java') {
  for (const folder of localJavaFolders) {
    if (!folder.isDirectory()) {
      continue;
    }
    const candidate = resolve(localJavaRoot, folder.name, 'bin/java');
    try {
      await access(candidate);
      java = candidate;
      break;
    } catch {
      // Use the next local runtime or Java on PATH.
    }
  }
}

const port = await unusedPort();

const endpoint = `http://127.0.0.1:${port}`;

const database = spawn(
  java,
  [
    '-Djava.library.path=./DynamoDBLocal_lib',
    '-jar',
    jar,
    '-inMemory',
    '-sharedDb',
    '-port',
    String(port),
  ],
  { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] },
);

const stopped = new Promise<void>((resolveStopped) => {
  database.once('exit', () => resolveStopped());
  database.once('error', () => resolveStopped());
});

let processError: Error | undefined;

database.once('error', (error) => {
  processError =
    'code' in error && error.code === 'ENOENT'
      ? new Error('Java runtime not found. Run pnpm local:setup to install project-local Java 17.')
      : error;
});

let diagnostics = '';

database.stdout.on('data', (chunk) => {
  diagnostics += String(chunk);
});

database.stderr.on('data', (chunk) => {
  diagnostics += String(chunk);
});

// Explicit fake credentials and a loopback endpoint ensure this command never uses an AWS account.
const client = new DynamoDBClient({
  region: 'us-east-1',
  endpoint,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  maxAttempts: 1,
});

try {
  let ready = false;

  for (let attempt = 0; attempt < 60; attempt++) {
    if (processError) {
      throw processError;
    }
    if (database.exitCode !== null) {
      throw new Error(`DynamoDB Local exited: ${diagnostics}`);
    }
    try {
      await client.send(new ListTablesCommand({}));
      ready = true;
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }

  if (!ready) {
    throw new Error(`DynamoDB Local did not become ready: ${diagnostics}`);
  }

  process.stdout.write(`AWS SDK integration tests against DynamoDB Local at ${endpoint}\n`);
  const tests = spawn(
    'pnpm',
    ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts'],
    { stdio: 'inherit', env: { ...process.env, DYNAMODB_LOCAL_ENDPOINT: endpoint } },
  );
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    tests.once('error', reject);
    tests.once('exit', (code) => resolveExit(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  client.destroy();
  database.kill('SIGTERM');
  const forceStop = setTimeout(() => database.kill('SIGKILL'), 3000);
  await stopped;
  clearTimeout(forceStop);
  await mkdir('.local', { recursive: true });
  await writeFile('.local/dynamodb-test-runtime.log', diagnostics);
}
