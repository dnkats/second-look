import * as vscode from 'vscode';
import { hunkKey } from '../engine';
import { Manager } from './model';
import { Target } from './tree';

/** "Accept" and "Reject" above every change still to review, in the file's editor. */
export class ReviewLenses implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly manager: Manager) {}

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
