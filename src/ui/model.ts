import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChangeStatus, FileTexts, Git, Hunk, IndexEntry, Repo, Review, ReviewHooks, ReviewState, gitVersion, sweepGoneBranches } from '../engine';
import { CommentStore } from '../comments/store';
import { EditorIO } from './editorIO';

/** 'off': no review was started in this checkout yet, so nothing shows until Start Review. */
export type ModelState = 'loading' | 'off' | 'changes' | 'reviewed' | 'clean' | 'detached' | 'terminal' | 'error';

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
    const reviewDir = path.join(repo.gitDir, 'second-look');
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
    let switched = false;
    if (this.review?.branch !== branch) {
      this.review = new Review(this.repo, branch, new EditorIO(this.repo.root), this.makeHooks(this));
      this.cache.clear();
      switched = true;
    }
    this.branch = branch;
    const review = this.review;
    if (!(await review.started())) {
      this.state = 'off';
      this.terminal = undefined;
      this.reviewState = undefined;
      this.undoLabel = undefined;
      this.pending = [];
      this.accepted = [];
      return;
    }
    if (switched) {
      // housekeeping only; a failure here must not hide the review
      await sweepGoneBranches(this.repo, branch).catch(() => undefined);
    }
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

/** The part of the API of VS Code's Git extension (vscode.git, version 1) that Second Look uses. */
interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitAPI;
}

interface GitAPI {
  readonly repositories: readonly { readonly rootUri: vscode.Uri }[];
  readonly onDidOpenRepository: vscode.Event<unknown>;
  readonly onDidCloseRepository: vscode.Event<unknown>;
}

/** All checkouts in the workspace. */
export class Manager implements vscode.Disposable {
  models: RepoModel[] = [];
  /** Review paused in this window: the review is kept, but nothing of it shows. */
  paused = false;
  git: Git;
  version: [number, number] = [0, 0];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter];
  /** The Git extension's API while it is on; undefined without it. */
  private gitApi?: GitAPI;
  private gitApiListeners: vscode.Disposable[] = [];
  private discovering?: Promise<void>;
  private nextDiscovery?: Promise<void>;
  private selectedModel?: RepoModel;

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
    void this.followGitExtension();
  }

  /**
   * Takes in the repositories that VS Code's Git extension finds in the workspace folders, as Source Control
   * shows them: those in subfolders too, and those cloned or created after the window opened. `git rev-parse`
   * finds only the repository a folder is in, never one below it. With the Git extension off (git.enabled),
   * only the workspace folders' own repositories are reviewed.
   */
  private async followGitExtension(): Promise<void> {
    const git = await vscode.extensions.getExtension<GitExtension>('vscode.git')?.activate().then(
      (g) => g,
      () => undefined,
    );
    if (!git) {
      return;
    }
    const connect = (enabled: boolean) => {
      this.gitApiListeners.forEach((d) => d.dispose());
      this.gitApiListeners = [];
      this.gitApi = undefined;
      if (enabled) {
        try {
          this.gitApi = git.getAPI(1);
        } catch {
          // getAPI throws while the extension has no git to run
          this.gitApi = undefined;
        }
      }
      if (this.gitApi) {
        this.gitApiListeners.push(
          this.gitApi.onDidOpenRepository(() => void this.discover()),
          this.gitApi.onDidCloseRepository(() => void this.discover()),
        );
      }
      void this.discover();
    };
    this.disposables.push(git.onDidChangeEnablement(connect));
    connect(git.enabled);
  }

  /**
   * Finds the checkouts in the workspace again. A request while one search runs is served by one more search
   * right after it: the Git extension reports the repositories it opens one by one, and two searches at once
   * would both make a model for a new one.
   */
  discover(): Promise<void> {
    if (this.discovering) {
      this.nextDiscovery ??= this.discovering
        .catch(() => undefined)
        .then(() => {
          this.nextDiscovery = undefined;
          return this.discover();
        });
      return this.nextDiscovery;
    }
    this.discovering = this.findCheckouts().finally(() => {
      this.discovering = undefined;
    });
    return this.discovering;
  }

  private async findCheckouts(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    // the Git extension also opens the repositories of files opened from outside the workspace; those are left out
    const inside = (this.gitApi?.repositories ?? [])
      .map((r) => r.rootUri)
      .filter((u) => u.scheme === 'file' && vscode.workspace.getWorkspaceFolder(u) !== undefined)
      .map((u) => u.fsPath)
      .sort();
    // every root comes from rev-parse, so the same repository found both ways has the same root, also on Windows
    const repos = await Promise.all(
      [...folders, ...inside].map((dir) => Repo.open(this.git, dir).catch(() => undefined)),
    );
    const found: RepoModel[] = [];
    const added: RepoModel[] = [];
    for (const repo of repos) {
      if (!repo || found.some((m) => m.repo.root === repo.root)) {
        continue;
      }
      let m = this.models.find((x) => x.repo.root === repo.root);
      if (!m) {
        m = this.track(new RepoModel(repo, this.makeHooks));
        added.push(m);
      }
      found.push(m);
    }
    const removed = this.models.filter((m) => !found.includes(m));
    removed.forEach((m) => m.dispose());
    if (this.selectedModel && removed.includes(this.selectedModel)) {
      this.selectedModel = undefined;
    }
    this.models = found;
    if (found.length > 0 && this.version[0] === 0) {
      this.version = await gitVersion(this.git, found[0].repo.root);
    }
    // the models already here keep themselves up to date
    await Promise.all(added.map((m) => m.refresh()));
    if (added.length > 0 || removed.length > 0) {
      this.emitter.fire();
    }
  }

  /** The repository chosen in the Repositories view; undefined when all are shown. */
  get selected(): RepoModel | undefined {
    return this.models.length > 1 && this.selectedModel && this.models.includes(this.selectedModel) ? this.selectedModel : undefined;
  }

  select(m: RepoModel | undefined): void {
    if (m !== this.selectedModel) {
      this.selectedModel = m;
      this.emitter.fire();
    }
  }

  /**
   * The repositories the Changes view shows: the one selected in the Repositories view, the only one when
   * there is just one, and none while several wait for a choice.
   */
  get shown(): RepoModel[] {
    const s = this.selected;
    if (s) {
      return [s];
    }
    return this.models.length === 1 ? this.models : [];
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
    this.gitApiListeners.forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
  }
}
