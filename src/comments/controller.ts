import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { Manager, RepoModel } from '../ui/model';
import { fileUri } from '../ui/uris';
import { formatThread } from './format';
import { Entry, RejectionInput, StoreData, Thread, makeAnchor, newId, relocateThread, textLines } from './store';

/** One entry of a thread as VS Code shows it. */
class ReviewComment implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  contextValue: string;
  timestamp: Date;
  savedBody?: string | vscode.MarkdownString;

  constructor(
    readonly entry: Entry,
    public parent: vscode.CommentThread,
  ) {
    this.body = new vscode.MarkdownString(entry.text);
    this.author = { name: entry.author };
    this.contextValue = entry.role;
    this.timestamp = new Date(entry.at);
  }
}

function threadLabel(t: Thread): string {
  const parts: string[] = [];
  if (t.anchor.state === 'outdated') {
    parts.push('The code changed since');
  }
  const last = t.entries[t.entries.length - 1];
  if (t.status === 'resolved') {
    parts.push('Resolved');
  } else if (last?.role === 'agent') {
    parts.push('The agent replied');
  } else if (last?.delivered) {
    parts.push('Read by the agent');
  } else {
    parts.push('Not read by the agent yet');
  }
  return parts.join(' · ');
}

interface Ref {
  root: string;
  id: string;
}

/**
 * Review comments in the editor: threads anchored to lines, stored in the
 * checkout's git directory where the agent's review-comments tool reads and
 * answers them.
 */
export class CommentsUI implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly refs = new WeakMap<vscode.CommentThread, Ref>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watched = new Set<string>();

  constructor(
    private readonly manager: Manager,
    private readonly onFirstComment: () => void,
  ) {
    this.controller = vscode.comments.createCommentController('gitReview', 'Review Comments');
    this.controller.options = {
      prompt: 'Comment for the agent',
      placeHolder: 'Your agent reads this when you ask it to check your comments',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc: vscode.TextDocument) => {
        if (doc.uri.scheme !== 'file' || !this.manager.modelFor(doc.uri)) {
          return [];
        }
        return [new vscode.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)];
      },
    };
    this.disposables.push(this.controller);
  }

  register(context: vscode.ExtensionContext): void {
    const cmd = (id: string, fn: (...args: never[]) => unknown) =>
      context.subscriptions.push(
        vscode.commands.registerCommand(id, async (...args: never[]) => {
          try {
            await fn(...args);
          } catch (e) {
            void vscode.window.showErrorMessage(`Git Review: ${(e as Error).message}`);
          }
        }),
      );
    cmd('gitReview.comment.create', (r: vscode.CommentReply) => this.create(r));
    cmd('gitReview.comment.reply', (r: vscode.CommentReply) => this.reply(r));
    cmd('gitReview.comment.resolve', (t: vscode.CommentThread) => this.setStatus(t, 'resolved'));
    cmd('gitReview.comment.reopen', (t: vscode.CommentThread) => this.setStatus(t, 'open'));
    cmd('gitReview.comment.delete', (t: vscode.CommentThread) => this.remove(t));
    cmd('gitReview.comment.edit', (c: ReviewComment) => this.edit(c));
    cmd('gitReview.comment.save', (c: ReviewComment) => this.save(c));
    cmd('gitReview.comment.cancel', (c: ReviewComment) => this.cancel(c));
    cmd('gitReview.copyComments', (a?: string) => this.copyAsPrompt(a));
  }

  /** Loads every repository's threads and follows its store file. */
  async sync(): Promise<void> {
    for (const m of this.manager.models) {
      if (!this.watched.has(m.repo.root)) {
        this.watched.add(m.repo.root);
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(m.comments.file)), 'comments.json'));
        const reload = () => void this.load(m);
        w.onDidChange(reload);
        w.onDidCreate(reload);
        w.onDidDelete(reload);
        this.disposables.push(w);
      }
      await this.relocate(m);
      await this.load(m);
    }
  }

  private key(root: string, id: string): string {
    return `${root}#${id}`;
  }

  private async load(m: RepoModel): Promise<void> {
    const d = await m.comments.read();
    const root = m.repo.root;
    const present = new Set<string>();
    for (const t of d.threads) {
      const k = this.key(root, t.id);
      present.add(k);
      const range = new vscode.Range(t.anchor.start - 1, 0, t.anchor.end - 1, 0);
      let vt = this.threads.get(k);
      if (!vt) {
        vt = this.controller.createCommentThread(fileUri(root, t.path), range, []);
        this.threads.set(k, vt);
        this.refs.set(vt, { root, id: t.id });
        vt.collapsibleState = t.status === 'open' ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
      } else if (!vt.range || !vt.range.isEqual(range)) {
        vt.range = range;
      }
      this.show(vt, t);
    }
    for (const [k, vt] of this.threads) {
      if (k.startsWith(root + '#') && !present.has(k)) {
        vt.dispose();
        this.threads.delete(k);
      }
    }
  }

  private show(vt: vscode.CommentThread, t: Thread): void {
    // keep a comment that is being edited as it is
    const editing = vt.comments.find((c) => c.mode === vscode.CommentMode.Editing) as ReviewComment | undefined;
    vt.comments = t.entries.map((e) => (editing && editing.entry.id === e.id ? editing : new ReviewComment(e, vt)));
    vt.label = threadLabel(t);
    vt.contextValue = t.status;
    vt.canReply = true;
    vt.state = t.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
  }

  /** Moves threads to where their code is now; writes only when something moved. */
  async relocate(m: RepoModel): Promise<void> {
    const d = await m.comments.read();
    const open = d.threads.filter((t) => t.status === 'open');
    if (open.length === 0) {
      return;
    }
    const lines = new Map<string, string[] | undefined>();
    for (const t of open) {
      if (!lines.has(t.path)) {
        lines.set(t.path, await readLines(m.repo.abs(t.path)));
      }
    }
    const moved = open.filter((t) => relocateThread(structuredClone(t), lines.get(t.path)));
    if (moved.length === 0) {
      return;
    }
    await m.comments.update((store) => {
      for (const t of store.threads) {
        if (t.status === 'open' && lines.has(t.path)) {
          relocateThread(t, lines.get(t.path));
        }
      }
    });
  }

  private modelOf(uri: vscode.Uri): RepoModel {
    const m = this.manager.modelFor(uri);
    if (!m) {
      throw new Error('Comments work in files of a git repository.');
    }
    return m;
  }

  private async create(reply: vscode.CommentReply): Promise<void> {
    const vt = reply.thread;
    const m = this.modelOf(vt.uri);
    const rel = m.repo.rel(vt.uri.fsPath)!;
    const doc = await vscode.workspace.openTextDocument(vt.uri);
    const lines = textLines(doc.getText());
    const r = vt.range ?? new vscode.Range(0, 0, 0, 0);
    const start = r.start.line + 1;
    // a selection that ends at the start of a line does not include that line
    const end = Math.max(start, r.end.character === 0 && r.end.line > r.start.line ? r.end.line : r.end.line + 1);
    const author = await m.repo.userName();
    const first = (await m.comments.read()).threads.length === 0;
    const id = await m.comments.update((d: StoreData) => {
      const tid = newId(d, 'c');
      const anchor = makeAnchor(lines, start, Math.min(end, Math.max(lines.length, start)));
      d.threads.push({
        id: tid,
        path: rel,
        status: 'open',
        created: new Date().toISOString(),
        original: { start: anchor.start, end: anchor.end, code: anchor.lines },
        anchor: { ...anchor, state: 'exact' },
        entries: [{ id: newId(d, 'e'), role: 'user', author, text: reply.text, at: new Date().toISOString() }],
      });
      return tid;
    });
    const k = this.key(m.repo.root, id);
    this.threads.set(k, vt);
    this.refs.set(vt, { root: m.repo.root, id });
    vt.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    await this.load(m);
    if (first) {
      this.onFirstComment();
    }
  }

  private async withThread<T>(vt: vscode.CommentThread, fn: (t: Thread, d: StoreData) => T): Promise<RepoModel | undefined> {
    const ref = this.refs.get(vt);
    const m = ref && this.manager.byRoot(ref.root);
    if (!ref || !m) {
      return undefined;
    }
    await m.comments.update((d) => {
      const t = d.threads.find((x) => x.id === ref.id);
      if (!t) {
        throw new Error('That comment no longer exists.');
      }
      fn(t, d);
    });
    await this.load(m);
    return m;
  }

  private async reply(reply: vscode.CommentReply): Promise<void> {
    const m = this.modelOf(reply.thread.uri);
    const author = await m.repo.userName();
    await this.withThread(reply.thread, (t, d) => {
      t.entries.push({ id: newId(d, 'e'), role: 'user', author, text: reply.text, at: new Date().toISOString() });
      t.status = 'open';
    });
  }

  private async setStatus(vt: vscode.CommentThread, status: 'open' | 'resolved'): Promise<void> {
    await this.withThread(vt, (t) => {
      t.status = status;
    });
    vt.collapsibleState = status === 'resolved' ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
  }

  private async remove(vt: vscode.CommentThread): Promise<void> {
    const ref = this.refs.get(vt);
    const m = ref && this.manager.byRoot(ref.root);
    if (!ref || !m) {
      vt.dispose();
      return;
    }
    const ok = await vscode.window.showWarningMessage('Delete this comment thread?', { modal: true }, 'Delete');
    if (ok !== 'Delete') {
      return;
    }
    await m.comments.update((d) => {
      d.threads = d.threads.filter((t) => t.id !== ref.id);
    });
    this.threads.delete(this.key(ref.root, ref.id));
    vt.dispose();
  }

  private edit(c: ReviewComment): void {
    c.savedBody = c.body;
    c.body = c.entry.text;
    c.mode = vscode.CommentMode.Editing;
    c.parent.comments = [...c.parent.comments];
  }

  private async save(c: ReviewComment): Promise<void> {
    const text = typeof c.body === 'string' ? c.body : c.body.value;
    c.mode = vscode.CommentMode.Preview;
    await this.withThread(c.parent, (t) => {
      const e = t.entries.find((x) => x.id === c.entry.id);
      if (e) {
        e.text = text;
        // an edited comment is news to the agent
        e.delivered = false;
      }
    });
  }

  private cancel(c: ReviewComment): void {
    c.body = c.savedBody ?? c.body;
    c.mode = vscode.CommentMode.Preview;
    c.parent.comments = [...c.parent.comments];
  }

  /** For agents without the skill: all open comments as text on the clipboard. */
  private async copyAsPrompt(root?: string): Promise<void> {
    const models = root ? this.manager.models.filter((m) => m.repo.root === root) : this.manager.models;
    const parts: string[] = [];
    for (const m of models) {
      const d = await m.comments.read();
      const open = d.threads.filter((t) => t.status === 'open');
      if (open.length > 0) {
        parts.push(`Review comments in ${m.repo.root}:\n\n` + open.map((t) => formatThread(t)).join('\n\n'));
      }
    }
    if (parts.length === 0) {
      void vscode.window.showInformationMessage('There are no open comments.');
      return;
    }
    await vscode.env.clipboard.writeText(parts.join('\n\n') + '\n\nPlease address each comment and tell me what you changed.\n');
    void vscode.window.setStatusBarMessage('Open comments copied as a prompt', 3000);
  }

  /** Records a rejected change for the agent; returns its id. */
  static async recordRejection(m: RepoModel, info: RejectionInput): Promise<string> {
    return m.comments.update((d) => {
      const id = newId(d, 'r');
      d.rejections.push({ id, ...info, at: new Date().toISOString() });
      // keep the list short: the agent only needs recent ones
      d.rejections = d.rejections.slice(-200);
      return id;
    });
  }

  static async forgetRejection(m: RepoModel, id: string): Promise<void> {
    await m.comments.update((d) => {
      d.rejections = d.rejections.filter((r) => r.id !== id);
    });
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

async function readLines(file: string): Promise<string[] | undefined> {
  try {
    return textLines(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}
