import * as path from 'node:path';
import * as vscode from 'vscode';

/** Documents with the checklist's or the base's version of a file, for the left side of diffs. */
export const CONTENT_SCHEME = 'git-review';
/** Resource URIs of tree items, so they get file icons and our badges but not git's decorations. */
export const ITEM_SCHEME = 'git-review-item';

export type Side = 'checklist' | 'base' | 'empty';

export function contentUri(root: string, rel: string, side: Side): vscode.Uri {
  return vscode.Uri.from({ scheme: CONTENT_SCHEME, path: '/' + rel, query: JSON.stringify({ root, side }) });
}

export function parseContentUri(uri: vscode.Uri): { root: string; rel: string; side: Side } {
  const q = JSON.parse(uri.query) as { root: string; side: Side };
  return { root: q.root, rel: uri.path.slice(1), side: q.side };
}

export function itemUri(rel: string, status: string, group: string): vscode.Uri {
  return vscode.Uri.from({ scheme: ITEM_SCHEME, path: '/' + rel, query: `${group}:${status}` });
}

export function fileUri(root: string, rel: string): vscode.Uri {
  return vscode.Uri.file(path.join(root, ...rel.split('/')));
}
