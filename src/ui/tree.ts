import * as path from 'node:path';
import * as vscode from 'vscode';
import { Hunk, HunkKey, hunkKey } from '../engine';
import { describeBase } from './describe';
import { FileItem, Manager, RepoModel } from './model';
import { itemUri } from './uris';

export type Group = 'pending' | 'accepted';

/** What commands act on: a file, or one change in it. */
export interface Target {
  root: string;
  path: string;
  group: Group;
  status?: string;
  key?: HunkKey;
  /** 0-based line where the change starts, in the file's new side. */
  line?: number;
}

export type Node =
  | { kind: 'group'; model: RepoModel; group: Group }
  | { kind: 'file'; model: RepoModel; group: Group; file: FileItem }
  | { kind: 'hunk'; model: RepoModel; group: Group; file: FileItem; hunk: Hunk; target: Target }
  | { kind: 'message'; model: RepoModel; label: string; command?: vscode.Command; icon?: string };

export function fileTarget(n: Node): Target | undefined {
  if (n.kind === 'file') {
    return { root: n.model.repo.root, path: n.file.path, group: n.group, status: n.file.status };
  }
  if (n.kind === 'hunk') {
    return n.target;
  }
  return undefined;
}

function firstText(lines: string[]): string {
  for (const l of lines) {
    const t = l.trim();
    if (t) {
      return t.length > 70 ? t.slice(0, 69) + '…' : t;
    }
  }
  return lines.length > 0 ? '(blank lines)' : '';
}

function hunkLabel(h: Hunk): { label: string; description: string } {
  const added = h.newLines.length;
  const removed = h.oldLines.length;
  let where: string;
  if (h.newCount === 0) {
    where = `removed at line ${h.newStart + 1}`;
  } else if (h.newCount === 1) {
    where = `line ${h.newStart + 1}`;
  } else {
    where = `lines ${h.newStart + 1}–${h.newStart + h.newCount}`;
  }
  const counts = [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter((x) => x).join(' ');
  return { label: firstText(h.newLines.length > 0 ? h.newLines : h.oldLines), description: `${where}  ${counts}` };
}

function hunkTooltip(h: Hunk): vscode.MarkdownString {
  const out: string[] = [];
  const cut = (ls: string[], sign: string) => {
    for (const l of ls.slice(0, 20)) {
      out.push(sign + l.replace(/\r?\n$/, ''));
    }
    if (ls.length > 20) {
      out.push(`${sign}… ${ls.length - 20} more`);
    }
  };
  cut(h.oldLines, '-');
  cut(h.newLines, '+');
  const md = new vscode.MarkdownString();
  md.appendCodeblock(out.join('\n'), 'diff');
  return md;
}

export class ReviewTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly manager: Manager) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) {
      // one repository at a time: the only one, or the one chosen in the Repositories view
      const m = this.manager.paused ? undefined : this.manager.shown[0];
      return m ? this.repoChildren(m) : [];
    }
    switch (n.kind) {
      case 'group': {
        const files = n.group === 'pending' ? n.model.pending : n.model.accepted;
        return files.map((file) => ({ kind: 'file', model: n.model, group: n.group, file }));
      }
      case 'file': {
        let hunks = n.file.hunks;
        if (n.group === 'accepted') {
          hunks = (await n.model.acceptedTexts(n.file.path))?.hunks ?? [];
        }
        return hunks.map((hunk) => ({
          kind: 'hunk',
          model: n.model,
          group: n.group,
          file: n.file,
          hunk,
          target: { root: n.model.repo.root, path: n.file.path, group: n.group, key: hunkKey(hunk), line: hunk.newStart },
        }));
      }
      default:
        return [];
    }
  }

  private repoChildren(m: RepoModel): Node[] {
    const out: Node[] = [];
    if (m.state === 'error') {
      out.push({ kind: 'message', model: m, label: m.error ?? 'Something went wrong', icon: 'error' });
    }
    if (m.pending.length > 0) {
      out.push({ kind: 'group', model: m, group: 'pending' });
    }
    if (m.accepted.length > 0) {
      out.push({ kind: 'group', model: m, group: 'accepted' });
    }
    return out;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'group': {
        const pending = n.group === 'pending';
        const files = pending ? n.model.pending : n.model.accepted;
        const item = new vscode.TreeItem(pending ? 'To review' : 'Accepted', pending ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${n.model.repo.root}#${n.group}`;
        item.description = pending ? `${n.model.pendingHunkCount} in ${files.length} file${files.length === 1 ? '' : 's'}` : `${files.length} file${files.length === 1 ? '' : 's'}`;
        item.iconPath = new vscode.ThemeIcon(pending ? 'circle-large-outline' : 'pass');
        item.contextValue = pending ? 'pendingGroup' : 'acceptedGroup';
        return item;
      }
      case 'file': {
        const f = n.file;
        const dir = path.posix.dirname(f.path);
        const hasChildren = n.group === 'accepted' ? !f.binary : f.hunks.length > 0;
        const item = new vscode.TreeItem(path.posix.basename(f.path), hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `${n.model.repo.root}#${n.group}#${f.path}`;
        item.resourceUri = itemUri(f.path, f.status, n.group);
        const parts: string[] = [];
        if (dir !== '.') {
          parts.push(dir);
        }
        if (n.group === 'pending') {
          if (f.binary) {
            parts.push('binary');
          } else if (f.hunks.length === 0 && f.status === 'M') {
            parts.push('file mode');
          } else if (f.hunks.length > 1) {
            parts.push(`${f.hunks.length} changes`);
          }
        }
        item.description = parts.join(' · ');
        item.tooltip = `${f.path}\n${statusWords(f.status)}`;
        item.contextValue = n.group === 'pending' ? 'pendingFile' : 'acceptedFile';
        item.command = {
          command: n.group === 'pending' ? 'secondLook.openChange' : 'secondLook.openAccepted',
          title: 'Open',
          arguments: [fileTarget(n)],
        };
        return item;
      }
      case 'hunk': {
        const { label, description } = hunkLabel(n.hunk);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = `${n.model.repo.root}#${n.group}#${n.file.path}#${n.target.key?.hash}#${n.hunk.newStart}`;
        item.description = description;
        item.tooltip = hunkTooltip(n.hunk);
        let icon = 'diff-modified';
        if (n.hunk.oldCount === 0) {
          icon = 'diff-added';
        } else if (n.hunk.newCount === 0) {
          icon = 'diff-removed';
        }
        item.iconPath = new vscode.ThemeIcon(icon);
        item.contextValue = n.group === 'pending' ? 'pendingHunk' : 'acceptedHunk';
        item.command = {
          command: n.group === 'pending' ? 'secondLook.openChange' : 'secondLook.openAccepted',
          title: 'Open',
          arguments: [n.target],
        };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = n.icon ? new vscode.ThemeIcon(n.icon) : undefined;
        item.command = n.command;
        return item;
      }
    }
  }

  getParent(n: Node): Node | undefined {
    switch (n.kind) {
      case 'hunk':
        return { kind: 'file', model: n.model, group: n.group, file: n.file };
      case 'file':
        return { kind: 'group', model: n.model, group: n.group };
      default:
        return undefined;
    }
  }
}

function statusWords(s: string): string {
  switch (s) {
    case 'A':
      return 'new file';
    case 'D':
      return 'deleted';
    case 'T':
      return 'type changed';
    default:
      return 'modified';
  }
}

export function repoDescription(m: RepoModel): string {
  switch (m.state) {
    case 'changes':
      return `${describeBase(m)} · ${m.pendingHunkCount} to review`;
    case 'reviewed':
      return 'Everything reviewed. Finish to record it.';
    case 'off':
      return 'Not reviewed with Second Look yet';
    case 'clean':
      return 'Nothing to review';
    case 'detached':
      return 'Check out a branch to review';
    case 'terminal':
      return 'A terminal review is open here';
    case 'error':
      return m.error ?? 'error';
    default:
      return 'Looking for changes…';
  }
}
