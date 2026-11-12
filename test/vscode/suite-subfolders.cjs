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
    // without a choice yet, Changes shows the first as Repositories lists them
    await until('the default choice', () => api.manager.selected?.name === 'one');
    assert.deepEqual(api.manager.shown.map((m) => m.name), ['one']);
    assert.equal(api.view.description, 'one');
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

  await test('choosing a repository in the Repositories view shows only its review', async () => {
    const entries = api.repos.getChildren();
    assert.deepEqual(entries.map((e) => e.model.name), ['one', 'three', 'two']);
    const one = api.manager.byRoot(root('one'));
    await api.reposView.reveal(entries.find((e) => e.model === one), { select: true, focus: false });
    await until('the selection', () => api.manager.selected === one);
    const top = await api.tree.getChildren();
    assert.deepEqual(top.map((n) => n.kind), ['group']);
    assert.equal(api.view.description, 'one');
  });

  await test('choosing another repository switches the review to it', async () => {
    const two = api.manager.byRoot(root('two'));
    await vscode.commands.executeCommand('secondLook.start', two.repo.root);
    await until('the review', () => two.state === 'changes');
    await api.reposView.reveal(api.repos.getChildren().find((e) => e.model === two), { select: true, focus: false });
    await until('the selection', () => api.manager.selected === two);
    assert.equal(api.view.description, 'two');
    assert.deepEqual((await api.tree.getChildren()).map((n) => n.kind), ['group']);
  });

  await test('the choice holds through Refresh and is remembered for the window', async () => {
    const two = api.manager.byRoot(root('two'));
    await vscode.commands.executeCommand('secondLook.refresh');
    assert.equal(api.manager.selected, two);
    assert.equal(api.workspaceState.get('repository'), two.repo.root);
  });

  done();
};
