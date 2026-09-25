// Runs the integration suite in a real VS Code: the local install, a
// throwaway profile, and a scratch repository where an "agent" made changes.
import { runTests } from '@vscode/test-electron';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const tmp = mkdtempSync(path.join(tmpdir(), 'grv-vscode-'));
const repo = path.join(tmp, 'repo');
mkdirSync(repo);
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Test User');
git('config', 'user.email', 'test@example.com');
writeFileSync(path.join(repo, 'a.txt'), lines(30));
writeFileSync(path.join(repo, 'c.txt'), 'to be deleted\n');
git('add', '-A');
git('commit', '-q', '-m', 'initial');
git('checkout', '-q', '-b', 'feature');
const a = lines(30).split('\n');
a[2] = 'three';
a[24] = 'twenty-five';
writeFileSync(path.join(repo, 'a.txt'), a.join('\n'));
writeFileSync(path.join(repo, 'b.txt'), 'new file\n');
rmSync(path.join(repo, 'c.txt'));
git('add', '-A');
git('commit', '-q', '-m', 'agent work');

let xvfb;
const env = { ...process.env, GRV_TEST_REPO: repo, GRV_ROOT: root };
// a private X server, unless asked to use the current display
if (!process.env.GRV_USE_DISPLAY && existsSync('/usr/bin/Xvfb')) {
  xvfb = spawn('/usr/bin/Xvfb', [':97', '-screen', '0', '1600x1000x24'], { stdio: 'ignore' });
  env.DISPLAY = ':97';
  await new Promise((r) => setTimeout(r, 800));
}
process.env.DISPLAY = env.DISPLAY;
process.env.GRV_TEST_REPO = repo;
process.env.GRV_ROOT = root;
let code = 0;
try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH ?? '/usr/share/code/code',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test/vscode/suite.cjs'),
    launchArgs: [repo, '--user-data-dir', path.join(tmp, 'user'), '--extensions-dir', path.join(tmp, 'ext'), '--disable-workspace-trust', '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: env,
  });
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  xvfb?.kill();
}
process.exit(code);
