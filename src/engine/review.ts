import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { GitError } from './git';
import { Hunk, HunkKey, applyHunk, computeHunks, decodeText, findHunk, revertHunk } from './hunks';
import { WorktreeIO, worktreeMode } from './io';
import { EMPTY_TREE, Repo } from './repo';

/** How the review's starting point was chosen; shown to the user in words. */
export type BaseKind = 'lastReview' | 'branchStart' | 'unpushed' | 'uncommitted' | 'picked' | 'empty' | 'terminal';

export interface BaseChoice {
  /** Commit whose content the review starts from. */
  base: string;
  kind: BaseKind;
  /** Branch or commit named in the description, e.g. main or origin/main. */
  detail?: string;
  /** Ref the base follows when the branch is rebased onto it or merged with it. */
  upstreamRef?: string;
  /** Merge-base of HEAD and upstreamRef that the base currently sits on. */
  upstream?: string;
}

export interface ReviewState extends BaseChoice {
  version: 1;
  branch: string;
  created: string;
}

export type ChangeStatus = 'M' | 'A' | 'D' | 'T';

export interface FileChange {
  path: string;
  status: ChangeStatus;
}

export interface IndexEntry {
  mode: string;
  sha: string;
}

/** A file's two sides for review, decoded; `binary` when either side is not UTF-8 text or is a link. */
export interface FileTexts {
  binary: boolean;
  oldText: string;
  newText: string;
  hunks: Hunk[];
}

type UndoEntry =
  | { kind: 'index'; label: string; path: string; before: IndexEntry | null; after: IndexEntry | null }
  | { kind: 'worktree'; label: string; path: string; before: string | null; after: string | null; rejection?: string }
  | { kind: 'tree'; label: string; before: string; after: string }
  | { kind: 'batch'; label: string; entries: UndoEntry[] };

export interface RejectInfo {
  path: string;
  /** 1-based first line of the rejected text in the file as it was. */
  line: number;
  removed: string[];
  restored: string[];
  /** The whole file was put back; removed and restored are then empty. */
  wholeFile?: boolean;
}

export interface ReviewHooks {
  /** Called after a change was rejected; returns an id to forget it again on undo. */
  onReject?(info: RejectInfo): Promise<string | undefined>;
  onUnreject?(id: string): Promise<void>;
}

export class StaleChangeError extends Error {
  constructor() {
    super('That change is not there any more; the view was out of date.');
  }
}

export class UndoConflictError extends Error {}

const locks = new Map<string, Promise<unknown>>();

/** Runs fn after every earlier call with the same key has finished. */
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

const MAX_UNDO = 100;

/**
 * The review of one branch in one checkout. Its checklist is a private index
 * file: the content accepted so far. Pending changes are that index against
 * the working tree; accepted changes are the base against that index. Git's
 * own index, HEAD and history are never touched, except by finish(), which
 * may commit the reviewed edits when asked to.
 */
export class Review {
  readonly dir: string;
  readonly stateFile: string;
  readonly indexFile: string;
  readonly undoFile: string;
  readonly checklistRef: string;
  readonly reviewedRef: string;
  private readonly env: Record<string, string>;
  private readonly blobCache = new Map<string, Buffer>();
  private protectedTree?: string;

  constructor(
    readonly repo: Repo,
    readonly branch: string,
    readonly io: WorktreeIO,
    private readonly hooks: ReviewHooks = {},
  ) {
    this.dir = path.join(repo.gitDir, 'second-look');
    const key = encodeURIComponent(branch);
    this.stateFile = path.join(this.dir, `${key}.json`);
    this.indexFile = path.join(this.dir, `${key}.index`);
    this.undoFile = path.join(this.dir, `${key}.undo.json`);
    this.checklistRef = `refs/second-look/${branch}`;
    this.reviewedRef = `refs/reviewed/${branch}`;
    this.env = { GIT_INDEX_FILE: this.indexFile };
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return serialized(this.indexFile, fn);
  }

  // ---- state ------------------------------------------------------------

  async load(): Promise<ReviewState | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as ReviewState;
    } catch {
      return undefined;
    }
  }

  private async saveState(state: ReviewState): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
    await fs.rename(tmp, this.stateFile);
  }

  /** The review state, starting a review with the automatic base when there is none. */
  ensure(): Promise<ReviewState> {
    return this.exclusive(async () => {
      let state = await this.load();
      if (!state) {
        state = await this.startUnlocked(await this.autoBase());
      } else if (!(await exists(this.indexFile))) {
        // the index is a cache of the checklist ref; rebuild it
        const tree = (await this.repo.treeOf(this.checklistRef)) ?? (await this.repo.treeOf(state.base)) ?? EMPTY_TREE;
        await this.readTree(tree);
      }
      return state;
    });
  }

  /** Starts over from the given base; whatever was accepted is dropped. */
  start(choice: BaseChoice): Promise<ReviewState> {
    return this.exclusive(() => this.startUnlocked(choice));
  }

  private async startUnlocked(choice: BaseChoice): Promise<ReviewState> {
    await this.discardUnlocked();
    const state: ReviewState = { version: 1, branch: this.branch, created: new Date().toISOString(), ...choice };
    await fs.mkdir(this.dir, { recursive: true });
    await this.readTree((await this.repo.treeOf(state.base)) ?? EMPTY_TREE);
    await this.saveState(state);
    await this.protect(state);
    return state;
  }

  /** Removes the checklist; the reviewed marker from the last finish stays. */
  discard(): Promise<void> {
    return this.exclusive(() => this.discardUnlocked());
  }

  private async discardUnlocked(): Promise<void> {
    for (const f of [this.stateFile, this.indexFile, this.undoFile]) {
      await fs.rm(f, { force: true });
    }
    await this.repo.run(['update-ref', '-d', this.checklistRef]).catch(() => undefined);
    this.protectedTree = undefined;
  }

  /** Picks the base: the last finished review, else where the branch left main, else unpushed commits, else HEAD. */
  async autoBase(): Promise<BaseChoice> {
    const head = await this.repo.head();
    if (!head) {
      return { base: await this.commitTree(EMPTY_TREE, [], 'Second Look: empty start'), kind: 'empty' };
    }
    const main = await this.followMain();
    const follows = main ? { upstreamRef: main.ref, upstream: main.now } : {};
    const reviewed = await this.repo.resolve(this.reviewedRef);
    if (reviewed) {
      const choice: BaseChoice = { base: reviewed, kind: 'lastReview', ...follows };
      if (main) {
        // carry the reviewed content onto a main the branch was rebased on or merged with since
        const then = await this.repo.mergeBase(reviewed, main.ref);
        if (then && then !== main.now) {
          const carried = await this.carry(reviewed, then, main.now);
          if (carried) {
            choice.base = await this.commitTree(carried.tree, [main.now], 'Second Look: last review carried onto main');
          }
        }
      }
      return choice;
    }
    if (main) {
      if (main.now !== head) {
        return { base: main.now, kind: 'branchStart', detail: main.name, ...follows };
      }
      return { base: head, kind: 'uncommitted', ...follows };
    }
    const up = await this.repo.upstream(this.branch);
    const mb = up ? await this.repo.mergeBase(head, up.ref) : undefined;
    if (up && mb && mb !== head) {
      return { base: mb, kind: 'unpushed', detail: up.name };
    }
    return { base: head, kind: 'uncommitted' };
  }

  /**
   * For a side branch: the main line whose changes the review leaves out, and
   * the merge-base with it now. Undefined on main itself, where new commits
   * are the work under review; following origin/main there would let a push
   * carry unreviewed commits into the base and hide them.
   */
  async followMain(): Promise<{ name: string; ref: string; now: string } | undefined> {
    const def = await this.repo.defaultBranch();
    const head = await this.repo.head();
    if (!def || !head || def.ref === `refs/heads/${this.branch}`) {
      return undefined;
    }
    const now = await this.repo.mergeBase(head, def.ref);
    return now ? { name: def.name, ref: def.ref, now } : undefined;
  }

  /**
   * When the branch now sits on a different merge-base with the line it
   * follows (rebase, merge, pull), moves base and checklist onto it, so
   * changes that came in from there are not shown for review.
   */
  carryIfNeeded(): Promise<{ carried: boolean; conflicts: string[] }> {
    return this.exclusive(async () => {
      const state = await this.load();
      if (!state?.upstreamRef || !state.upstream) {
        return { carried: false, conflicts: [] };
      }
      const head = await this.repo.head();
      const now = head ? await this.repo.mergeBase(head, state.upstreamRef) : undefined;
      if (!now || now === state.upstream) {
        return { carried: false, conflicts: [] };
      }
      const checklist = await this.writeTree();
      const accepted = await this.carry(checklist, state.upstream, now);
      const base = await this.carry(state.base, state.upstream, now);
      if (!accepted || !base) {
        return { carried: false, conflicts: [] };
      }
      state.base = await this.commitTree(base.tree, [now], 'Second Look: review base carried onto main');
      state.upstream = now;
      await this.readTree(accepted.tree);
      await this.saveState(state);
      await this.protect(state);
      return { carried: true, conflicts: accepted.conflicts };
    });
  }

  /**
   * `treeish` moved from `from` onto `to` by a three-way merge of trees. A path
   * where the two sides conflict keeps the treeish's version, so it shows up
   * for review again instead of carrying conflict markers. Undefined when git
   * cannot do it (older than 2.40).
   */
  private async carry(treeish: string, from: string, to: string): Promise<{ tree: string; conflicts: string[] } | undefined> {
    let r;
    try {
      r = await this.repo.git.run(['merge-tree', '--write-tree', '--name-only', '-z', `--merge-base=${from}`, treeish, to], {
        cwd: this.repo.root,
        okCodes: [1],
      });
    } catch {
      return undefined;
    }
    const parts = r.stdout.toString('utf8').split('\0');
    const tree = parts[0].trim();
    if (r.code === 0) {
      return { tree, conflicts: [] };
    }
    const conflicts: string[] = [];
    for (const p of parts.slice(1)) {
      if (p === '') {
        break;
      }
      if (!conflicts.includes(p)) {
        conflicts.push(p);
      }
    }
    const tmp = `${this.indexFile}.carry`;
    const env = { GIT_INDEX_FILE: tmp };
    try {
      await this.repo.run(['read-tree', tree], env);
      for (const p of conflicts) {
        const e = await this.treeEntry(treeish, p);
        if (e) {
          await this.repo.run(['update-index', '-z', '--index-info'], env, `${e.mode} ${e.sha}\t${p}\0`);
        } else {
          await this.repo.run(['update-index', '--force-remove', '--', p], env);
        }
      }
      return { tree: (await this.repo.text(['write-tree'], env)).trim(), conflicts };
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  // ---- reading ----------------------------------------------------------

  private async readTree(tree: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.rm(this.indexFile, { force: true });
    await this.repo.run(['read-tree', tree], this.env);
  }

  private async writeTree(): Promise<string> {
    return (await this.repo.text(['write-tree'], this.env)).trim();
  }

  private async commitTree(tree: string, parents: string[], message: string): Promise<string> {
    const args = ['commit-tree', tree];
    for (const p of parents) {
      args.push('-p', p);
    }
    args.push('-m', message);
    return (await this.repo.text(args)).trim();
  }

  /** Keeps the checklist's objects reachable, so git gc cannot prune them, and lets the index be rebuilt. */
  private async protect(state: ReviewState): Promise<void> {
    const tree = await this.writeTree();
    if (tree === this.protectedTree) {
      return;
    }
    const commit = await this.commitTree(tree, [state.base], `Second Look checklist for ${this.branch}`);
    await this.repo.run(['update-ref', this.checklistRef, commit]);
    this.protectedTree = tree;
  }

  /** Files with changes not accepted yet: the checklist against the working tree. */
  async pending(): Promise<FileChange[]> {
    await this.repo.git.run(['update-index', '-q', '--refresh'], { cwd: this.repo.root, env: this.env, okCodes: [1] });
    const out = await this.repo.zList(['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=dirty'], this.env);
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      changes.push({ path: out[i + 1], status: out[i][0] as ChangeStatus });
    }
    for (const p of await this.repo.zList(['ls-files', '-z', '--others', '--exclude-standard'], this.env)) {
      changes.push({ path: p, status: 'A' });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Files with accepted changes: the base against the checklist. */
  async accepted(state: ReviewState): Promise<FileChange[]> {
    const out = await this.repo.zList(['diff', '--cached', '--name-status', '-z', '--no-renames', '--no-ext-diff', state.base], this.env);
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      changes.push({ path: out[i + 1], status: out[i][0] as ChangeStatus });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Checklist entries of many paths at once. */
  async indexEntries(paths: string[]): Promise<Map<string, IndexEntry>> {
    const result = new Map<string, IndexEntry>();
    for (let i = 0; i < paths.length; i += 200) {
      const out = await this.repo.zList(['ls-files', '-s', '-z', '--', ...paths.slice(i, i + 200)], this.env);
      for (const line of out) {
        const m = /^(\d+) ([0-9a-f]+) \d+\t(.*)$/s.exec(line);
        if (m) {
          result.set(m[3], { mode: m[1], sha: m[2] });
        }
      }
    }
    return result;
  }

  async indexEntry(p: string): Promise<IndexEntry | undefined> {
    const out = await this.repo.zList(['ls-files', '-s', '-z', '--', p], this.env);
    for (const line of out) {
      const m = /^(\d+) ([0-9a-f]+) \d+\t(.*)$/s.exec(line);
      if (m && m[3] === p) {
        return { mode: m[1], sha: m[2] };
      }
    }
    return undefined;
  }

  private async treeEntry(treeish: string, p: string): Promise<IndexEntry | undefined> {
    const out = await this.repo.zList(['ls-tree', '-z', treeish, '--', p]);
    for (const line of out) {
      const m = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(line);
      if (m && m[3] === p) {
        return { mode: m[1], sha: m[2] };
      }
    }
    return undefined;
  }

  baseEntry(state: ReviewState, p: string): Promise<IndexEntry | undefined> {
    return this.treeEntry(state.base, p);
  }

  /** A blob as it would be checked out at path p (smudge filters and line endings applied). */
  async blob(e: IndexEntry, p: string): Promise<Buffer> {
    if (e.mode === '160000') {
      return Buffer.from(`Subproject commit ${e.sha}\n`);
    }
    const key = `${e.sha}:${p}`;
    const cached = this.blobCache.get(key);
    if (cached) {
      return cached;
    }
    const out = (await this.repo.run(['cat-file', '--filters', `--path=${p}`, e.sha])).stdout;
    if (this.blobCache.size > 200) {
      this.blobCache.clear();
    }
    this.blobCache.set(key, out);
    return out;
  }

  /** The accepted version of a file (empty when it does not exist in the checklist). */
  async checklistContent(p: string): Promise<Buffer> {
    const e = await this.indexEntry(p);
    return e ? this.blob(e, p) : Buffer.alloc(0);
  }

  async baseContent(state: ReviewState, p: string): Promise<Buffer> {
    const e = await this.baseEntry(state, p);
    return e ? this.blob(e, p) : Buffer.alloc(0);
  }

  private static texts(oldE: IndexEntry | undefined, oldBuf: Buffer, newE: { mode: string } | undefined, newBuf: Buffer): FileTexts {
    const link = (e: { mode: string } | undefined) => e?.mode === '120000' || e?.mode === '160000';
    const oldText = decodeText(oldBuf);
    const newText = decodeText(newBuf);
    if (link(oldE) || link(newE) || oldText === undefined || newText === undefined) {
      return { binary: true, oldText: '', newText: '', hunks: [] };
    }
    return { binary: false, oldText, newText, hunks: computeHunks(oldText, newText) };
  }

  private async worktreeEntry(p: string): Promise<{ mode: string } | undefined> {
    try {
      return { mode: await worktreeMode(this.repo.abs(p)) };
    } catch {
      return undefined;
    }
  }

  /**
   * Checklist against the working tree; `current` is an editor's unsaved text
   * for the file, `entry` its checklist entry when already known (null: none).
   */
  async pendingTexts(p: string, current?: string, entry?: IndexEntry | null): Promise<FileTexts> {
    const e = entry === undefined ? await this.indexEntry(p) : (entry ?? undefined);
    const oldBuf = e ? await this.blob(e, p) : Buffer.alloc(0);
    const newBuf = current !== undefined ? Buffer.from(current, 'utf8') : ((await this.io.read(p)) ?? Buffer.alloc(0));
    return Review.texts(e, oldBuf, await this.worktreeEntry(p), newBuf);
  }

  /** Base against the checklist. */
  async acceptedTexts(state: ReviewState, p: string): Promise<FileTexts> {
    const b = await this.baseEntry(state, p);
    const e = await this.indexEntry(p);
    return Review.texts(b, b ? await this.blob(b, p) : Buffer.alloc(0), e, e ? await this.blob(e, p) : Buffer.alloc(0));
  }

  // ---- changing the checklist and the working tree -----------------------

  private async setEntry(p: string, e: IndexEntry | null): Promise<void> {
    if (e) {
      await this.repo.run(['update-index', '--add', '-z', '--index-info'], this.env, `${e.mode} ${e.sha}\t${p}\0`);
    } else {
      await this.repo.run(['update-index', '--force-remove', '--', p], this.env);
    }
  }

  /** Stores text as a blob the way git would store the file at path p (clean filters applied). */
  private async hashText(text: string, p: string): Promise<string> {
    return (await this.repo.run(['hash-object', '-w', '--stdin', `--path=${p}`], undefined, Buffer.from(text, 'utf8'))).stdout.toString('utf8').trim();
  }

  /** Stores exact bytes, for undoing working-tree changes. */
  private async hashRaw(buf: Buffer, write: boolean): Promise<string> {
    const args = ['hash-object', '--no-filters', '--stdin'];
    if (write) {
      args.splice(1, 0, '-w');
    }
    return (await this.repo.run(args, undefined, buf)).stdout.toString('utf8').trim();
  }

  private async rawBlob(sha: string): Promise<Buffer> {
    return (await this.repo.run(['cat-file', 'blob', sha])).stdout;
  }

  private async requireState(): Promise<ReviewState> {
    const s = await this.load();
    if (!s) {
      throw new Error('No review is open on this branch.');
    }
    return s;
  }

  acceptHunk(p: string, key: HunkKey): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.requireState();
      const t = await this.pendingTexts(p);
      const h = findHunk(t.hunks, key);
      if (!h) {
        throw new StaleChangeError();
      }
      const before = (await this.indexEntry(p)) ?? null;
      const result = applyHunk(t.oldText, h);
      let after: IndexEntry | null = null;
      if (result.length > 0 || (await this.io.read(p)) !== undefined) {
        const mode = before?.mode ?? (await this.worktreeEntry(p))?.mode ?? '100644';
        after = { mode, sha: await this.hashText(result, p) };
      }
      await this.setEntry(p, after);
      await this.pushUndo({ kind: 'index', label: `accept a change in ${p}`, path: p, before, after });
      await this.protect(state);
    });
  }

  /**
   * Makes `text` the accepted version of file p: what the diff editor's gutter
   * buttons hand over, the accepted text with one block or selection applied.
   */
  acceptContent(p: string, text: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.requireState();
      const before = (await this.indexEntry(p)) ?? null;
      let after: IndexEntry | null = null;
      if (text.length > 0 || (await this.io.read(p)) !== undefined) {
        const mode = before?.mode ?? (await this.worktreeEntry(p))?.mode ?? '100644';
        after = { mode, sha: await this.hashText(text, p) };
      }
      await this.setEntry(p, after);
      await this.pushUndo({ kind: 'index', label: `accept a change in ${p}`, path: p, before, after });
      await this.protect(state);
    });
  }

  unacceptHunk(p: string, key: HunkKey): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.requireState();
      const t = await this.acceptedTexts(state, p);
      const h = findHunk(t.hunks, key);
      if (!h) {
        throw new StaleChangeError();
      }
      const before = (await this.indexEntry(p)) ?? null;
      const baseE = await this.baseEntry(state, p);
      const result = revertHunk(t.newText, h);
      let after: IndexEntry | null = null;
      if (result.length > 0 || baseE) {
        const mode = before?.mode ?? baseE?.mode ?? '100644';
        after = { mode, sha: await this.hashText(result, p) };
      }
      await this.setEntry(p, after);
      await this.pushUndo({ kind: 'index', label: `move a change in ${p} back to review`, path: p, before, after });
      await this.protect(state);
    });
  }

  rejectHunk(p: string, key: HunkKey): Promise<void> {
    return this.exclusive(async () => {
      await this.requireState();
      const t = await this.pendingTexts(p);
      const h = findHunk(t.hunks, key);
      if (!h) {
        throw new StaleChangeError();
      }
      const entry = await this.indexEntry(p);
      const prev = await this.io.read(p);
      const before = prev ? await this.hashRaw(prev, true) : null;
      const result = revertHunk(t.newText, h);
      if (!entry && result.length === 0) {
        await this.io.remove(p);
      } else {
        await this.io.write(p, Buffer.from(result, 'utf8'), entry?.mode);
      }
      const now = await this.io.read(p);
      const after = now ? await this.hashRaw(now, false) : null;
      const rejection = await this.hooks.onReject?.({ path: p, line: h.newStart + 1, removed: h.newLines, restored: h.oldLines });
      await this.pushUndo({ kind: 'worktree', label: `reject a change in ${p}`, path: p, before, after, rejection });
    });
  }

  acceptFile(p: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.requireState();
      const before = (await this.indexEntry(p)) ?? null;
      await this.repo.run(['add', '-A', '--', p], this.env);
      const after = (await this.indexEntry(p)) ?? null;
      await this.pushUndo({ kind: 'index', label: `accept ${p}`, path: p, before, after });
      await this.protect(state);
    });
  }

  unacceptFile(p: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.requireState();
      const before = (await this.indexEntry(p)) ?? null;
      const after = (await this.baseEntry(state, p)) ?? null;
      await this.setEntry(p, after);
      await this.pushUndo({ kind: 'index', label: `move ${p} back to review`, path: p, before, after });
      await this.protect(state);
    });
  }

  rejectFile(p: string): Promise<void> {
    return this.exclusive(async () => {
      await this.requireState();
      await this.pushUndo(await this.rejectFileUnlocked(p));
    });
  }

  private async rejectFileUnlocked(p: string): Promise<UndoEntry> {
    const entry = await this.indexEntry(p);
    if (entry?.mode === '160000') {
      throw new Error(`${p} is a submodule; check out its commit in the submodule to reject the change.`);
    }
    const prev = await this.io.read(p);
    const before = prev ? await this.hashRaw(prev, true) : null;
    if (!entry) {
      await this.io.remove(p);
    } else if (entry.mode === '120000') {
      await this.repo.run(['checkout-index', '-f', '--', p], this.env);
    } else {
      await this.io.write(p, await this.blob(entry, p), entry.mode);
    }
    const now = await this.io.read(p);
    const after = now ? await this.hashRaw(now, false) : null;
    const rejection = await this.hooks.onReject?.({ path: p, line: 1, removed: [], restored: [], wholeFile: true });
    return { kind: 'worktree', label: `reject ${p}`, path: p, before, after, rejection };
  }

  acceptAll(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.requireState();
      const before = await this.writeTree();
      await this.repo.run(['add', '-A', '--', '.'], this.env);
      const after = await this.writeTree();
      await this.pushUndo({ kind: 'tree', label: 'accept everything', before, after });
      await this.protect(state);
    });
  }

  /** Rejects every pending file; one undo step brings them all back. */
  rejectAll(): Promise<void> {
    return this.exclusive(async () => {
      await this.requireState();
      const entries: UndoEntry[] = [];
      for (const f of await this.pending()) {
        entries.push(await this.rejectFileUnlocked(f.path));
      }
      if (entries.length > 0) {
        await this.pushUndo({ kind: 'batch', label: 'reject everything', entries });
      }
    });
  }

  // ---- undo -------------------------------------------------------------

  private async loadUndo(): Promise<UndoEntry[]> {
    try {
      return JSON.parse(await fs.readFile(this.undoFile, 'utf8')) as UndoEntry[];
    } catch {
      return [];
    }
  }

  private async saveUndo(stack: UndoEntry[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.undoFile, JSON.stringify(stack.slice(-MAX_UNDO)));
  }

  private async pushUndo(e: UndoEntry): Promise<void> {
    const stack = await this.loadUndo();
    stack.push(e);
    await this.saveUndo(stack);
  }

  async canUndo(): Promise<string | undefined> {
    const stack = await this.loadUndo();
    return stack[stack.length - 1]?.label;
  }

  /** Undoes the last accept or reject; returns its description. */
  undo(): Promise<string | undefined> {
    return this.exclusive(async () => {
      const state = await this.requireState();
      const stack = await this.loadUndo();
      const e = stack[stack.length - 1];
      if (!e) {
        return undefined;
      }
      await this.checkUndo(e);
      await this.applyUndo(e);
      stack.pop();
      await this.saveUndo(stack);
      await this.protect(state);
      return e.label;
    });
  }

  private async checkUndo(e: UndoEntry): Promise<void> {
    const same = (a: IndexEntry | null | undefined, b: IndexEntry | null) => (a?.mode ?? null) === (b?.mode ?? null) && (a?.sha ?? null) === (b?.sha ?? null);
    switch (e.kind) {
      case 'index':
        if (!same(await this.indexEntry(e.path), e.after)) {
          throw new UndoConflictError(`Cannot undo "${e.label}": the checklist for ${e.path} changed since.`);
        }
        return;
      case 'worktree': {
        const now = await this.io.read(e.path);
        const hash = now ? await this.hashRaw(now, false) : null;
        if (hash !== e.after) {
          throw new UndoConflictError(`Cannot undo "${e.label}": ${e.path} was edited since.`);
        }
        return;
      }
      case 'tree':
        if ((await this.writeTree()) !== e.after) {
          throw new UndoConflictError(`Cannot undo "${e.label}": the checklist changed since.`);
        }
        return;
      case 'batch':
        for (const c of e.entries) {
          await this.checkUndo(c);
        }
        return;
    }
  }

  private async applyUndo(e: UndoEntry): Promise<void> {
    switch (e.kind) {
      case 'index':
        await this.setEntry(e.path, e.before);
        return;
      case 'worktree':
        if (e.before) {
          await this.io.write(e.path, await this.rawBlob(e.before));
        } else {
          await this.io.remove(e.path);
        }
        if (e.rejection) {
          await this.hooks.onUnreject?.(e.rejection);
        }
        return;
      case 'tree':
        await this.readTree(e.before);
        return;
      case 'batch':
        for (const c of [...e.entries].reverse()) {
          await this.applyUndo(c);
        }
        return;
    }
  }

  // ---- finishing ----------------------------------------------------------

  /** Whether the working tree differs from HEAD (tracked or new files). */
  async hasUncommitted(): Promise<boolean> {
    const out = await this.repo.zList(['status', '--porcelain', '-z', '--untracked-files=all']);
    return out.length > 0;
  }

  /**
   * Ends the review when nothing is pending: optionally commits everything
   * uncommitted as one commit, then records the reviewed content in
   * refs/reviewed/<branch> (HEAD itself when it matches, the same marker
   * the git-review command line tool uses) and removes the checklist.
   */
  finish(opts: { commitMessage?: string }): Promise<{ reviewed: string; committed?: string }> {
    return this.exclusive(async () => {
      await this.requireState();
      if ((await this.pending()).length > 0) {
        throw new Error('There are still changes to review.');
      }
      let committed: string | undefined;
      if (opts.commitMessage && (await this.hasUncommitted())) {
        await this.repo.run(['add', '-A']);
        try {
          await this.repo.run(['commit', '-q', '-m', opts.commitMessage]);
        } catch (e) {
          await this.repo.run(['reset', '-q']).catch(() => undefined);
          throw e;
        }
        committed = await this.repo.head();
      }
      const tree = await this.writeTree();
      const head = await this.repo.head();
      let reviewed: string;
      if (head && (await this.repo.treeOf(head)) === tree) {
        reviewed = head;
      } else {
        reviewed = await this.commitTree(tree, head ? [head] : [], `Reviewed state of ${this.branch}\n\nRecorded by Second Look; this commit is not on any branch.`);
      }
      await this.repo.run(['update-ref', this.reviewedRef, reviewed]);
      await this.discardUnlocked();
      return { reviewed, committed };
    });
  }

  // ---- the git-review command line tool -----------------------------------

  /** A review the git-review command line tool has open in this checkout, if any. */
  async terminalReview(): Promise<{ branch: string; state: 'open' | 'paused' | 'rebase' } | undefined> {
    const marker = path.join(this.repo.gitDir, 'review-active');
    let state: 'open' | 'paused' | 'rebase';
    if (await exists(`${marker}.rebase`)) {
      state = 'rebase';
    } else if (await exists(marker)) {
      state = 'open';
    } else if (await exists(`${marker}.paused`)) {
      state = 'paused';
    } else {
      return undefined;
    }
    // while paused or rebasing, the tool keeps its marker as review-active.paused
    const text = await fs.readFile(state === 'open' ? marker : `${marker}.paused`, 'utf8').catch(() => '');
    return { branch: /^branch (.*)$/m.exec(text)?.[1] ?? '', state };
  }

  /**
   * Moves an open or paused git-review command line review into this
   * extension: its checklist becomes ours, git's index is put back to HEAD
   * and the tool's markers are removed, as `git review abort` would.
   */
  takeOverTerminalReview(): Promise<ReviewState> {
    return this.exclusive(async () => {
      const marker = path.join(this.repo.gitDir, 'review-active');
      if (await exists(`${marker}.rebase`)) {
        throw new Error('The terminal review is paused for a rebase; finish the rebase first.');
      }
      const open = await exists(marker);
      const file = open ? marker : `${marker}.paused`;
      const text = await fs.readFile(file, 'utf8');
      const field = (k: string) => new RegExp(`^${k} (.*)$`, 'm').exec(text)?.[1];
      if (field('branch') !== this.branch) {
        throw new Error(`The terminal review is on ${field('branch')}, not on ${this.branch}.`);
      }
      const baseRaw = field('base');
      if (!baseRaw) {
        throw new Error('Cannot read the terminal review.');
      }
      const parked = `refs/review-index/${this.branch}`;
      const checklist = open ? (await this.repo.text(['write-tree'])).trim() : await this.repo.treeOf(parked);
      if (!checklist) {
        throw new Error('Cannot find the terminal review checklist.');
      }
      const head = await this.repo.head();
      const upstream = field('upstream');
      let base = await this.repo.resolve(baseRaw);
      if (!base) {
        // after a carry the tool records a tree
        base = await this.commitTree(baseRaw, [upstream ?? head ?? ''].filter((x) => x), 'Second Look: base of a terminal review');
      }
      const main = await this.followMain();
      await this.discardUnlocked();
      const state: ReviewState = {
        version: 1,
        branch: this.branch,
        created: new Date().toISOString(),
        base,
        kind: 'terminal',
        upstreamRef: main?.ref,
        upstream: main?.now,
      };
      await this.readTree(checklist);
      await this.saveState(state);
      await this.protect(state);
      if (open) {
        await this.repo.run(['read-tree', 'HEAD']);
      }
      for (const f of [marker, `${marker}.paused`]) {
        await fs.rm(f, { force: true });
      }
      await this.repo.run(['update-ref', '-d', parked]).catch(() => undefined);
      return state;
    });
  }
}

export function isGitError(e: unknown): e is GitError {
  return e instanceof GitError;
}
