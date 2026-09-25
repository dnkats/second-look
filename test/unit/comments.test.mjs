import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { engine, mkrepo, write, read, lines, replaceLine, git } from './helpers.mjs';

const { relocate, makeAnchor, textLines, CommentStore, newId } = engine;
const cli = path.resolve('skill/review-comments/scripts/review-comments');

test('an anchor stays, moves with inserted lines, and goes outdated when its lines are gone', () => {
  const file = textLines(lines(20));
  const a = makeAnchor(file, 10, 11);
  assert.deepEqual(relocate(a, file), { start: 10, end: 11, state: 'exact' });
  const shifted = ['new 1', 'new 2', ...file];
  assert.deepEqual(relocate(a, shifted), { start: 12, end: 13, state: 'moved' });
  const gone = file.filter((l) => l !== 'line 10');
  assert.equal(relocate(a, gone).state, 'outdated');
  // whitespace changes are tolerated
  const indented = file.map((l) => '  ' + l);
  assert.deepEqual(relocate(a, indented), { start: 10, end: 11, state: 'exact' });
});

test('with repeated lines, the neighbours decide', () => {
  const file = ['a', 'x', 'b', 'c', 'x', 'd'];
  const a = makeAnchor(file, 5, 5);
  const moved = ['zero', ...file];
  assert.deepEqual(relocate(a, moved), { start: 6, end: 6, state: 'moved' });
});

function addThread(dir, rel, start, end, text) {
  const gitDir = git(dir, 'rev-parse', '--absolute-git-dir');
  const store = CommentStore.forGitDir(gitDir);
  const fileLines = textLines(read(dir, rel));
  return store.update((d) => {
    const id = newId(d, 'c');
    const anchor = makeAnchor(fileLines, start, end);
    d.threads.push({
      id,
      path: rel,
      status: 'open',
      created: new Date().toISOString(),
      original: { start, end, code: anchor.lines },
      anchor: { ...anchor, state: 'exact' },
      entries: [{ id: newId(d, 'e'), role: 'user', author: 'Test User', text, at: new Date().toISOString() }],
    });
    return { id, store };
  });
}

function run(dir, ...args) {
  return execFileSync(cli, args, { cwd: dir, encoding: 'utf8' });
}

test('the agent lists comments with their code, replies, and sees where the code moved', async () => {
  const dir = mkrepo({ 'src/a.jl': lines(30) });
  const { id, store } = await addThread(dir, 'src/a.jl', 5, 6, 'use Val dispatch here');
  write(dir, 'src/a.jl', 'inserted\n' + lines(30));
  const out = run(dir, 'list');
  assert.match(out, new RegExp(`${id}  src/a.jl:6-7`));
  assert.match(out, /code when the comment was written \(lines 5-6, now at 6-7\):/);
  assert.match(out, / 5 \| line 5/);
  assert.match(out, /Test User: use Val dispatch here/);
  run(dir, 'reply', id, '--as', 'Claude', 'Done: switched to Val{:damped}.');
  const d = await store.read();
  const t = d.threads[0];
  assert.equal(t.entries.length, 2);
  assert.deepEqual([t.entries[1].role, t.entries[1].author], ['agent', 'Claude']);
  assert.equal(t.entries[0].delivered, true);
  assert.equal(t.anchor.start, 6);
  const json = JSON.parse(run(dir, 'list', '--json'));
  assert.equal(json.threads[0].entries[1].text, 'Done: switched to Val{:damped}.');
});

test('outdated comments are marked, resolved ones are hidden, rejections are listed once', async () => {
  const dir = mkrepo({ 'a.txt': lines(10) });
  const { store } = await addThread(dir, 'a.txt', 4, 4, 'why?');
  await addThread(dir, 'a.txt', 8, 8, 'fine');
  await store.update((d) => {
    d.threads[1].status = 'resolved';
    d.rejections.push({ id: 'r1', path: 'a.txt', line: 2, removed: ['agent line\n'], restored: ['line 2\n'], at: new Date().toISOString() });
  });
  write(dir, 'a.txt', replaceLine(lines(10), 4, 'changed\n'));
  const out = run(dir, 'list');
  assert.match(out, /a\.txt:4  \[outdated/);
  assert.doesNotMatch(out, /fine/);
  assert.match(out, /rejected in review/);
  assert.match(out, /- agent line/);
  assert.doesNotMatch(run(dir, 'list'), /rejected in review/);
  assert.match(run(dir, 'list', '--all'), /fine/);
});

test('an empty store says so, and unknown ids are errors', () => {
  const dir = mkrepo({ 'a.txt': 'x\n' });
  assert.match(run(dir, 'list'), /No open review comments/);
  assert.throws(() => run(dir, 'reply', 'c9', 'hello'), /no comment c9/);
});

test('concurrent updates do not lose writes', async () => {
  const dir = mkrepo({ 'a.txt': 'x\n' });
  const store = CommentStore.forGitDir(git(dir, 'rev-parse', '--absolute-git-dir'));
  await Promise.all(Array.from({ length: 20 }, () => store.update((d) => { d.next++; })));
  assert.equal((await store.read()).next, 21);
});
