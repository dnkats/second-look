import * as vscode from 'vscode';
import { hunkKey } from '../engine';
import { Manager } from './model';
import { Target } from './tree';
import { CONTENT_SCHEME } from './uris';

/** Where the editor groups show the document: in an ordinary editor, a review diff, or another diff (git's, say). */
function placesOf(doc: vscode.TextDocument): { plain: boolean; reviewDiff: boolean; otherDiff: boolean } {
  const uri = doc.uri.toString();
  const at = { plain: false, reviewDiff: false, otherDiff: false };
  for (const g of vscode.window.tabGroups.all) {
    const input = g.activeTab?.input;
    if (input instanceof vscode.TabInputText && input.uri.toString() === uri) {
      at.plain = true;
    } else if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === uri) {
      if (input.original.scheme === CONTENT_SCHEME) {
        at.reviewDiff = true;
      } else {
        at.otherDiff = true;
      }
    }
  }
  return at;
}

/**
 * "Accept" and "Reject" above every change still to review, in the file's
 * editor, and in review diffs unless their gutter has the Accept Block
 * buttons. Other diffs of the file, such as git's, compare something else and
 * get none.
 */
export class ReviewLenses implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(
    private readonly manager: Manager,
    /** Whether review diffs have Accept Block in their gutter. */
    public gutterButtons = false,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!vscode.workspace.getConfiguration('secondLook').get<boolean>('codeLens', true)) {
      return [];
    }
    const m = this.manager.modelFor(doc.uri);
    const rel = m?.repo.rel(doc.uri.fsPath);
    if (!m?.review || !rel || m.state === 'terminal') {
      return [];
    }
    if (!m.pendingFile(rel) && !doc.isDirty) {
      return [];
    }
    // next to the gutter buttons the links would only add empty lines to the diff
    const at = placesOf(doc);
    if (!at.plain && (this.gutterButtons || (at.otherDiff && !at.reviewDiff))) {
      return [];
    }
    const texts = await m.review.pendingTexts(rel, doc.isDirty ? doc.getText() : undefined);
    const below = vscode.workspace.getConfiguration('secondLook').get<number>('codeLensBelow', 10);
    const last = Math.max(doc.lineCount - 1, 0);
    const lenses: vscode.CodeLens[] = [];
    const pair = (line: number, target: Target, suffix: string) => {
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(new vscode.CodeLens(range, { title: `$(check) Accept${suffix}`, tooltip: 'Accept this change: mark it reviewed', command: 'secondLook.accept', arguments: [target] }));
      lenses.push(new vscode.CodeLens(range, { title: `$(close) Reject${suffix}`, tooltip: 'Reject this change: put back the reviewed text', command: 'secondLook.reject', arguments: [target] }));
    };
    for (const h of texts.hunks) {
      const target: Target = { root: m.repo.root, path: rel, group: 'pending', key: hunkKey(h), line: h.newStart };
      pair(Math.min(h.newStart, last), target, '');
      if (below > 0 && h.newCount >= below) {
        // a lens sits above its line: the line after a long change puts the pair right below it
        const after = h.newStart + h.newCount;
        pair(after <= last ? after : h.newStart + h.newCount - 1, target, ' above');
      }
    }
    return lenses;
  }
}
