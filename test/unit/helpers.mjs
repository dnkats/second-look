// Scratch repositories for the engine tests.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const engine = require('../../dist/test/engine.cjs');

export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00', GIT_COMMITTER_DATE: '2026-01-01T00:00:00' },
  }).replace(/\n$/, '');
}

export function mkrepo(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'grv-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [f, c] of Object.entries(files)) {
    write(dir, f, c);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

export function write(dir, f, content) {
  const p = path.join(dir, f);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function read(dir, f) {
  const p = path.join(dir, f);
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
}

export function remove(dir, f) {
  rmSync(path.join(dir, f), { force: true });
}

export function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

export async function openReview(dir, hooks) {
  const g = new engine.Git();
  const repo = await engine.Repo.open(g, dir);
  const branch = await repo.branch();
  return new engine.Review(repo, branch, new engine.FsIO(repo.root), hooks);
}

export function lines(n, prefix = 'line') {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('');
}

/** A text with line k (1-based) replaced. */
export function replaceLine(text, k, replacement) {
  const ls = text.split(/(?<=\n)/);
  ls[k - 1] = replacement;
  return ls.join('');
}

export async function pendingPaths(review) {
  return (await review.pending()).map((f) => `${f.status} ${f.path}`);
}

export async function acceptedPaths(review) {
  const s = await review.load();
  return (await review.accepted(s)).map((f) => `${f.status} ${f.path}`);
}
