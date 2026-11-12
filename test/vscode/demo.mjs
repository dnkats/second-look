// Opens VS Code on a small demo repository and takes screenshots of the
// review UI: node test/vscode/demo.mjs <output dir>. Needs Xvfb and ImageMagick.
import { runTests } from '@vscode/test-electron';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(process.argv[2] ?? 'screenshots');
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(path.join(tmpdir(), 'grv-demo-'));
const repo = path.join(tmp, 'solver');
mkdirSync(path.join(repo, 'src'), { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
const put = (f, c) => writeFileSync(path.join(repo, f), c);

git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Daniel');
git('config', 'user.email', 'daniel@example.com');
put('README.md', '# Solver\n\nSolves the amplitude equations by fixed-point iteration.\n');
put('notes.txt', 'try damping?\n');
put('src/solver.jl', `module Solver

export solve

"""
    residual(t, f, v)

Residual of the amplitude equations.
"""
function residual(t, f, v)
    r = f * t - t * f
    return r
end

function update(t, r, denom)
    return t - r ./ denom
end

function solve(f, v; maxit=50, tol=1e-8)
    t = zero(f)
    for it in 1:maxit
        r = residual(t, f, v)
        if norm(r) < tol
            return t
        end
        t = update(t, r, diag(f))
    end
    error("not converged")
end

end
`);
git('add', '-A');
git('commit', '-q', '-m', 'initial');
git('checkout', '-q', '-b', 'damping');
put('README.md', '# Solver\n\nSolves the amplitude equations by damped fixed-point iteration.\n');
rmSync(path.join(repo, 'notes.txt'));
put('src/damping.jl', `"""
    damping(it; start=0.5, rate=0.9)

Damping factor for iteration \`it\`.
"""
damping(it; start=0.5, rate=0.9) = start * rate^(it - 1)
`);
put('src/solver.jl', `module Solver

export solve

include("damping.jl")

"""
    residual(t, f, v)

Residual of the amplitude equations.
"""
function residual(t, f, v)
    r = f * t - t * f + v
    return r
end

function update(t, r, denom, alpha)
    step = r ./ denom
    return t - alpha * step
end

function solve(f, v; maxit=100, tol=1e-8)
    t = zero(f)
    for it in 1:maxit
        r = residual(t, f, v)
        @info "iteration" it norm(r)
        if norm(r) < tol
            return t
        end
        t = update(t, r, diag(f), damping(it))
    end
    error("not converged after $maxit iterations")
end

end
`);
git('add', '-A');
git('commit', '-q', '-m', 'Damped iterations');

const user = path.join(tmp, 'user');
mkdirSync(path.join(user, 'User'), { recursive: true });
writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
  'window.newWindowDimensions': 'maximized',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'chat.disableAIFeatures': true,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'editor.minimap.enabled': false,
  'git.openRepositoryInParentFolders': 'never',
  'workbench.colorTheme': 'Default Light Modern',
  'diffEditor.renderSideBySide': !process.env.GRV_INLINE,
  ...JSON.parse(process.env.GRV_SETTINGS ?? '{}'),
}, null, 1));

const display = ':98';
const xvfb = spawn('/usr/bin/Xvfb', [display, '-screen', '0', process.env.GRV_SCREEN ?? '1600x1000x24'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
process.env.DISPLAY = display;

// the suite announces each scene with <tmp>/scene-N.ready and waits for .done
let stop = false;
const shots = (async () => {
  for (let n = 0; !stop; ) {
    if (existsSync(path.join(tmp, `scene-${n}.ready`))) {
      await new Promise((r) => setTimeout(r, 1500));
      execFileSync('import', ['-display', display, '-window', 'root', path.join(out, `scene-${n}.png`)]);
      writeFileSync(path.join(tmp, `scene-${n}.done`), '');
      n++;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
})();

try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH ?? '/usr/share/code/code',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test/vscode/demo.cjs'),
    // the gutter buttons use a proposed API, which a stable VS Code allows only when asked
    launchArgs: [repo, '--user-data-dir', user, '--extensions-dir', path.join(tmp, 'ext'), '--disable-workspace-trust', '--no-sandbox', '--disable-gpu', '--enable-proposed-api', 'dnkats.second-look'],
    extensionTestsEnv: { GRV_TEST_REPO: repo, GRV_ROOT: root, GRV_TMP: tmp, DISPLAY: display },
  });
} finally {
  stop = true;
  await shots;
  xvfb.kill();
}
console.log(`screenshots in ${out}`);
