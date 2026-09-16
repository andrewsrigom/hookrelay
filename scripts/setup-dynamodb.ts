import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Official AWS download, pinned by checksum so the test runtime cannot change silently.
// This archive reports version 3.3.1, despite the /v2.x/ segment in the official URL.
const archiveUrl = 'https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz';

const expectedSha256 = 'f80bcec477f85f57e2c77f8d54aa6b672a8403fceff0c450560aee1cf6c21163';

const directory = resolve(process.env.HOOKRELAY_TOOLS_DIR ?? '.local/tools', 'dynamodb');

const markerPath = resolve(directory, 'installed.sha256');

async function alreadyInstalled(): Promise<boolean> {
  try {
    await access(resolve(directory, 'DynamoDBLocal.jar'));
    return (await readFile(markerPath, 'utf8')).trim() === expectedSha256;
  } catch {
    return false;
  }
}

if (await alreadyInstalled()) {
  process.stdout.write('DynamoDB Local is already installed.\n');
} else {
  process.stdout.write('Downloading the official DynamoDB Local archive...\n');
  const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(120000) });

  if (!response.ok) {
    throw new Error(`DynamoDB Local download failed: HTTP ${response.status}`);
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const checksum = createHash('sha256').update(archive).digest('hex');

  if (checksum !== expectedSha256) {
    throw new Error(
      'DynamoDB Local archive changed. Review the AWS release and update its pinned checksum before installing.',
    );
  }

  await mkdir(directory, { recursive: true });
  const archivePath = resolve(directory, 'dynamodb.tar.gz');
  await writeFile(archivePath, archive);
  const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
    .trim()
    .split('\n');

  if (entries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) {
    throw new Error('Unexpected path in DynamoDB Local archive');
  }

  execFileSync('tar', ['-xzf', archivePath, '-C', directory], { stdio: 'inherit' });
  await writeFile(markerPath, expectedSha256 + '\n');
  process.stdout.write('DynamoDB Local installed under .local/tools/dynamodb.\n');
}
