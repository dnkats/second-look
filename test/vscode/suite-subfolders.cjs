// Integration tests with a folder open that is not a repository itself but
// has repositories in its subfolders: Second Look finds them as Source
// Control does, also one created after the window opened.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { until, suite } = require('./helpers.cjs');

const folder = process.env.GRV_TEST_REPO;

exports.run = async function run() {
  const { test, done } = suite();
  const api = await vscode.extensions.getExtension('dnkats.second-look').activate();
  // git reports roots with symbolic links resolved, as macOS has for the temporary folder
  const root = (name) => fs.realpathSync(path.join(folder, name));
  const roots = () => api.manager.models.map((m) => m.repo.root).sort();

  await test('the repositories in the subfolders are found', async () => {
    await until('both repositories', () => api.manager.models.length === 2 && api.manager.models.every((m) => m.state === 'off'));
    assert.deepEqual(roots(), [root('one'), root('two')]);
    assert.deepEqual(api.repos.getChildren().map((e) => e.model.name), ['one', 'two']);
    // Changes stays empty until a repository is chosen
    assert.deepEqual(await api.tree.getChildren(), []);
  });

  await test('Start Review starts the review in that repository only', async () => {
    const one = api.manager.byRoot(root('one'));
    const two = api.manager.byRoot(root('two'));
    await vscode.commands.executeCommand('secondLook.start', one.repo.root);
    await until('the review', () => one.state === 'changes');
    assert.deepEqual(one.pending.map((f) => `${f.status} ${f.path}`), ['M a.txt', 'A b.txt', 'D c.txt']);
    assert.equal(two.state, 'off');
  });

  await test('a repository created after the window opened is found', async () => {
    const three = path.join(folder, 'three');
    fs.mkdirSync(three);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: three });
    await until('the new repository', () => api.manager.models.length === 3, 30000);
    assert.ok(roots().includes(root('three')));
  });

  await test('Refresh keeps each repository once, with its model', async () => {
    const before = api.manager.models.slice();
    await vscode.commands.executeCommand('secondLook.refresh');
    assert.equal(api.manager.models.length, 3);
    assert.ok(api.manager.models.every((m) => before.includes(m)));
  });

  await test('with more than three repositories, those with nothing to do are under Other repositories', async () => {
    const four = path.join(folder, 'four');
    fs.mkdirSync(four);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: four });
    await until('the fourth repository', () => api.manager.models.length === 4 && api.manager.models.every((m) => m.state !== 'loading'), 30000);
    const name = (n) => (n.kind === 'repo' ? path.basename(n.model.repo.root) : n.kind);
    const top = await api.tree.getChildren();
    assert.deepEqual(top.map(name), ['one', 'others']);
    const others = top[1];
    assert.equal(api.tree.getTreeItem(others).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.equal(api.tree.getTreeItem(others).description, '3 not started');
    const inside = await api.tree.getChildren(others);
    assert.deepEqual(inside.map(name).sort(), ['four', 'three', 'two']);
    assert.ok(inside.every((n) => api.tree.getParent(n).kind === 'others'));
    const start = (await api.tree.getChildren(inside[0]))[0];
    assert.equal(start.label, 'Start Review');
    assert.equal(api.tree.getParent(start).other, true);
  });

  await test('a repository whose review starts leaves Other repositories', async () => {
    const two = api.manager.byRoot(root('two'));
    await vscode.commands.executeCommand('secondLook.start', two.repo.root);
    await until('the review', () => two.state === 'changes');
    const top = await api.tree.getChildren();
    assert.deepEqual(top.map((n) => (n.kind === 'repo' ? path.basename(n.model.repo.root) : n.kind)).sort(), ['one', 'others', 'two']);
    const item = api.tree.getTreeItem(top.find((n) => n.kind === 'repo' && n.model === two));
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.equal(item.id, two.repo.root);
    assert.equal(api.tree.getTreeItem(top.find((n) => n.kind === 'others')).description, '2 not started');
  });

  await test('choosing a repository in the Repositories view shows only its review', async () => {
    const entries = api.repos.getChildren();
    assert.deepEqual(entries.map((e) => e.model.name), ['four', 'one', 'three', 'two']);
    const one = api.manager.byRoot(root('one'));
    await api.reposView.reveal(entries.find((e) => e.model === one), { select: true, focus: false });
    await until('the selection', () => api.manager.selected === one);
    const top = await api.tree.getChildren();
    assert.deepEqual(top.map((n) => n.kind), ['group']);
    assert.equal(api.view.description, 'one');
  });

  await test('choosing another repository switches the review to it', async () => {
    const two = api.manager.byRoot(root('two'));
    await api.reposView.reveal(api.repos.getChildren().find((e) => e.model === two), { select: true, focus: false });
    await until('the selection', () => api.manager.selected === two);
    assert.equal(api.view.description, 'two');
    assert.deepEqual((await api.tree.getChildren()).map((n) => n.kind), ['group']);
  });

  done();
};
