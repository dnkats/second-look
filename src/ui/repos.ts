import * as path from 'node:path';
import * as vscode from 'vscode';
import { Manager, RepoModel } from './model';
import { repoDescription } from './tree';

export type RepoEntry = { kind: 'repo'; model: RepoModel };

/**
 * The Repositories view above the review, as in Source Control, when the workspace has more than one
 * repository: choosing one shows only its review below, choosing another switches to that one.
 */
export class ReposTree implements vscode.TreeDataProvider<RepoEntry> {
  private readonly emitter = new vscode.EventEmitter<RepoEntry | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly manager: Manager) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(e?: RepoEntry): RepoEntry[] {
    if (e || this.manager.models.length < 2) {
      return [];
    }
    const repos = [...this.manager.models].sort(
      (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.repo.root.localeCompare(b.repo.root),
    );
    return repos.map((model): RepoEntry => ({ kind: 'repo', model }));
  }

  getTreeItem(e: RepoEntry): vscode.TreeItem {
    const m = e.model;
    const item = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None);
    item.id = m.repo.root;
    item.description = [where(m), m.branch, shortState(m)].filter((x) => x).join(' · ');
    item.tooltip = `${m.repo.root}\n${repoDescription(m)}`;
    item.iconPath = new vscode.ThemeIcon('repo');
    item.contextValue = 'repo';
    return item;
  }

  getParent(): undefined {
    return undefined;
  }
}

/** For a repository deeper than one level in its workspace folder, the folder it is in, telling apart two of the same name. */
function where(m: RepoModel): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(m.repo.root));
  if (!folder) {
    return '';
  }
  const rel = path.relative(folder.uri.fsPath, path.dirname(m.repo.root));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : '';
}

function shortState(m: RepoModel): string {
  switch (m.state) {
    case 'changes':
      return `${m.pendingHunkCount} to review`;
    case 'reviewed':
      return 'reviewed';
    case 'off':
      return 'not started';
    case 'clean':
      return 'nothing to review';
    case 'detached':
      return 'detached';
    case 'terminal':
      return 'terminal review';
    case 'error':
      return 'error';
    default:
      return '…';
  }
}
