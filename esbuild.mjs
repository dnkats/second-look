// Bundles the agent-side CLI and a test entry point, and copies the CLI into
// the skill folder that agents install.
import * as esbuild from 'esbuild';
import { copyFileSync, chmodSync } from 'node:fs';

const common = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', sourcemap: true, logLevel: 'info' };

await Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/cli/main.ts'], outfile: 'dist/cli.js', sourcemap: false }),
  esbuild.build({ ...common, entryPoints: ['src/engine/index.ts'], outfile: 'dist/test/engine.cjs' }),
]);
copyFileSync('dist/cli.js', 'skill/review-comments/scripts/review-comments.js');
chmodSync('skill/review-comments/scripts/review-comments', 0o755);
