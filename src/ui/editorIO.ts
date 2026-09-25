import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FsIO, WorktreeIO, applyMode, decodeText } from '../engine';

/**
 * Working-tree access that goes through open editors: unsaved text is what
 * gets reviewed, and rejects are edits the editor can undo with Ctrl+Z.
 */
export class EditorIO implements WorktreeIO {
  private readonly fsio: FsIO;

  constructor(private readonly root: string) {
    this.fsio = new FsIO(root);
  }

  private abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  private openDocument(rel: string): vscode.TextDocument | undefined {
    const file = this.abs(rel);
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file && !d.isClosed);
  }

  async read(rel: string): Promise<Buffer | undefined> {
    const doc = this.openDocument(rel);
    // a saved document equals the file, and the file keeps a byte order mark the editor hides
    if (doc?.isDirty) {
      return Buffer.from(doc.getText(), 'utf8');
    }
    return this.fsio.read(rel);
  }

  async write(rel: string, content: Buffer, mode?: string): Promise<void> {
    const doc = this.openDocument(rel);
    const text = decodeText(content);
    if (!doc || text === undefined) {
      await this.fsio.write(rel, content, mode);
      return;
    }
    const old = doc.getText();
    // replace only the part that differs, so the cursor and folds stay put
    let head = 0;
    while (head < old.length && head < text.length && old[head] === text[head]) {
      head++;
    }
    let tail = 0;
    while (tail < old.length - head && tail < text.length - head && old[old.length - 1 - tail] === text[text.length - 1 - tail]) {
      tail++;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(head), doc.positionAt(old.length - tail)), text.slice(head, text.length - tail));
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(`Could not edit ${rel}.`);
    }
    await doc.save();
    await applyMode(this.abs(rel), mode);
  }

  async remove(rel: string): Promise<void> {
    await fs.rm(this.abs(rel), { force: true });
  }
}
