// Integration tests with Second Look's proposed API allowed, as with
// "enable-proposed-api" in argv.json: review diffs have Accept Block in the
// gutter, so they go without the Accept and Reject links.
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { until, suite } = require('./helpers.cjs');

const repo = process.env.GRV_TEST_REPO;

exports.run = async function run() {
  const { test, done } = suite();
  const api = await vscode.extensions.getExtension('dnkats.second-look').activate();
  await until('the repository model', () => api.manager.models.find((m) => m.state === 'changes'));
  const a = vscode.Uri.file(path.join(repo, 'a.txt'));
  const lenses = async () => (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', a)) ?? [];

  await test('the extension knows the diff gutter has Accept Block', async () => {
    assert.equal(api.lenses.gutterButtons, true);
  });

  await test('a file shown only in its review diff gets no links; in the editor it does', async () => {
    await vscode.commands.executeCommand('secondLook.openChange', { root: repo, path: 'a.txt', group: 'pending' });
    await until('the review diff', () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
    assert.equal((await lenses()).length, 0);
    await vscode.window.showTextDocument(a);
    await until('the links in the editor', async () => (await lenses()).length === 4);
  });

  done();
};
