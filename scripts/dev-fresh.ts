import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const runsDirectory = resolve('.local');

await mkdir(runsDirectory, { recursive: true });

process.env['HOOKRELAY_DATA_DIR'] = await mkdtemp(`${runsDirectory}${sep}run-`);

await import('./dev.js');
