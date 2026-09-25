// Bundles the extension, the agent-side CLI and a test entry point, and copies
// the CLI into the skill folder that agents install.
import * as esbuild from 'esbuild';
import { copyFileSync, chmodSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', sourcemap: true, logLevel: 'info' };

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/cli/main.ts'], outfile: 'dist/cli.js', sourcemap: false },
  { ...common, entryPoints: ['src/engine/index.ts'], outfile: 'dist/test/engine.cjs' },
];

function copyCli() {
  copyFileSync('dist/cli.js', 'skill/review-comments/scripts/review-comments.js');
  chmodSync('skill/review-comments/scripts/review-comments', 0o755);
}

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copyCli();
}
