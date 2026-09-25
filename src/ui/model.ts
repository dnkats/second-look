import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangeStatus, FileTexts, Git, Hunk, IndexEntry, Repo, Review, ReviewHooks, ReviewState, gitVersion } from '../engine';
import { CommentStore } from '../comments/store';
import { EditorIO } from './editorIO';

export type ModelState = 'loading' | 'changes' | 'reviewed' | 'clean' | 'detached' | 'terminal' | 'error';

export interface FileItem {
  path: string;
  status: ChangeStatus;
  binary: boolean;
  hunks: Hunk[];
}

interface CacheEntry {
  sha: string | null;
  mtime: number;
  size: number;
  texts: FileTexts;
}

const REFRESH_DELAY = 400;

/** What one checkout looks like to the review UI, recomputed after every change. */
export class RepoModel implements vscode.Disposable {
  state: ModelState = 'loading';
  branch?: string;
  review?: Review;
  reviewState?: ReviewState;
  pending: FileItem[] = [];
  accepted: FileItem[] = [];
  undoLabel?: string;
  terminal?: { branch: string; state: string };
  error?: string;
  readonly comments: CommentStore;

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private next?: Promise<void>;
  private readonly cache = new Map<string, CacheEntry>();
  private acceptedHunks = new Map<string, FileTexts>();

  constructor(
    readonly repo: Repo,
    private readonly makeHooks: (model: RepoModel) => ReviewHooks,
  ) {
    this.comments = CommentStore.forGitDir(repo.gitDir);
    const reviewDir = path.join(repo.gitDir, 'git-review');
    const onFile = (uri: vscode.Uri) => {
      // our own index writes would otherwise trigger refresh after refresh
      if (!uri.fsPath.startsWith(reviewDir)) {
        this.schedule();
      }
    };
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(repo.root), '**/*'));
    w.onDidChange(onFile);
    w.onDidCreate(onFile);
    w.onDidDelete(onFile);
    const head = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(repo.gitDir), 'HEAD'));
    head.onDidChange(() => this.schedule());
    this.disposables.push(w, head, this.emitter);
    this.disposables.push(vscode.workspace.onDidSaveTextDocument((d) => {
      if (repo.rel(d.uri.fsPath)) {
        this.schedule();
      }
    }));
  }

  get name(): string {
    return path.basename(this.repo.root);
  }

  /** Refreshes soon; many file events in a row cause one refresh. */
  schedule(delay = REFRESH_DELAY): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
  }

  /**
   * Refreshes now. A request while a refresh runs is served by one more
   * refresh right after it, and resolves when that one is done, so callers
   * always see their own changes.
   */
  refresh(): Promise<void> {
    if (this.running) {
      this.next ??= this.running.then(() => {
        this.next = undefined;
        return this.refresh();
      });
      return this.next;
    }
    this.running = this.doRefresh()
      .catch((e: Error) => {
        this.state = 'error';
        this.error = e.message;
      })
      .finally(() => {
        this.running = undefined;
        this.emitter.fire();
      });
    return this.running;
  }

  private async doRefresh(): Promise<void> {
    const branch = await this.repo.branch();
    this.error = undefined;
    if (!branch) {
      this.branch = undefined;
      this.review = undefined;
      this.state = 'detached';
      this.pending = [];
      this.accepted = [];
      return;
    }
    if (this.review?.branch !== branch) {
      this.review = new Review(this.repo, branch, new EditorIO(this.repo.root), this.makeHooks(this));
      this.cache.clear();
    }
    this.branch = branch;
    const review = this.review;
    const terminal = await review.terminalReview();
    if (terminal) {
      this.terminal = terminal;
      this.state = 'terminal';
      this.pending = [];
      this.accepted = [];
      return;
    }
    this.terminal = undefined;
    await review.ensure();
    const carry = await review.carryIfNeeded();
    if (carry.carried && carry.conflicts.length > 0) {
      void vscode.window.showInformationMessage(
        `Moved the review onto the updated ${this.reviewState?.detail ?? 'main line'}. These files conflict with it and are shown for review again: ${carry.conflicts.join(', ')}`,
      );
    }
    this.reviewState = await review.load();
    const changes = await review.pending();
    const entries = await review.indexEntries(changes.map((c) => c.path));
    const items: FileItem[] = [];
    const seen = new Set<string>();
    await mapLimit(changes, 8, async (c) => {
      seen.add(c.path);
      const entry = entries.get(c.path) ?? null;
      const texts = await this.textsFor(c.path, entry);
      // a modified file without hunks changed only its mode; it is reviewed as a whole
      items.push({ path: c.path, status: c.status, binary: texts.binary, hunks: texts.hunks });
    });
    for (const k of [...this.cache.keys()]) {
      if (!seen.has(k)) {
        this.cache.delete(k);
      }
    }
    this.pending = items.sort((a, b) => a.path.localeCompare(b.path));
    const acc = this.reviewState ? await review.accepted(this.reviewState) : [];
    this.accepted = acc.map((c) => ({ path: c.path, status: c.status, binary: false, hunks: [] }));
    this.acceptedHunks = new Map();
    this.undoLabel = await review.canUndo();
    if (this.pending.length > 0) {
      this.state = 'changes';
    } else if (this.accepted.length > 0) {
      this.state = 'reviewed';
    } else {
      this.state = 'clean';
    }
  }

  /** Hunks of a pending file, reused while neither side changed. */
  private async textsFor(rel: string, entry: IndexEntry | null): Promise<FileTexts> {
    const review = this.review!;
    let st: { mtimeMs: number; size: number } | undefined;
    try {
      st = await fs.stat(this.repo.abs(rel));
    } catch {
      st = undefined;
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === this.repo.abs(rel));
    const c = this.cache.get(rel);
    const sha = entry?.sha ?? null;
    if (!doc?.isDirty && c && c.sha === sha && c.mtime === (st?.mtimeMs ?? -1) && c.size === (st?.size ?? -1)) {
      return c.texts;
    }
    const texts = await review.pendingTexts(rel, undefined, entry);
    if (!doc?.isDirty) {
      this.cache.set(rel, { sha, mtime: st?.mtimeMs ?? -1, size: st?.size ?? -1, texts });
    }
    return texts;
  }

  /** Base against checklist for an accepted file, computed when its node is expanded. */
  async acceptedTexts(rel: string): Promise<FileTexts | undefined> {
    if (!this.review || !this.reviewState) {
      return undefined;
    }
    let t = this.acceptedHunks.get(rel);
    if (!t) {
      t = await this.review.acceptedTexts(this.reviewState, rel);
      this.acceptedHunks.set(rel, t);
    }
    return t;
  }

  pendingFile(rel: string): FileItem | undefined {
    return this.pending.find((f) => f.path === rel);
  }

  get pendingHunkCount(): number {
    return this.pending.reduce((n, f) => n + Math.max(f.hunks.length, 1), 0);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      await fn(items[i++]);
    }
  });
  await Promise.all(workers);
}

/** All checkouts in the workspace. */
export class Manager implements vscode.Disposable {
  models: RepoModel[] = [];
  git: Git;
  version: [number, number] = [0, 0];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter];

  constructor(private readonly makeHooks: (m: RepoModel) => ReviewHooks) {
    const gitPath = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
    this.git = new Git(typeof gitPath === 'string' && gitPath ? gitPath : Array.isArray(gitPath) && gitPath[0] ? gitPath[0] : 'git');
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discover()));
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          this.models.forEach((m) => m.schedule(50));
        }
      }),
    );
  }

  async discover(): Promise<void> {
    const found: RepoModel[] = [];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') {
        continue;
      }
      let repo: Repo | undefined;
      try {
        repo = await Repo.open(this.git, f.uri.fsPath);
      } catch {
        repo = undefined;
      }
      if (!repo || found.some((m) => m.repo.root === repo!.root)) {
        continue;
      }
      const existing = this.models.find((m) => m.repo.root === repo!.root);
      found.push(existing ?? this.track(new RepoModel(repo, this.makeHooks)));
    }
    for (const m of this.models) {
      if (!found.includes(m)) {
        m.dispose();
      }
    }
    this.models = found;
    if (found.length > 0 && this.version[0] === 0) {
      this.version = await gitVersion(this.git, found[0].repo.root);
    }
    await Promise.all(found.map((m) => m.refresh()));
    this.emitter.fire();
  }

  private track(m: RepoModel): RepoModel {
    m.onDidChange(() => this.emitter.fire());
    return m;
  }

  modelFor(uri: vscode.Uri): RepoModel | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    let best: RepoModel | undefined;
    for (const m of this.models) {
      if (m.repo.rel(uri.fsPath) !== undefined && (!best || m.repo.root.length > best.repo.root.length)) {
        best = m;
      }
    }
    return best;
  }

  byRoot(root: string): RepoModel | undefined {
    return this.models.find((m) => m.repo.root === root);
  }

  dispose(): void {
    this.models.forEach((m) => m.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
