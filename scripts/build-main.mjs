import { build } from 'esbuild';
await build({ entryPoints: ['src/main/index.ts'], outfile: 'dist-main/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'node:sqlite'], sourcemap: true });
await build({ entryPoints: ['src/preload/index.ts'], outfile: 'dist-main/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' });
