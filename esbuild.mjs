// Bundles the review engine for the tests.
import * as esbuild from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', sourcemap: true, logLevel: 'info' };

await esbuild.build({ ...common, entryPoints: ['src/engine/index.ts'], outfile: 'dist/test/engine.cjs' });
