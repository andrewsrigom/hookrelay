import { build as buildWeb } from 'vite';
import { build } from 'esbuild';

await buildWeb();

await build({
  entryPoints: ['apps/aws/api.ts', 'apps/aws/worker.ts', 'apps/aws/dispatcher.ts'],
  outdir: 'dist/lambda',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  sourcemap: true,
  logLevel: 'info',
});
