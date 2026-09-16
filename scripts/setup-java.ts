import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { resolve } from 'node:path';

// Version and checksum come from the official Eclipse Adoptium release metadata.
const release = '17.0.20.1+1';

const expectedSha256 = '0b2b640e3046b64c8ec504de0ab9d91bb5610182bda21fad454681ce54d45a62';

const archiveUrl =
  'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_linux_hotspot_17.0.20.1_1.tar.gz';

const toolsRoot = resolve(process.env.HOOKRELAY_TOOLS_DIR ?? '.local/tools');

const directory = resolve(toolsRoot, 'temurin17');

const javaPath = resolve(directory, `jdk-${release}-jre/bin/java`);

const markerPath = resolve(directory, 'installed.sha256');

const archivePath = resolve(toolsRoot, 'temurin17-jre.tar.gz');

if (platform() !== 'linux' || arch() !== 'x64') {
  throw new Error(
    'The bundled Temurin runtime supports Linux x64. Use Java 17+ on PATH for other platforms.',
  );
}

async function alreadyInstalled(): Promise<boolean> {
  try {
    await access(javaPath);

    if ((await readFile(markerPath, 'utf8')).trim() !== expectedSha256) {
      return false;
    }

    execFileSync(javaPath, ['-version']);

    return true;
  } catch {
    return false;
  }
}

async function verifiedArchive(): Promise<Buffer> {
  let cached: Buffer | undefined;

  try {
    cached = await readFile(archivePath);
  } catch {
    // First setup downloads the runtime.
  }

  if (cached && createHash('sha256').update(cached).digest('hex') === expectedSha256) {
    return cached;
  }

  process.stdout.write('Downloading Eclipse Temurin JRE 17...\n');
  const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(180000) });

  if (!response.ok) {
    throw new Error(`Temurin download failed: HTTP ${response.status}`);
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const checksum = createHash('sha256').update(archive).digest('hex');

  if (checksum !== expectedSha256) {
    throw new Error(
      'Temurin archive checksum changed. Review the official release before installing.',
    );
  }

  await mkdir(toolsRoot, { recursive: true });
  await writeFile(archivePath, archive);

  return archive;
}

if (await alreadyInstalled()) {
  process.stdout.write('Eclipse Temurin JRE 17 is already installed.\n');
} else {
  await verifiedArchive();
  await mkdir(directory, { recursive: true });
  const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
    .trim()
    .split('\n');
  const folder = `jdk-${release}-jre`;

  if (
    entries.some(
      (entry) =>
        !entry.startsWith(`${folder}/`) || entry.startsWith('/') || entry.split('/').includes('..'),
    )
  ) {
    throw new Error('Unexpected path in Temurin archive');
  }

  execFileSync('tar', ['-xzf', archivePath, '-C', directory, '--no-same-owner'], {
    stdio: 'inherit',
  });
  await access(javaPath);
  execFileSync(javaPath, ['-version']);
  await writeFile(markerPath, expectedSha256 + '\n');
  process.stdout.write('Eclipse Temurin JRE 17 installed under .local/tools/temurin17.\n');
}
