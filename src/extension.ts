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
import { ReposTree } from './ui/repos';
import { ReviewTree, repoDescription } from './ui/tree';
import { CONTENT_SCHEME } from './ui/uris';

export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  const manager = new Manager((m: RepoModel) => ({
    onReject: (info) => CommentsUI.recordRejection(m, info),
    onUnreject: (id) => CommentsUI.forgetRejection(m, id),
  }));
  context.subscriptions.push(manager);
  manager.paused = context.workspaceState.get<boolean>('paused', false);

  const content = new ContentProvider(manager);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, content));
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(new ItemDecorations()));

  const tree = new ReviewTree(manager);
  const view = vscode.window.createTreeView('secondLook.view', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(view);
  const repos = new ReposTree(manager);
  const reposView = vscode.window.createTreeView('secondLook.repos', { treeDataProvider: repos });
  manager.preferredRoot = context.workspaceState.get<string>('repository');
  // the Repositories view marks the repository shown below; revealing in a hidden view would open it
  const markChosen = () => {
    const m = manager.selected;
    if (m && reposView.visible && reposView.selection[0]?.model !== m) {
      void Promise.resolve(reposView.reveal({ kind: 'repo', model: m }, { select: true, focus: false })).catch(() => undefined);
    }
  };
  context.subscriptions.push(
    reposView,
    reposView.onDidChangeSelection((e) => {
      const s = e.selection[0];
      if (s) {
        manager.select(s.model);
        void context.workspaceState.update('repository', s.model.repo.root);
      }
    }),
    reposView.onDidChangeVisibility(() => markChosen()),
  );

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

  new Commands(manager, gutterButtonUsed, () => content.refreshAll()).register(context);
  const comments = new CommentsUI(manager, () => void offerSkill(context));
  comments.register(context);
  context.subscriptions.push(comments);
  context.subscriptions.push(vscode.commands.registerCommand('secondLook.installSkill', () => installSkill(context)));
  const setPaused = async (on: boolean) => {
    manager.paused = on;
    await context.workspaceState.update('paused', on);
    update();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('secondLook.pause', () => setPaused(true)),
    vscode.commands.registerCommand('secondLook.resume', () => setPaused(false)),
  );

  const update = () => {
    tree.refresh();
    repos.refresh();
    markChosen();
    content.refreshAll();
    lenses.refresh();
    highlights.schedule();
    // paused, the view shows only how to resume
    const models = manager.paused ? [] : manager.models;
    const shown = manager.paused ? [] : manager.shown;
    view.message = shown.length === 1 && (shown[0].state === 'changes' || shown[0].state === 'reviewed') ? header(shown[0]) : undefined;
    view.description = manager.paused ? undefined : manager.selected?.name;
    // the badge and the status bar count every repository, also while one is selected
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
  return { manager, comments, tree, view, lenses, repos, reposView, workspaceState: context.workspaceState };
}

// no-break spaces keep each key with its word when the line wraps
const keys = ['Alt+F5 next', 'Alt+Y accept', 'Alt+N reject', 'Shift+Alt+F5 back'].map((k) => k.replace(' ', '\u00a0')).join(', ');

function header(m: RepoModel): string {
  if (m.state === 'reviewed') {
    return repoDescription(m);
  }
  const files = m.pending.length;
  // the keys work where the change is, in the editor or the diff; a view message is one paragraph of plain text
  return `${describeBase(m)}. ${m.pendingHunkCount} to review in ${files} file${files === 1 ? '' : 's'}. Keys in the editor: ${keys}.`;
}

async function setContexts(manager: Manager): Promise<void> {
  // the review view and its buttons are about the repository selected in the Repositories view, if any
  const models = manager.shown;
  let state: string;
  if (manager.models.length === 0) {
    state = 'noRepo';
  } else {
    state = models[0].state;
  }
  const set = (k: string, v: unknown) => vscode.commands.executeCommand('setContext', k, v);
  // paused, the buttons, arrows and keys that act on the review are gone
  const live = !manager.paused;
  await set('secondLook.paused', manager.paused);
  await set('secondLook.multiRepo', manager.models.length > 1);
  await set('secondLook.state', state);
  await set('secondLook.canStart', models.some((m) => m.state === 'off'));
  await set('secondLook.hasPending', live && models.some((m) => m.pending.length > 0));
  await set('secondLook.hasReview', live && models.some((m) => m.pending.length > 0 || m.accepted.length > 0));
  await set('secondLook.canUndo', live && models.some((m) => m.undoLabel !== undefined));
  const ed = vscode.window.activeTextEditor;
  const m = ed ? manager.modelFor(ed.document.uri) : undefined;
  const rel = m && ed ? m.repo.rel(ed.document.uri.fsPath) : undefined;
  await set('secondLook.activeFileHasPending', live && !!(m && rel && m.pendingFile(rel)));
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const reviewDiff = tab?.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === CONTENT_SCHEME;
  await set('secondLook.activeIsReviewDiff', live && reviewDiff);
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
