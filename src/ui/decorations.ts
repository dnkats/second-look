import * as vscode from 'vscode';
import { ITEM_SCHEME } from './uris';

const COLORS: Record<string, string> = {
  A: 'gitDecoration.addedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  M: 'gitDecoration.modifiedResourceForeground',
  T: 'gitDecoration.modifiedResourceForeground',
};

/** Letter badges for files in the review view: A new, M modified, D deleted. */
export class ItemDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== ITEM_SCHEME) {
      return undefined;
    }
    const [group, status] = uri.query.split(':');
    if (group === 'accepted') {
      return new vscode.FileDecoration(status, 'accepted', new vscode.ThemeColor('descriptionForeground'));
    }
    return new vscode.FileDecoration(status, undefined, new vscode.ThemeColor(COLORS[status] ?? COLORS.M));
  }
}
