import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CommentsUI } from './comments/controller';
import { installSkill, refreshSkills, skillInstalled } from './skill';
import { ReviewLenses } from './ui/codelens';
import { Commands } from './ui/commands';
import { ContentProvider } from './ui/content';
import { ItemDecorations } from './ui/decorations';
import { describeBase } from './ui/describe';
import { Highlights } from './ui/highlights';
import { Manager, RepoModel } from './ui/model';
import { ReviewTree, repoDescription } from './ui/tree';
import { CONTENT_SCHEME } from './ui/uris';

export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  const manager = new Manager((m: RepoModel) => ({
    onReject: (info) => CommentsUI.recordRejection(m, info),
    onUnreject: (id) => CommentsUI.forgetRejection(m, id),
  }));
  context.subscriptions.push(manager);

  const content = new ContentProvider(manager);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, content));
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(new ItemDecorations()));

  const tree = new ReviewTree(manager);
  const view = vscode.window.createTreeView('secondLook.view', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(view);

  const log = vscode.window.createOutputChannel('Second Look', { log: true });
  context.subscriptions.push(log);
  // VS Code shows the Accept Block buttons in review diffs only where it allows the proposed API. A local
  // extension host is told so, a remote one (SSH) is not: there the first click on one of them tells it,
  // remembered per VS Code version in case the runtime argument goes away.
  const proposals = (context.extension.packageJSON.enabledApiProposals as string[] | undefined) ?? [];
  const seenKey = `acceptBlockSeen@${vscode.version}`;
  const allowed = proposals.includes('contribDiffEditorGutterToolBarMenus');
  const lenses = new ReviewLenses(manager, allowed || context.globalState.get<boolean>(seenKey, false));
  const where = vscode.env.remoteName ? `, ${vscode.env.remoteName}` : '';
  let how = 'unknown until it is first used';
  if (allowed) {
    how = 'allowed';
  } else if (lenses.gutterButtons) {
    how = 'used before';
  }
  log.info(`Second Look ${context.extension.packageJSON.version} in VS Code ${vscode.version}${where}; Accept Block in review diffs: ${how}`);
  const gutterButtonUsed = async () => {
    if (!lenses.gutterButtons) {
      lenses.gutterButtons = true;
      lenses.refresh();
      await context.globalState.update(seenKey, true);
      log.info('A gutter button was used, so review diffs have them');
    }
  };
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lenses));
  const highlights = new Highlights(manager);
  context.subscriptions.push(highlights);

  const status = vscode.window.createStatusBarItem('secondLook.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'Second Look';
  status.command = 'secondLook.view.focus';
  context.subscriptions.push(status);

  new Commands(manager, gutterButtonUsed).register(context);
  const comments = new CommentsUI(manager, () => void offerSkill(context));
  comments.register(context);
  context.subscriptions.push(comments);
  context.subscriptions.push(vscode.commands.registerCommand('secondLook.installSkill', () => installSkill(context)));

  const update = () => {
    tree.refresh();
    content.refreshAll();
    lenses.refresh();
    highlights.schedule();
    const models = manager.models;
    view.message = models.length === 1 && (models[0].state === 'changes' || models[0].state === 'reviewed') ? header(models[0]) : undefined;
    const hunks = models.reduce((n, m) => n + m.pendingHunkCount, 0);
    view.badge = hunks > 0 ? { value: hunks, tooltip: `${hunks} change${hunks === 1 ? '' : 's'} to review` } : undefined;
    const showStatus = vscode.workspace.getConfiguration('secondLook').get<boolean>('statusBar', true);
    if (hunks > 0 && showStatus) {
      const files = models.reduce((n, m) => n + m.pending.length, 0);
      status.text = `$(checklist) ${hunks}`;
      status.tooltip = `${hunks} change${hunks === 1 ? '' : 's'} to review in ${files} file${files === 1 ? '' : 's'}`;
      status.show();
    } else {
      status.hide();
    }
    void setContexts(manager);
    void comments.sync();
  };
  context.subscriptions.push(manager.onDidChange(update));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => void setContexts(manager)));
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      void setContexts(manager);
      highlights.schedule();
      // which links show depends on where the file is open
      lenses.refresh();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('secondLook')) {
        update();
      }
    }),
  );

  void refreshSkills(context);
  // a .vsix does not keep the executable bit; VS Code's chat runs the skill from here
  void fs.chmod(path.join(context.extensionPath, 'skill', 'review-comments', 'scripts', 'review-comments'), 0o755).catch(() => undefined);
  await vscode.commands.executeCommand('setContext', 'secondLook.state', 'loading');
  await manager.discover();
  update();
  // for the integration tests
  return { manager, comments, tree, view, lenses };
}

function header(m: RepoModel): string {
  if (m.state === 'reviewed') {
    return repoDescription(m);
  }
  const files = m.pending.length;
  return `${describeBase(m)}. ${m.pendingHunkCount} to review in ${files} file${files === 1 ? '' : 's'}.`;
}

async function setContexts(manager: Manager): Promise<void> {
  const models = manager.models;
  let state: string;
  if (models.length === 0) {
    state = 'noRepo';
  } else if (models.length > 1) {
    state = 'multi';
  } else {
    state = models[0].state;
  }
  const set = (k: string, v: unknown) => vscode.commands.executeCommand('setContext', k, v);
  await set('secondLook.state', state);
  await set('secondLook.hasPending', models.some((m) => m.pending.length > 0));
  await set('secondLook.hasReview', models.some((m) => m.pending.length > 0 || m.accepted.length > 0));
  await set('secondLook.canUndo', models.some((m) => m.undoLabel !== undefined));
  const ed = vscode.window.activeTextEditor;
  const m = ed ? manager.modelFor(ed.document.uri) : undefined;
  const rel = m && ed ? m.repo.rel(ed.document.uri.fsPath) : undefined;
  await set('secondLook.activeFileHasPending', !!(m && rel && m.pendingFile(rel)));
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const reviewDiff = tab?.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === CONTENT_SCHEME;
  await set('secondLook.activeIsReviewDiff', reviewDiff);
}

async function offerSkill(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get('skillOffered') || (await skillInstalled())) {
    return;
  }
  await context.globalState.update('skillOffered', true);
  const choice = await vscode.window.showInformationMessage(
    'Your agent can read and answer these comments when you ask it to "check my comments". Install the skill that teaches it how?',
    'Install Skill',
    'Not Now',
  );
  if (choice === 'Install Skill') {
    await installSkill(context);
  }
}

export function deactivate(): void {}
