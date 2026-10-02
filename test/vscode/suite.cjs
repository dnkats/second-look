// Integration tests, run inside VS Code's extension host by test/vscode/run.mjs.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { until, suite } = require('./helpers.cjs');

const repo = process.env.GRV_TEST_REPO;
const root = process.env.GRV_ROOT;
const { hunkKey } = require(path.join(root, 'dist/test/engine.cjs'));
const cli = path.join(root, 'skill/review-comments/scripts/review-comments');

exports.run = async function run() {
  const { test, done } = suite();
  const ext = vscode.extensions.getExtension('dnkats.second-look');
  const api = await ext.activate();
  const model = await until('the repository model', () => api.manager.models.find((m) => m.state === 'changes'));
  const file = (rel) => vscode.Uri.file(path.join(repo, rel));

  await test('without the proposed API, the extension assumes no Accept Block', async () => {
    assert.equal(api.lenses.gutterButtons, false);
  });

  await test('the view lists the agent\'s changes', async () => {
    assert.deepEqual(model.pending.map((f) => `${f.status} ${f.path}`), ['M a.txt', 'A b.txt', 'D c.txt']);
    assert.equal(model.pending[0].hunks.length, 2);
    assert.equal(model.reviewState.kind, 'branchStart');
    const top = await api.tree.getChildren();
    assert.deepEqual(top.map((n) => n.kind), ['group']);
    const files = await api.tree.getChildren(top[0]);
    const item = api.tree.getTreeItem(files[0]);
    assert.equal(item.label, 'a.txt');
    assert.equal(item.description, '2 changes');
    const hunks = await api.tree.getChildren(files[0]);
    assert.equal(api.tree.getTreeItem(hunks[0]).label, 'three');
  });

  await test('lenses offer Accept and Reject for each change', async () => {
    const doc = await vscode.workspace.openTextDocument(file('a.txt'));
    await vscode.window.showTextDocument(doc);
    const lenses = await until('lenses', async () => {
      const l = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
      return l && l.length === 4 ? l : undefined;
    });
    assert.deepEqual(lenses.map((l) => l.command.title), ['$(check) Accept', '$(close) Reject', '$(check) Accept', '$(close) Reject']);
    assert.equal(lenses[0].range.start.line, 2);
  });

  await test('accepting a change moves it to Accepted and leaves git alone', async () => {
    const [h1] = model.pending[0].hunks;
    await vscode.commands.executeCommand('secondLook.accept', { root: repo, path: 'a.txt', group: 'pending', key: hunkKey(h1), line: h1.newStart });
    await until('one hunk left', () => model.pendingFile('a.txt')?.hunks.length === 1);
    assert.deepEqual(model.accepted.map((f) => f.path), ['a.txt']);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '');
  });

  await test('the review diff shows the accepted text on the left', async () => {
    await vscode.commands.executeCommand('secondLook.openChange', { root: repo, path: 'a.txt', group: 'pending' });
    const tab = await until('a diff tab', () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.input instanceof vscode.TabInputTextDiff ? t : undefined;
    });
    assert.equal(tab.input.original.scheme, 'second-look');
    assert.equal(tab.input.modified.fsPath, file('a.txt').fsPath);
    const left = await vscode.workspace.openTextDocument(tab.input.original);
    assert.match(left.getText(), /^line 1\nline 2\nthree\n/);
    assert.doesNotMatch(left.getText(), /twenty-five/);
  });

  await test('reject at the cursor puts the reviewed text back; undo brings the change back', async () => {
    const ed = await until('the diff editor', () => vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file('a.txt').fsPath));
    await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false });
    const active = vscode.window.activeTextEditor;
    active.selection = new vscode.Selection(24, 0, 24, 0);
    await vscode.commands.executeCommand('secondLook.rejectAtCursor');
    await until('the change is gone', () => !model.pendingFile('a.txt'));
    assert.match(fs.readFileSync(file('a.txt').fsPath, 'utf8'), /line 25\n/);
    await vscode.commands.executeCommand('secondLook.undo', repo);
    await until('the change is back', () => model.pendingFile('a.txt')?.hunks.length === 1);
    assert.match(fs.readFileSync(file('a.txt').fsPath, 'utf8'), /twenty-five/);
  });

  await test('a comment reaches the agent tool, and its reply shows in the thread', async () => {
    const thread = api.comments.controller.createCommentThread(file('a.txt'), new vscode.Range(9, 0, 9, 0), []);
    await vscode.commands.executeCommand('secondLook.comment.create', { thread, text: 'why ten?' });
    const out = execFileSync(cli, ['list'], { cwd: repo, encoding: 'utf8' });
    const id = /^(c\d+)  a\.txt:10$/m.exec(out)?.[1];
    assert.ok(id, out);
    assert.match(out, /10 \| line 10/);
    assert.match(out, /Test User: why ten\?/);
    execFileSync(cli, ['reply', id, '--as', 'Claude', 'Because it is the tenth line.'], { cwd: repo });
    await until('the reply in the thread', () => thread.comments.length === 2 && thread.comments[1].author.name === 'Claude');
    assert.equal(thread.label, 'The agent replied');
  });

  await test('rejections are told to the agent once', async () => {
    const t = model.pendingFile('a.txt');
    await vscode.commands.executeCommand('secondLook.reject', { root: repo, path: 'a.txt', group: 'pending', key: hunkKey(t.hunks[0]) });
    await until('the change is gone', () => !model.pendingFile('a.txt'));
    const out = execFileSync(cli, ['list'], { cwd: repo, encoding: 'utf8' });
    assert.match(out, /rejected in review/);
    assert.match(out, /- twenty-five/);
    assert.doesNotMatch(execFileSync(cli, ['list'], { cwd: repo, encoding: 'utf8' }), /rejected in review/);
  });

  await test('accept all and finish records the review', async () => {
    await vscode.commands.executeCommand('secondLook.acceptAll', repo);
    await until('nothing pending', () => model.state === 'reviewed');
    // the reject left an uncommitted edit; commit it without asking
    await vscode.workspace.getConfiguration('secondLook').update('finish.commitEdits', 'always', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('secondLook.finish', repo);
    await until('a clean state', () => model.state === 'clean');
    const log = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(log, 'Review edits on feature');
    const reviewed = execFileSync('git', ['rev-parse', 'refs/reviewed/feature', 'HEAD'], { cwd: repo, encoding: 'utf8' }).split('\n');
    assert.equal(reviewed[0], reviewed[1]);
  });

  await test('a new agent edit shows up for review', async () => {
    fs.appendFileSync(file('b.txt').fsPath, 'agent again\n');
    await until('b.txt pending', () => model.pendingFile('b.txt')?.hunks.length === 1, 20000);
    assert.equal(model.reviewState.kind, 'lastReview');
  });

  await test('the Accept Block button in the diff gutter accepts that block, and tells that diffs have it', async () => {
    const { contentUri } = { contentUri: (rel) => vscode.Uri.from({ scheme: 'second-look', path: '/' + rel, query: JSON.stringify({ root: repo, side: 'checklist' }) }) };
    const original = contentUri('b.txt');
    const left = (await vscode.workspace.openTextDocument(original)).getText();
    const current = fs.readFileSync(file('b.txt').fsPath, 'utf8');
    assert.notEqual(left, current);
    await vscode.commands.executeCommand('secondLook.acceptBlock', { originalUri: original, modifiedUri: file('b.txt'), originalWithModifiedChanges: current });
    await until('b.txt accepted', () => !model.pendingFile('b.txt'));
    assert.equal(api.lenses.gutterButtons, true);
  });

  await test('a long change gets Accept and Reject below it as well', async () => {
    fs.writeFileSync(file('long.txt').fsPath, Array.from({ length: 12 }, (_, i) => `new ${i + 1}\n`).join(''));
    await until('long.txt pending', () => model.pendingFile('long.txt'));
    const doc = await vscode.workspace.openTextDocument(file('long.txt'));
    await vscode.window.showTextDocument(doc);
    const lenses = await until('four lenses', async () => {
      const l = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri);
      return l && l.length === 4 ? l : undefined;
    });
    assert.deepEqual(lenses.map((l) => [l.range.start.line, l.command.title]), [
      [0, '$(check) Accept'],
      [0, '$(close) Reject'],
      [12, '$(check) Accept above'],
      [12, '$(close) Reject above'],
    ]);
  });

  await test('with openIn set to editor, changes open in the file itself; from a review diff, the next file opens in a diff', async () => {
    const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
    const cfg = vscode.workspace.getConfiguration('secondLook');
    await cfg.update('openIn', 'editor', vscode.ConfigurationTarget.Global);
    try {
      fs.writeFileSync(file('a.txt').fsPath, fs.readFileSync(file('a.txt').fsPath, 'utf8').replace('line 20\n', 'line twenty\n'));
      const [h] = (await until('a.txt pending', () => model.pendingFile('a.txt'))).hunks;
      assert.equal(h.newStart, 19);
      await vscode.commands.executeCommand('secondLook.openChange', { root: repo, path: 'a.txt', group: 'pending', key: hunkKey(h), line: h.newStart });
      await until('a.txt in the editor', () => activeTab()?.input instanceof vscode.TabInputText && activeTab().input.uri.fsPath === file('a.txt').fsPath);
      assert.equal(vscode.window.activeTextEditor.selection.active.line, 19);
      await vscode.commands.executeCommand('secondLook.nextChange');
      await until('long.txt in the editor', () => activeTab()?.input instanceof vscode.TabInputText && activeTab().input.uri.fsPath === file('long.txt').fsPath);

      await vscode.commands.executeCommand('secondLook.reviewThisFile', file('a.txt'));
      const ed = await until('the a.txt diff', () => activeTab()?.input instanceof vscode.TabInputTextDiff && vscode.window.activeTextEditor?.document.uri.fsPath === file('a.txt').fsPath && vscode.window.activeTextEditor);
      ed.selection = new vscode.Selection(19, 0, 19, 0);
      await vscode.commands.executeCommand('secondLook.nextChange');
      await until('long.txt in a diff', () => activeTab()?.input instanceof vscode.TabInputTextDiff && activeTab().input.modified.fsPath === file('long.txt').fsPath);
    } finally {
      await cfg.update('openIn', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  await test('the row buttons open a change the other way: Open File, Open Diff', async () => {
    const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
    const files = await api.tree.getChildren((await api.tree.getChildren())[0]);
    const [hunk] = await api.tree.getChildren(files.find((n) => n.file.path === 'a.txt'));
    await vscode.commands.executeCommand('secondLook.openInEditor', hunk);
    await until('a.txt in the editor', () => activeTab()?.input instanceof vscode.TabInputText && activeTab().input.uri.fsPath === file('a.txt').fsPath);
    assert.equal(vscode.window.activeTextEditor.selection.active.line, 19);
    await vscode.commands.executeCommand('secondLook.openInDiff', hunk);
    await until('the a.txt diff', () => activeTab()?.input instanceof vscode.TabInputTextDiff && activeTab().input.modified.fsPath === file('a.txt').fsPath);
  });

  await test('once Accept Block was used, a review diff gets no links', async () => {
    // the row buttons left a.txt's review diff open
    const t = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === 'second-look');
    assert.equal((await vscode.commands.executeCommand('vscode.executeCodeLensProvider', file('a.txt'))).length, 0);
  });

  await test('the view menu switches VS Code\'s links in diffs, for all extensions', async () => {
    const value = () => vscode.workspace.getConfiguration('diffEditor').get('codeLens');
    assert.equal(value(), true);
    await vscode.commands.executeCommand('secondLook.hideDiffLinks');
    await until('diffEditor.codeLens off', () => value() === false);
    await vscode.commands.executeCommand('secondLook.showDiffLinks');
    await until('diffEditor.codeLens on again', () => value() === true);
    // back to Second Look's default, not a value in the user's settings
    assert.equal(vscode.workspace.getConfiguration('diffEditor').inspect('codeLens').globalValue, undefined);
  });

  await test('a diff comparing something else, such as git\'s, gets no links', async () => {
    const a = file('a.txt');
    const index = vscode.Uri.from({ scheme: 'git', path: a.path, query: JSON.stringify({ path: a.fsPath, ref: '~' }) });
    await vscode.commands.executeCommand('vscode.diff', index, a, 'a.txt (Working Tree)');
    await until('git\'s diff', () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t?.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === 'git';
    });
    assert.equal((await vscode.commands.executeCommand('vscode.executeCodeLensProvider', a)).length, 0);
  });

  done();
};
