// Scenes for test/vscode/demo.mjs; each waits until the screenshot is taken.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const repo = process.env.GRV_TEST_REPO;
const root = process.env.GRV_ROOT;
const tmp = process.env.GRV_TMP;
const { hunkKey } = require(path.join(root, 'dist/test/engine.cjs'));
const cli = path.join(root, 'skill/review-comments/scripts/review-comments');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) {
      return v;
    }
    await sleep(100);
  }
  throw new Error('timeout');
}

async function scene(n) {
  fs.writeFileSync(path.join(tmp, `scene-${n}.ready`), '');
  await until(() => fs.existsSync(path.join(tmp, `scene-${n}.done`)), 60000);
}

exports.run = async function run() {
  const api = await vscode.extensions.getExtension('dnkats.second-look').activate();
  const model = await until(() => api.manager.models.find((m) => m.state === 'changes'));
  const file = (rel) => vscode.Uri.file(path.join(repo, rel));
  await vscode.commands.executeCommand('secondLook.view.focus');
  const solver = model.pendingFile('src/solver.jl');
  const nodes = await api.tree.getChildren((await api.tree.getChildren())[0]);
  const solverNode = nodes.find((n) => n.file.path === 'src/solver.jl');
  const hunkNodes = await api.tree.getChildren(solverNode);
  await api.view.reveal(hunkNodes[0], { expand: true, select: false });
  await vscode.commands.executeCommand('secondLook.openChange', { root: repo, path: 'src/solver.jl', group: 'pending', line: solver.hunks[1].newStart });
  await sleep(1500);
  await scene(1);

  // accept the first change, leave a comment on the damping step, and let the "agent" answer
  await vscode.commands.executeCommand('secondLook.accept', { root: repo, path: 'src/solver.jl', group: 'pending', key: hunkKey(solver.hunks[0]) });
  await until(() => model.pendingFile('src/solver.jl')?.hunks.length === solver.hunks.length - 1);
  const line = fs.readFileSync(file('src/solver.jl').fsPath, 'utf8').split('\n').findIndex((l) => l.includes('alpha * step'));
  const thread = api.comments.controller.createCommentThread(file('src/solver.jl'), new vscode.Range(line, 0, line, 0), []);
  await vscode.commands.executeCommand('secondLook.comment.create', { thread, text: 'Why a fixed schedule? Could this adapt to the residual norm instead?' });
  const out = execFileSync(cli, ['list'], { cwd: repo, encoding: 'utf8' });
  const id = /^(c\d+)/m.exec(out)[1];
  execFileSync(cli, ['reply', id, '--as', 'Claude', 'The fixed schedule is what the paper uses; an adaptive one is easy to add. Shall I make it a keyword option?'], { cwd: repo });
  await until(() => thread.comments.length === 2);
  const acceptedGroup = (await api.tree.getChildren()).find((n) => n.group === 'accepted');
  await api.view.reveal(acceptedGroup, { expand: 2, select: false });
  await vscode.commands.executeCommand('secondLook.openChange', { root: repo, path: 'src/solver.jl', group: 'pending', line: line - 2 });
  await sleep(1500);
  await scene(2);

  // the file itself, with Accept and Reject above each change
  const doc = await vscode.workspace.openTextDocument(file('src/solver.jl'));
  await vscode.window.showTextDocument(doc, { preview: false });
  await sleep(1500);
  await scene(3);

  // the agent's view of the comments
  fs.writeFileSync(path.join(tmp, 'cli-output.txt'), execFileSync(cli, ['list', '--peek'], { cwd: repo, encoding: 'utf8' }));
};
