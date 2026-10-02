import * as vscode from 'vscode';
import { Hunk } from '../engine';
import { Manager } from './model';

const HOVER_LINES = 40;

/** The text a change replaced or removed, as a hover for its mark; nothing for a pure addition. */
function replacedText(h: Hunk, languageId: string): vscode.MarkdownString | undefined {
  if (h.oldLines.length === 0) {
    return undefined;
  }
  const md = new vscode.MarkdownString(h.newCount === 0 ? 'Removed here:' : 'Before the change:');
  md.appendCodeblock(h.oldLines.slice(0, HOVER_LINES).map((l) => l.replace(/\r?\n$/, '')).join('\n'), languageId);
  if (h.oldLines.length > HOVER_LINES) {
    md.appendMarkdown(`… ${h.oldLines.length - HOVER_LINES} more lines`);
  }
  return md;
}

/**
 * Marks the lines still to review in ordinary editors: new or changed lines
 * get the diff editor's inserted-line background, removed lines a dashed line
 * where they were, and hovering a mark shows the text it replaced. Diff
 * editors show changes themselves and are left alone.
 */
export class Highlights implements vscode.Disposable {
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: 'dashed',
    borderWidth: '1px 0 0 0',
    borderColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly disposables: vscode.Disposable[] = [this.added, this.removed];
  private timer?: NodeJS.Timeout;

  constructor(private readonly manager: Manager) {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule(0)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) {
          this.schedule(300);
        }
      }),
    );
  }

  schedule(delay = 100): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.update(), delay);
  }

  private inDiff(ed: vscode.TextEditor): boolean {
    const uri = ed.document.uri.toString();
    return vscode.window.tabGroups.all.some(
      (g) => g.activeTab?.input instanceof vscode.TabInputTextDiff && g.activeTab.input.modified.toString() === uri,
    );
  }

  async update(): Promise<void> {
    const on = vscode.workspace.getConfiguration('secondLook').get<boolean>('highlightChanges', true);
    for (const ed of vscode.window.visibleTextEditors) {
      const doc = ed.document;
      const m = doc.uri.scheme === 'file' ? this.manager.modelFor(doc.uri) : undefined;
      const rel = m?.repo.rel(doc.uri.fsPath);
      if (!on || !m?.review || !rel || this.inDiff(ed) || (!m.pendingFile(rel) && !doc.isDirty)) {
        ed.setDecorations(this.added, []);
        ed.setDecorations(this.removed, []);
        continue;
      }
      const texts = await m.review.pendingTexts(rel, doc.isDirty ? doc.getText() : undefined);
      const added: vscode.DecorationOptions[] = [];
      const removed: vscode.DecorationOptions[] = [];
      for (const h of texts.hunks) {
        const hoverMessage = replacedText(h, doc.languageId);
        if (h.newCount > 0) {
          added.push({ range: new vscode.Range(h.newStart, 0, h.newStart + h.newCount - 1, 0), hoverMessage });
        } else {
          const line = Math.min(h.newStart, Math.max(doc.lineCount - 1, 0));
          removed.push({ range: new vscode.Range(line, 0, line, 0), hoverMessage });
        }
      }
      ed.setDecorations(this.added, added);
      ed.setDecorations(this.removed, removed);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
