import * as vscode from 'vscode';
import { Manager } from './model';
import { CONTENT_SCHEME, parseContentUri } from './uris';

/** Serves the accepted (checklist) and starting (base) versions of files for the left side of diffs. */
export class ContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly manager: Manager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, rel, side } = parseContentUri(uri);
    const m = this.manager.byRoot(root);
    if (side === 'empty' || !m?.review) {
      return '';
    }
    if (side === 'checklist') {
      return (await m.review.checklistContent(rel)).toString('utf8');
    }
    const state = await m.review.load();
    return state ? (await m.review.baseContent(state, rel)).toString('utf8') : '';
  }

  /** Tells open diffs that the checklist may have changed. */
  refreshAll(): void {
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.scheme === CONTENT_SCHEME) {
        this.emitter.fire(d.uri);
      }
    }
  }
}
