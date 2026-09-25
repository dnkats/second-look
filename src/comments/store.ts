import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Review comments live in one JSON file in the checkout's git directory, so
 * they are never part of the working tree, and both the editor and the
 * agent's command line tool read and write them.
 */

/** Where a comment points: 1-based inclusive lines and their text without line endings. */
export interface Anchor {
  start: number;
  end: number;
  lines: string[];
  before?: string;
  after?: string;
}

/** exact: the lines are where they were; moved: found elsewhere; outdated: gone. */
export type AnchorState = 'exact' | 'moved' | 'outdated';

export interface Entry {
  id: string;
  role: 'user' | 'agent';
  author: string;
  text: string;
  at: string;
  /** Set once the agent has listed it. */
  delivered?: boolean;
}

export interface Thread {
  id: string;
  path: string;
  status: 'open' | 'resolved';
  created: string;
  /** Lines and code when the comment was written. */
  original: { start: number; end: number; code: string[] };
  anchor: Anchor & { state: AnchorState };
  entries: Entry[];
}

export interface Rejection {
  id: string;
  path: string;
  line: number;
  removed: string[];
  restored: string[];
  wholeFile?: boolean;
  at: string;
  delivered?: boolean;
}

export interface StoreData {
  version: 1;
  next: number;
  threads: Thread[];
  rejections: Rejection[];
}

const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 5000;

function empty(): StoreData {
  return { version: 1, next: 1, threads: [], rejections: [] };
}

export class CommentStore {
  constructor(readonly file: string) {}

  static forGitDir(gitDir: string): CommentStore {
    return new CommentStore(path.join(gitDir, 'git-review', 'comments.json'));
  }

  async read(): Promise<StoreData> {
    try {
      const d = JSON.parse(await fs.readFile(this.file, 'utf8')) as StoreData;
      d.threads ??= [];
      d.rejections ??= [];
      d.next ??= 1;
      return d;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return empty();
      }
      throw e;
    }
  }

  /** Reads, changes and writes the store under a lock shared with other processes. */
  async update<T>(fn: (d: StoreData) => T | Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    await acquire(lock);
    try {
      const d = await this.read();
      const result = await fn(d);
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(d, null, 1) + '\n');
      await fs.rename(tmp, this.file);
      return result;
    } finally {
      await fs.rm(lock, { recursive: true, force: true });
    }
  }
}

async function acquire(lock: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(lock);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw e;
      }
      const st = await fs.stat(lock).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // left behind by a process that died
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`The comment store is locked: ${lock}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export function newId(d: StoreData, prefix: string): string {
  return `${prefix}${d.next++}`;
}

/** Lines of a text without their endings; a final newline does not start another line. */
export function textLines(text: string): string[] {
  const ls = text.split(/\r?\n/);
  if (ls.length > 0 && ls[ls.length - 1] === '') {
    ls.pop();
  }
  return ls;
}

/** An anchor for 1-based lines start..end of the file. */
export function makeAnchor(lines: string[], start: number, end: number): Anchor {
  return {
    start,
    end,
    lines: lines.slice(start - 1, end),
    before: start >= 2 ? lines[start - 2] : undefined,
    after: end < lines.length ? lines[end] : undefined,
  };
}

/**
 * Finds the anchored lines in the file as it is now: in place, else the
 * occurrence whose neighbouring lines still match, nearest to the old place.
 * Whitespace changes are tolerated. When the lines are gone the anchor stays
 * where it was, clamped to the file, and is outdated; should the lines come
 * back, it attaches to them again.
 */
export function relocate(a: Anchor, lines: string[]): { start: number; end: number; state: AnchorState } {
  const n = Math.max(a.lines.length, 1);
  const matchAt = (s: number, eq: (x: string, y: string) => boolean) =>
    s >= 1 && s + a.lines.length - 1 <= lines.length && a.lines.every((l, i) => eq(lines[s - 1 + i], l));
  const exact = (x: string, y: string) => x === y;
  const loose = (x: string, y: string) => x.trim() === y.trim();
  if (matchAt(a.start, exact)) {
    return { start: a.start, end: a.start + n - 1, state: 'exact' };
  }
  for (const eq of [exact, loose]) {
    const found: number[] = [];
    for (let s = 1; s + a.lines.length - 1 <= lines.length; s++) {
      if (matchAt(s, eq)) {
        found.push(s);
      }
    }
    if (found.length === 0 || a.lines.every((l) => l.trim() === '')) {
      continue;
    }
    const score = (s: number) =>
      (a.before !== undefined && s >= 2 && eq(lines[s - 2], a.before) ? 1 : 0) +
      (a.after !== undefined && s + n - 1 < lines.length && eq(lines[s + n - 1], a.after) ? 1 : 0);
    found.sort((x, y) => score(y) - score(x) || Math.abs(x - a.start) - Math.abs(y - a.start));
    const s = found[0];
    return { start: s, end: s + n - 1, state: s === a.start ? 'exact' : 'moved' };
  }
  const start = Math.min(Math.max(a.start, 1), Math.max(lines.length, 1));
  return { start, end: Math.min(start + n - 1, Math.max(lines.length, 1)), state: 'outdated' };
}

/** Updates a thread's anchor against the file's current lines; true when something changed. */
export function relocateThread(t: Thread, lines: string[] | undefined): boolean {
  const r = lines ? relocate(t.anchor, lines) : { start: t.anchor.start, end: t.anchor.end, state: 'outdated' as const };
  if (r.start === t.anchor.start && r.end === t.anchor.end && r.state === t.anchor.state) {
    return false;
  }
  t.anchor.start = r.start;
  t.anchor.end = r.end;
  t.anchor.state = r.state;
  return true;
}

/** A rejection as the engine reports it, before it gets an id and a time. */
export type RejectionInput = Omit<Rejection, 'id' | 'at' | 'delivered'>;
