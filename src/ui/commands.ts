import * as path from 'node:path';
import * as vscode from 'vscode';
import { BaseChoice, Hunk, StaleChangeError, UndoConflictError, hunkAtLine, hunkKey } from '../engine';
import { Manager, RepoModel } from './model';
import { Node, Target, fileTarget } from './tree';
import { CONTENT_SCHEME, contentUri, fileUri, parseContentUri } from './uris';

type Arg = Node | Target | vscode.Uri | string | undefined;

function isNode(a: unknown): a is Node {
  return typeof a === 'object' && a !== null && 'kind' in a && 'model' in a;
}

function isTarget(a: unknown): a is Target {
  return typeof a === 'object' && a !== null && 'root' in a && 'path' in a;
}

export class Commands {
  constructor(private readonly manager: Manager) {}

  register(context: vscode.ExtensionContext): void {
    const cmd = (id: string, fn: (...args: never[]) => Promise<unknown> | unknown) =>
      context.subscriptions.push(vscode.commands.registerCommand(id, (...args: never[]) => this.guard(() => fn(...args))));
    cmd('secondLook.refresh', () => Promise.all(this.manager.models.map((m) => m.refresh())));
    cmd('secondLook.openChange', (a: Arg) => this.openChange(a));
    cmd('secondLook.openAccepted', (a: Arg) => this.openAccepted(a));
    cmd('secondLook.openAll', (a: Arg) => this.openAll(a));
    cmd('secondLook.accept', (a: Arg) => this.accept(a));
    cmd('secondLook.reject', (a: Arg) => this.reject(a));
    cmd('secondLook.unaccept', (a: Arg) => this.unaccept(a));
    cmd('secondLook.acceptAll', (a: Arg) => this.acceptAll(a));
    cmd('secondLook.rejectAll', (a: Arg) => this.rejectAll(a));
    cmd('secondLook.acceptAtCursor', () => this.atCursor('accept'));
    cmd('secondLook.rejectAtCursor', () => this.atCursor('reject'));
    cmd('secondLook.nextChange', () => this.step(1));
    cmd('secondLook.previousChange', () => this.step(-1));
    cmd('secondLook.reviewThisFile', (a: Arg) => this.reviewThisFile(a));
    cmd('secondLook.undo', (a: Arg) => this.undo(a));
    cmd('secondLook.finish', (a: Arg) => this.finish(a));
    cmd('secondLook.reviewFrom', (a: Arg) => this.reviewFrom(a));
    cmd('secondLook.takeOverTerminal', (a: Arg) => this.takeOver(a));
  }

  private async guard(fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof StaleChangeError) {
        void vscode.window.showInformationMessage(e.message);
        await Promise.all(this.manager.models.map((m) => m.refresh()));
      } else if (e instanceof UndoConflictError) {
        void vscode.window.showWarningMessage(e.message);
      } else {
        void vscode.window.showErrorMessage(`Second Look: ${(e as Error).message}`);
      }
    }
  }

  // ---- resolving arguments ------------------------------------------------

  private target(a: Arg): Target | undefined {
    if (isNode(a)) {
      return fileTarget(a);
    }
    if (isTarget(a)) {
      return a;
    }
    const uri = a instanceof vscode.Uri ? a : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      return undefined;
    }
    const file = uri.scheme === CONTENT_SCHEME ? (() => {
      const p = parseContentUri(uri);
      return fileUri(p.root, p.rel);
    })() : uri;
    const m = this.manager.modelFor(file);
    const rel = m?.repo.rel(file.fsPath);
    return m && rel ? { root: m.repo.root, path: rel, group: 'pending' } : undefined;
  }

  private modelOf(t: Target): RepoModel {
    const m = this.manager.byRoot(t.root);
    if (!m?.review) {
      throw new Error('No review is open there.');
    }
    return m;
  }

  /** The repository a global command acts on: given, the only one, or picked. */
  private async pickModel(a: Arg, want: (m: RepoModel) => boolean = () => true): Promise<RepoModel | undefined> {
    if (typeof a === 'string') {
      return this.manager.byRoot(a);
    }
    if (isNode(a)) {
      return a.model;
    }
    if (isTarget(a)) {
      return this.manager.byRoot(a.root);
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    const fromEditor = active ? this.manager.modelFor(active) : undefined;
    const candidates = this.manager.models.filter(want);
    if (fromEditor && candidates.includes(fromEditor)) {
      return fromEditor;
    }
    if (candidates.length <= 1) {
      return candidates[0];
    }
    const pick = await vscode.window.showQuickPick(
      candidates.map((m) => ({ label: m.name, description: m.repo.root, m })),
      { placeHolder: 'Which repository?' },
    );
    return pick?.m;
  }

  // ---- opening diffs --------------------------------------------------------

  private statusOf(m: RepoModel, t: Target): string | undefined {
    const list = t.group === 'pending' ? m.pending : m.accepted;
    return t.status ?? list.find((f) => f.path === t.path)?.status;
  }

  private async openChange(a: Arg): Promise<void> {
    const t = this.target(a);
    if (!t) {
      return;
    }
    const m = this.modelOf(t);
    const status = this.statusOf(m, t);
    const left = status === 'A' ? contentUri(t.root, t.path, 'empty') : contentUri(t.root, t.path, 'checklist');
    const right = status === 'D' ? contentUri(t.root, t.path + '​', 'empty') : fileUri(t.root, t.path);
    const opts: vscode.TextDocumentShowOptions = { preview: true };
    if (t.line !== undefined) {
      opts.selection = new vscode.Range(t.line, 0, t.line, 0);
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(t.path)} (to review)`, opts);
  }

  private async openAccepted(a: Arg): Promise<void> {
    const t = this.target(a);
    if (!t) {
      return;
    }
    const m = this.modelOf(t);
    const status = this.statusOf(m, { ...t, group: 'accepted' });
    const left = status === 'A' ? contentUri(t.root, t.path, 'empty') : contentUri(t.root, t.path, 'base');
    const right = status === 'D' ? contentUri(t.root, t.path + '​', 'empty') : contentUri(t.root, t.path, 'checklist');
    const opts: vscode.TextDocumentShowOptions = { preview: true };
    if (t.line !== undefined) {
      opts.selection = new vscode.Range(t.line, 0, t.line, 0);
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(t.path)} (accepted)`, opts);
  }

  private async openAll(a: Arg): Promise<void> {
    const m = await this.pickModel(a, (x) => x.pending.length > 0);
    if (!m) {
      return;
    }
    const root = m.repo.root;
    const resources = m.pending.map((f) => [
      fileUri(root, f.path),
      f.status === 'A' ? undefined : contentUri(root, f.path, 'checklist'),
      f.status === 'D' ? undefined : fileUri(root, f.path),
    ]);
    await vscode.commands.executeCommand('vscode.changes', `To review: ${m.name}`, resources);
  }

  private async reviewThisFile(a: Arg): Promise<void> {
    const t = this.target(a);
    if (!t) {
      return;
    }
    const ed = vscode.window.activeTextEditor;
    const line = ed && ed.document.uri.fsPath === fileUri(t.root, t.path).fsPath ? ed.selection.active.line : undefined;
    await this.openChange({ ...t, line });
  }

  // ---- accepting and rejecting ----------------------------------------------

  /** Saves unsaved editors of the repository, so the files, git and the editor agree before a change. */
  private async saveDirty(m: RepoModel, rel?: string): Promise<void> {
    for (const d of vscode.workspace.textDocuments) {
      if (d.isDirty && d.uri.scheme === 'file') {
        const r = m.repo.rel(d.uri.fsPath);
        if (r !== undefined && (rel === undefined || r === rel)) {
          await d.save();
        }
      }
    }
  }

  private async accept(a: Arg): Promise<void> {
    const t = this.target(a);
    if (!t) {
      return;
    }
    const m = this.modelOf(t);
    await this.saveDirty(m, t.path);
    if (t.key) {
      await m.review!.acceptHunk(t.path, t.key);
    } else {
      await m.review!.acceptFile(t.path);
    }
    await m.refresh();
  }

  private async reject(a: Arg): Promise<void> {
    const t = this.target(a);
    if (!t) {
      return;
    }
    const m = this.modelOf(t);
    await this.saveDirty(m, t.path);
    if (t.key) {
      await m.review!.rejectHunk(t.path, t.key);
    } else {
      const status = this.statusOf(m, t);
      if (status === 'A') {
        const ok = await vscode.window.showWarningMessage(
          `Reject the new file ${t.path}? It is deleted; Undo brings it back.`,
          { modal: true },
          'Reject',
        );
        if (ok !== 'Reject') {
          return;
        }
      }
      await m.review!.rejectFile(t.path);
    }
    await m.refresh();
  }

  private async unaccept(a: Arg): Promise<void> {
    const t = this.target(a);
    if (!t) {
      return;
    }
    const m = this.modelOf(t);
    if (t.key) {
      await m.review!.unacceptHunk(t.path, t.key);
    } else {
      await m.review!.unacceptFile(t.path);
    }
    await m.refresh();
  }

  private async acceptAll(a: Arg): Promise<void> {
    const m = await this.pickModel(a, (x) => x.pending.length > 0);
    if (!m?.review) {
      return;
    }
    await this.saveDirty(m);
    await m.review.acceptAll();
    await m.refresh();
  }

  private async rejectAll(a: Arg): Promise<void> {
    const m = await this.pickModel(a, (x) => x.pending.length > 0);
    if (!m?.review) {
      return;
    }
    const n = m.pending.length;
    const ok = await vscode.window.showWarningMessage(
      `Reject all changes still to review in ${n} file${n === 1 ? '' : 's'}? New files are deleted. Undo brings everything back.`,
      { modal: true },
      'Reject All',
    );
    if (ok !== 'Reject All') {
      return;
    }
    await this.saveDirty(m);
    await m.review.rejectAll();
    await m.refresh();
  }

  /** The editor's file and the change at the cursor, on either side of a review diff. */
  private async hunkAtCursor(): Promise<{ m: RepoModel; rel: string; hunk: Hunk; hunks: Hunk[]; ed: vscode.TextEditor } | undefined> {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      return undefined;
    }
    let uri = ed.document.uri;
    const line = ed.selection.active.line;
    let oldSide = false;
    if (uri.scheme === CONTENT_SCHEME) {
      const p = parseContentUri(uri);
      uri = fileUri(p.root, p.rel);
      oldSide = true;
    }
    const m = this.manager.modelFor(uri);
    const rel = m?.repo.rel(uri.fsPath);
    if (!m?.review || !rel) {
      return undefined;
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === uri.fsPath);
    const texts = await m.review.pendingTexts(rel, doc?.isDirty ? doc.getText() : undefined);
    const hunk = oldSide
      ? texts.hunks.find((h) => line >= h.oldStart && line < h.oldStart + Math.max(h.oldCount, 1))
      : hunkAtLine(texts.hunks, line);
    return hunk ? { m, rel, hunk, hunks: texts.hunks, ed } : undefined;
  }

  private async atCursor(action: 'accept' | 'reject'): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.isDirty && doc.uri.scheme === 'file') {
      await doc.save();
    }
    const found = await this.hunkAtCursor();
    if (!found) {
      void vscode.window.setStatusBarMessage('No change to review at the cursor', 3000);
      return;
    }
    const { m, rel, hunk } = found;
    if (action === 'accept') {
      await m.review!.acceptHunk(rel, hunkKey(hunk));
    } else {
      await m.review!.rejectHunk(rel, hunkKey(hunk));
    }
    await m.refresh();
    await this.step(1, hunk.newStart);
  }

  /** Moves the cursor to the next (or previous) change to review in this file, then in the next file. */
  private async step(dir: 1 | -1, from?: number): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      return;
    }
    let uri = ed.document.uri;
    if (uri.scheme === CONTENT_SCHEME) {
      const p = parseContentUri(uri);
      uri = fileUri(p.root, p.rel);
    }
    const m = this.manager.modelFor(uri);
    const rel = m?.repo.rel(uri.fsPath);
    if (!m || !rel) {
      return;
    }
    const file = m.pendingFile(rel);
    const line = from ?? ed.selection.active.line;
    const hunks = file?.hunks ?? [];
    const next = dir === 1 ? hunks.find((h) => h.newStart > line || (from !== undefined && h.newStart >= line)) : [...hunks].reverse().find((h) => h.newStart < line);
    if (next && ed.document.uri.scheme === 'file') {
      const pos = new vscode.Position(next.newStart, 0);
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    if (next) {
      await this.openChange({ root: m.repo.root, path: rel, group: 'pending', line: next.newStart });
      return;
    }
    // on to the next file with something to review
    const idx = m.pending.findIndex((f) => f.path === rel);
    const others = dir === 1 ? m.pending.slice(idx + 1) : m.pending.slice(0, Math.max(idx, 0)).reverse();
    const target = others[0] ?? (idx === -1 ? m.pending[0] : undefined);
    if (target) {
      const h = dir === 1 ? target.hunks[0] : target.hunks[target.hunks.length - 1];
      await this.openChange({ root: m.repo.root, path: target.path, group: 'pending', status: target.status, line: h?.newStart });
    } else if (m.pending.length === 0) {
      void vscode.window.setStatusBarMessage('Nothing left to review', 3000);
    }
  }

  // ---- undo, finish, where to start -------------------------------------------

  private async undo(a: Arg): Promise<void> {
    const m = await this.pickModel(a, (x) => x.undoLabel !== undefined);
    if (!m?.review) {
      return;
    }
    const label = await m.review.undo();
    await m.refresh();
    if (label) {
      void vscode.window.setStatusBarMessage(`Undid: ${label}`, 4000);
    }
  }

  private async finish(a: Arg): Promise<void> {
    const m = await this.pickModel(a, (x) => x.state === 'changes' || x.state === 'reviewed');
    if (!m?.review || !m.branch) {
      return;
    }
    if (m.pending.length > 0) {
      const n = m.pendingHunkCount;
      const ok = await vscode.window.showWarningMessage(
        `${n} change${n === 1 ? ' is' : 's are'} not reviewed yet.`,
        { modal: true, detail: 'Accept them all and finish, or keep reviewing.' },
        'Accept All and Finish',
      );
      if (ok !== 'Accept All and Finish') {
        return;
      }
      await this.saveDirty(m);
      await m.review.acceptAll();
    }
    let commitMessage: string | undefined;
    if (await m.review.hasUncommitted()) {
      const cfg = vscode.workspace.getConfiguration('secondLook');
      let mode = cfg.get<string>('finish.commitEdits', 'ask');
      if (mode === 'ask') {
        const choice = await vscode.window.showInformationMessage(
          `Commit the uncommitted changes as “Review edits on ${m.branch}”?`,
          {
            modal: true,
            detail: 'Everything in this checkout that is not committed yet goes into one commit. Leaving it uncommitted works too: it counts as reviewed either way.',
          },
          'Commit',
          'Leave Uncommitted',
          'Always Commit',
          'Never Commit',
        );
        if (!choice) {
          return;
        }
        if (choice === 'Always Commit' || choice === 'Never Commit') {
          await cfg.update('finish.commitEdits', choice === 'Always Commit' ? 'always' : 'never', vscode.ConfigurationTarget.Global);
        }
        mode = choice === 'Commit' || choice === 'Always Commit' ? 'always' : 'never';
      }
      if (mode === 'always') {
        commitMessage = `Review edits on ${m.branch}`;
      }
    }
    const r = await m.review.finish({ commitMessage });
    await m.refresh();
    void vscode.window.showInformationMessage(r.committed ? `Review finished; your edits are committed as ${r.committed.slice(0, 7)}.` : 'Review finished.');
  }

  private async reviewFrom(a: Arg): Promise<void> {
    const m = await this.pickModel(a, (x) => x.review !== undefined);
    if (!m?.review || !m.branch) {
      return;
    }
    const repo = m.repo;
    const head = await repo.head();
    type Item = vscode.QuickPickItem & { choice?: BaseChoice; custom?: boolean };
    const items: Item[] = [];
    // a side branch keeps following main, whatever the review starts from
    const main = await m.review.followMain();
    const follows = main ? { upstreamRef: main.ref, upstream: main.now } : {};
    if (await repo.resolve(`refs/reviewed/${m.branch}`)) {
      items.push({ label: '$(history) Since my last review', choice: await m.review.autoBase() });
    }
    if (head && main) {
      items.push({ label: `$(git-branch) Since ${m.branch} left ${main.name}`, choice: { base: main.now, kind: 'branchStart', detail: main.name, ...follows } });
    }
    const up = await repo.upstream(m.branch);
    if (head && up) {
      const mb = await repo.mergeBase(head, up.ref);
      if (mb && mb !== head) {
        items.push({ label: `$(cloud-upload) Commits not pushed to ${up.name} yet`, choice: { base: mb, kind: 'unpushed', detail: up.name, ...follows } });
      }
    }
    if (head) {
      items.push({ label: '$(debug-start) From now on', description: 'only changes made from here', choice: { base: head, kind: 'uncommitted', ...follows } });
      const log = await repo.text(['log', '-n', '30', '--format=%H%x1f%h%x1f%s%x1f%cr']);
      const commits = log.split('\n').filter((l) => l);
      if (commits.length > 0) {
        items.push({ label: 'Since a commit', kind: vscode.QuickPickItemKind.Separator });
      }
      for (const c of commits) {
        const [sha, short, subject, rel] = c.split('\x1f');
        items.push({ label: `$(git-commit) ${subject}`, description: `${short} · ${rel}`, choice: { base: sha, kind: 'picked', detail: `${short} ${subject}`, ...follows } });
      }
    }
    items.push({ label: '$(edit) Enter a commit or branch…', custom: true });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Review the changes since…', matchOnDescription: true });
    if (!pick) {
      return;
    }
    let choice = pick.choice;
    if (pick.custom) {
      const ref = await vscode.window.showInputBox({ prompt: 'Commit, tag or branch to review from' });
      if (!ref) {
        return;
      }
      const sha = await repo.resolve(ref);
      if (!sha) {
        throw new Error(`${ref} is not a commit.`);
      }
      choice = { base: sha, kind: 'picked', detail: ref, ...follows };
    }
    if (!choice) {
      return;
    }
    if (m.accepted.length > 0) {
      const ok = await vscode.window.showWarningMessage('Start the review over from there? What you accepted so far is dropped.', { modal: true }, 'Start Over');
      if (ok !== 'Start Over') {
        return;
      }
    }
    await m.review.start(choice);
    await m.refresh();
  }

  private async takeOver(a: Arg): Promise<void> {
    const m = await this.pickModel(a, (x) => x.state === 'terminal');
    if (!m?.review) {
      return;
    }
    const ok = await vscode.window.showInformationMessage(
      'Continue the terminal review here?',
      {
        modal: true,
        detail: 'What you accepted with git review stays accepted and shows in this view. Git\'s index goes back to normal, as after `git review abort`, and the terminal tool no longer sees the review.',
      },
      'Take Over',
    );
    if (ok !== 'Take Over') {
      return;
    }
    await m.review.takeOverTerminalReview();
    await m.refresh();
  }
}
