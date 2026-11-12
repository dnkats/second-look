import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { engine, git, mkrepo, write, read, remove, commitAll, openReview, lines, replaceLine, pendingPaths, acceptedPaths } from './helpers.mjs';

const { hunkKey } = engine;

/** main with three files; branch feature where an agent changed them. */
function agentBranch() {
  const dir = mkrepo({ 'a.txt': lines(30), 'c.txt': 'to be deleted\n', 'keep.txt': 'unchanged\n' });
  git(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, 'a.txt', replaceLine(replaceLine(lines(30), 3, 'three\n'), 25, 'twenty-five\n'));
  write(dir, 'b.txt', 'new file\n');
  remove(dir, 'c.txt');
  commitAll(dir, 'agent work');
  return dir;
}

test('a side branch is reviewed from where it left main', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  const s = await r.ensure();
  assert.equal(s.kind, 'branchStart');
  assert.equal(s.detail, 'main');
  assert.equal(s.base, git(dir, 'rev-parse', 'main'));
  assert.deepEqual(await pendingPaths(r), ['M a.txt', 'A b.txt', 'D c.txt']);
  assert.deepEqual(await acceptedPaths(r), []);
  // git's own index and status are untouched
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a checkout is not reviewed until started: nothing written, comments do not count; old reviews count', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  const store = path.join(dir, '.git', 'second-look');
  assert.equal(await r.started(), false);
  assert.equal(existsSync(store), false);
  write(dir, '.git/second-look/comments.json', '{"version":1,"threads":[]}\n');
  assert.equal(await r.started(), false);
  await r.markStarted();
  assert.equal(await r.started(), true);
  // a review started some other way marks the checkout too
  const other = await openReview(agentBranch());
  await other.start(await other.autoBase());
  assert.equal(existsSync(other.startedFile), true);
  // reviewed before the marker existed: a branch's state file is there
  rmSync(other.startedFile);
  assert.equal(await other.started(), true);
});

test('a worktree of a repository reviewed elsewhere counts as started, also from before the marker', async () => {
  const dir = agentBranch();
  const wt = `${dir}-wt`;
  git(dir, 'worktree', 'add', '-q', '-b', 'other', wt);
  const r = await openReview(dir);
  const w = await openReview(wt);
  assert.equal(await w.started(), false);
  await r.start(await r.autoBase());
  assert.equal(await w.started(), true);
  rmSync(r.startedFile);
  assert.equal(await w.started(), true);
  // the worktree's own review keeps its files apart from the main checkout's
  await w.ensure();
  assert.notEqual(w.dir, r.dir);
  assert.equal(existsSync(w.stateFile), true);
});

test('rejecting a block given by its lines, as the diff gutter hands it over', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  const block = { oldStart: 24, oldCount: 1, newStart: 24, newCount: 1, oldLines: ['line 25\n'], newLines: ['twenty-five\n'] };
  // lines that are not in the file any more: the diff was stale
  await assert.rejects(r.rejectBlock('a.txt', { ...block, newLines: ['something else\n'] }), engine.StaleChangeError);
  await r.rejectBlock('a.txt', block);
  assert.equal(read(dir, 'a.txt'), replaceLine(lines(30), 3, 'three\n'));
  assert.equal(await r.undo(), 'reject a change in a.txt');
  assert.equal(read(dir, 'a.txt'), replaceLine(replaceLine(lines(30), 3, 'three\n'), 25, 'twenty-five\n'));
});

test('refreshing the list and accepting at the same time do not trip over the index lock', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  for (let i = 0; i < 10; i++) {
    const [h] = (await r.pendingTexts('a.txt')).hunks;
    // the list refreshes while a change is accepted and moved back, as file watchers make it do
    await Promise.all([r.pending(), r.acceptHunk('a.txt', hunkKey(h)), r.pending()]);
    const s = await r.load();
    const [back] = (await r.acceptedTexts(s, 'a.txt')).hunks;
    await Promise.all([r.pending(), r.unacceptHunk('a.txt', hunkKey(back)), r.pending()]);
  }
  assert.equal((await r.pendingTexts('a.txt')).hunks.length, 2);
});

test('an index locked by another git process for a moment: the accept waits and goes through', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  const [h] = (await r.pendingTexts('a.txt')).hunks;
  const lock = r.indexFile + '.lock';
  writeFileSync(lock, '');
  setTimeout(() => rmSync(lock), 150);
  await r.acceptHunk('a.txt', hunkKey(h));
  assert.equal((await r.pendingTexts('a.txt')).hunks.length, 1);
});

test('accepting, rejecting and moving back single hunks', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  let t = await r.pendingTexts('a.txt');
  assert.equal(t.hunks.length, 2);
  const [h1, h2] = t.hunks;

  await r.acceptHunk('a.txt', hunkKey(h1));
  t = await r.pendingTexts('a.txt');
  assert.equal(t.hunks.length, 1);
  assert.deepEqual(t.hunks[0].newLines, ['twenty-five\n']);
  assert.deepEqual(await acceptedPaths(r), ['M a.txt']);

  await r.rejectHunk('a.txt', hunkKey(t.hunks[0]));
  assert.equal(read(dir, 'a.txt'), replaceLine(lines(30), 3, 'three\n'));
  assert.ok(!(await pendingPaths(r)).includes('M a.txt'));

  // undo the reject: the agent's line is back and pending again
  assert.equal(await r.undo(), 'reject a change in a.txt');
  assert.equal(read(dir, 'a.txt'), replaceLine(replaceLine(lines(30), 3, 'three\n'), 25, 'twenty-five\n'));
  assert.ok((await pendingPaths(r)).includes('M a.txt'));

  // move the accepted hunk back to review
  const s = await r.load();
  const acc = await r.acceptedTexts(s, 'a.txt');
  assert.equal(acc.hunks.length, 1);
  await r.unacceptHunk('a.txt', hunkKey(acc.hunks[0]));
  assert.equal((await r.pendingTexts('a.txt')).hunks.length, 2);
  assert.deepEqual(await acceptedPaths(r), []);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('new and deleted files are accepted whole and can be moved back', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  await r.acceptFile('b.txt');
  await r.acceptFile('c.txt');
  assert.deepEqual(await pendingPaths(r), ['M a.txt']);
  assert.deepEqual(await acceptedPaths(r), ['A b.txt', 'D c.txt']);
  await r.unacceptFile('c.txt');
  assert.deepEqual(await pendingPaths(r), ['M a.txt', 'D c.txt']);
  // accepting a deletion hunk-wise removes the file from the checklist
  const t = await r.pendingTexts('c.txt');
  assert.equal(t.hunks.length, 1);
  await r.acceptHunk('c.txt', hunkKey(t.hunks[0]));
  assert.deepEqual(await acceptedPaths(r), ['A b.txt', 'D c.txt']);
});

test('rejecting a new file removes it; undo brings it back', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  await r.rejectFile('b.txt');
  assert.equal(read(dir, 'b.txt'), undefined);
  await r.rejectFile('c.txt');
  assert.equal(read(dir, 'c.txt'), 'to be deleted\n');
  await r.undo();
  assert.equal(read(dir, 'c.txt'), undefined);
  await r.undo();
  assert.equal(read(dir, 'b.txt'), 'new file\n');
});

test('an agent edit after accepting shows up as a new pending change only', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  await r.acceptAll();
  assert.deepEqual(await pendingPaths(r), []);
  write(dir, 'a.txt', replaceLine(read(dir, 'a.txt'), 10, 'ten\n'));
  const t = await r.pendingTexts('a.txt');
  assert.equal(t.hunks.length, 1);
  assert.deepEqual(t.hunks[0].newLines, ['ten\n']);
  // undo of accept-all puts everything back to pending
  await r.undo();
  assert.deepEqual(await pendingPaths(r), ['M a.txt', 'A b.txt', 'D c.txt']);
});

test('finishing without a commit records the reviewed content; the next review starts there', async () => {
  const dir = agentBranch();
  write(dir, 'a.txt', replaceLine(read(dir, 'a.txt'), 12, 'my review edit\n'));
  const r = await openReview(dir);
  await r.ensure();
  await r.acceptAll();
  const { reviewed, committed } = await r.finish({});
  assert.equal(committed, undefined);
  assert.equal(git(dir, 'rev-parse', 'refs/reviewed/feature'), reviewed);
  // the edit is still uncommitted, and the reviewed commit is not on the branch
  assert.notEqual(reviewed, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(git(dir, 'rev-parse', `${reviewed}^`), git(dir, 'rev-parse', 'HEAD'));
  assert.ok(!existsSync(r.stateFile));
  assert.throws(() => git(dir, 'show-ref', '--verify', '-q', 'refs/second-look/feature'));

  const r2 = await openReview(dir);
  const s2 = await r2.ensure();
  assert.equal(s2.kind, 'lastReview');
  assert.deepEqual(await pendingPaths(r2), []);
  write(dir, 'keep.txt', 'agent changed this\n');
  commitAll(dir, 'more agent work');
  assert.deepEqual(await pendingPaths(r2), ['M keep.txt']);
});

test('finishing with a commit commits everything reviewed and marks HEAD', async () => {
  const dir = agentBranch();
  write(dir, 'a.txt', replaceLine(read(dir, 'a.txt'), 12, 'my review edit\n'));
  const r = await openReview(dir);
  await r.ensure();
  await r.acceptAll();
  const { reviewed, committed } = await r.finish({ commitMessage: 'Review edits on feature' });
  assert.equal(committed, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(reviewed, committed);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'Review edits on feature');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('finish refuses while changes are pending', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  await assert.rejects(r.finish({}), /still changes to review/);
});

test('on main with an upstream, the review covers unpushed commits, and later commits after a finish', async () => {
  const origin = mkrepo({ 'x.txt': lines(10) });
  const dir = path.join(path.dirname(origin), path.basename(origin) + '-clone');
  git(path.dirname(origin), 'clone', '-q', origin, dir);
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.com');
  write(dir, 'x.txt', replaceLine(lines(10), 2, 'two\n'));
  commitAll(dir, 'agent on main');
  const r = await openReview(dir);
  const s = await r.ensure();
  assert.equal(s.kind, 'unpushed');
  assert.equal(s.detail, 'origin/main');
  assert.deepEqual(await pendingPaths(r), ['M x.txt']);
  await r.acceptAll();
  await r.finish({});
  // the agent commits again on main: only the new change is pending
  write(dir, 'x.txt', replaceLine(read(dir, 'x.txt'), 7, 'seven\n'));
  commitAll(dir, 'more agent work on main');
  const r2 = await openReview(dir);
  assert.equal((await r2.ensure()).kind, 'lastReview');
  const t = await r2.pendingTexts('x.txt');
  assert.equal(t.hunks.length, 1);
  assert.deepEqual(t.hunks[0].newLines, ['seven\n']);
});

test('on main without an upstream the review starts at HEAD and keeps later commits pending', async () => {
  const dir = mkrepo({ 'x.txt': lines(10) });
  const r = await openReview(dir);
  const s = await r.ensure();
  assert.equal(s.kind, 'uncommitted');
  write(dir, 'x.txt', replaceLine(lines(10), 4, 'four\n'));
  commitAll(dir, 'agent commit');
  assert.deepEqual(await pendingPaths(r), ['M x.txt']);
});

test('a rebase onto an updated main carries the checklist: main\'s changes are not pending, accepted stays accepted', async () => {
  const dir = mkrepo({ 'a.txt': lines(30), 'm.txt': lines(5, 'main') });
  git(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, 'a.txt', replaceLine(replaceLine(lines(30), 3, 'three\n'), 25, 'twenty-five\n'));
  commitAll(dir, 'agent');
  const r = await openReview(dir);
  await r.ensure();
  const [h1] = (await r.pendingTexts('a.txt')).hunks;
  await r.acceptHunk('a.txt', hunkKey(h1));

  git(dir, 'checkout', '-q', 'main');
  write(dir, 'm.txt', replaceLine(lines(5, 'main'), 2, 'main moved\n'));
  commitAll(dir, 'main moves on');
  git(dir, 'checkout', '-q', 'feature');
  git(dir, 'rebase', '-q', 'main');

  const before = await pendingPaths(r);
  assert.deepEqual(before, ['M a.txt', 'M m.txt']);
  const res = await r.carryIfNeeded();
  assert.equal(res.carried, true);
  assert.deepEqual(res.conflicts, []);
  assert.deepEqual(await pendingPaths(r), ['M a.txt']);
  const t = await r.pendingTexts('a.txt');
  assert.equal(t.hunks.length, 1);
  assert.deepEqual(t.hunks[0].newLines, ['twenty-five\n']);
  assert.deepEqual(await acceptedPaths(r), ['M a.txt']);
});

test('line endings: CRLF files are compared and stored the way git stores them', async () => {
  const dir = mkrepo({ '.gitattributes': '*.txt text eol=crlf\n', 'w.txt': lines(10) });
  // a fresh checkout writes CRLF; the repository keeps LF
  remove(dir, 'w.txt');
  git(dir, 'checkout', '--', 'w.txt');
  assert.ok(read(dir, 'w.txt').includes('\r\n'));
  git(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, 'w.txt', read(dir, 'w.txt').replace('line 4\r\n', 'four\r\n'));
  commitAll(dir, 'agent');
  const r = await openReview(dir);
  await r.ensure();
  assert.deepEqual(await pendingPaths(r), ['M w.txt']);
  const t = await r.pendingTexts('w.txt');
  assert.equal(t.hunks.length, 1);
  assert.deepEqual(t.hunks[0].newLines, ['four\r\n']);
  await r.acceptHunk('w.txt', hunkKey(t.hunks[0]));
  assert.deepEqual(await pendingPaths(r), []);
  // the accepted blob has LF, like git's own
  const sha = (await r.indexEntry('w.txt')).sha;
  assert.equal(sha, git(dir, 'rev-parse', 'HEAD:w.txt'));
});

test('binary files are reviewed as whole files', async () => {
  const dir = mkrepo({ 'bin.dat': Buffer.from([1, 2, 0, 3]) });
  git(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, 'bin.dat', Buffer.from([1, 2, 0, 4]));
  const r = await openReview(dir);
  await r.ensure();
  const t = await r.pendingTexts('bin.dat');
  assert.equal(t.binary, true);
  await r.rejectFile('bin.dat');
  assert.deepEqual([...readFileSync(path.join(dir, 'bin.dat'))], [1, 2, 0, 3]);
});

test('undo refuses when the file changed since', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  const [h1] = (await r.pendingTexts('a.txt')).hunks;
  await r.rejectHunk('a.txt', hunkKey(h1));
  write(dir, 'a.txt', read(dir, 'a.txt') + 'edited after\n');
  await assert.rejects(r.undo(), engine.UndoConflictError);
});

test('reject hooks see the rejected lines and are told about undo', async () => {
  const dir = agentBranch();
  const seen = [];
  const r = await openReview(dir, {
    async onReject(info) {
      seen.push(info);
      return 'r1';
    },
    async onUnreject(id) {
      seen.push(`undo ${id}`);
    },
  });
  await r.ensure();
  const [h1] = (await r.pendingTexts('a.txt')).hunks;
  await r.rejectHunk('a.txt', hunkKey(h1));
  await r.undo();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { path: 'a.txt', line: 3, removed: ['three\n'], restored: ['line 3\n'] });
  assert.equal(seen[1], 'undo r1');
});

test('each branch keeps its own review; switching back finds it as left', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  await r.acceptFile('b.txt');
  git(dir, 'checkout', '-q', 'main');
  const onMain = await openReview(dir);
  assert.equal((await onMain.ensure()).kind, 'uncommitted');
  assert.deepEqual(await pendingPaths(onMain), []);
  git(dir, 'checkout', '-q', 'feature');
  const back = await openReview(dir);
  await back.ensure();
  assert.deepEqual(await acceptedPaths(back), ['A b.txt']);
});

test('the index file is rebuilt from the checklist ref when it is missing', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  await r.acceptFile('b.txt');
  remove(dir, path.relative(dir, r.indexFile));
  const again = await openReview(dir);
  await again.ensure();
  assert.deepEqual(await acceptedPaths(again), ['A b.txt']);
});

const cli = path.join(process.env.HOME ?? '', 'projects/git-review/git-review');

test('an open git-review command line review can be taken over', { skip: !existsSync(cli) }, async () => {
  const dir = agentBranch();
  git(dir, 'config', 'core.hooksPath', '.git/hooks');
  const env = { ...process.env, PATH: `${path.dirname(cli)}:${process.env.PATH}` };
  const { execFileSync } = await import('node:child_process');
  execFileSync(cli, ['start'], { cwd: dir, env, encoding: 'utf8' });
  git(dir, 'add', 'b.txt');
  const r = await openReview(dir);
  const t = await r.terminalReview();
  assert.deepEqual(t, { branch: 'feature', state: 'open' });
  const s = await r.takeOverTerminalReview();
  assert.equal(s.kind, 'terminal');
  assert.deepEqual(await acceptedPaths(r), ['A b.txt']);
  assert.deepEqual(await pendingPaths(r), ['M a.txt', 'D c.txt']);
  assert.equal(await r.terminalReview(), undefined);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a carry conflict keeps the file as reviewed so main\'s change in it comes up for review', async () => {
  const dir = mkrepo({ 'a.txt': lines(10) });
  git(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, 'a.txt', replaceLine(lines(10), 2, 'feature two\n'));
  commitAll(dir, 'agent');
  const r = await openReview(dir);
  await r.ensure();
  await r.acceptAll();
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'a.txt', replaceLine(lines(10), 2, 'main two\n'));
  commitAll(dir, 'main');
  git(dir, 'checkout', '-q', 'feature');
  // the replayed feature commit wins the conflict
  git(dir, 'rebase', '-q', '-X', 'theirs', 'main');
  assert.equal(read(dir, 'a.txt'), replaceLine(lines(10), 2, 'feature two\n'));
  const res = await r.carryIfNeeded();
  assert.equal(res.carried, true);
  assert.deepEqual(res.conflicts, ['a.txt']);
  // what was accepted is still the feature line, and nothing new is pending in a.txt
  assert.deepEqual(await pendingPaths(r), []);
  assert.deepEqual(await acceptedPaths(r), ['M a.txt']);
});

test('on main, pushing unreviewed commits keeps them pending', async () => {
  const origin = mkrepo({ 'x.txt': lines(20) });
  git(origin, 'checkout', '-q', '--detach');
  const dir = path.join(path.dirname(origin), path.basename(origin) + '-push');
  git(path.dirname(origin), 'clone', '-q', origin, dir);
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.com');
  write(dir, 'x.txt', replaceLine(replaceLine(lines(20), 2, 'two\n'), 15, 'fifteen\n'));
  commitAll(dir, 'agent on main');
  const r = await openReview(dir);
  assert.equal((await r.ensure()).kind, 'unpushed');
  const [h1] = (await r.pendingTexts('x.txt')).hunks;
  await r.acceptHunk('x.txt', hunkKey(h1));
  git(dir, 'push', '-q', 'origin', 'main');
  assert.deepEqual(await r.carryIfNeeded(), { carried: false, conflicts: [] });
  const t = await r.pendingTexts('x.txt');
  assert.equal(t.hunks.length, 1);
  assert.deepEqual(t.hunks[0].newLines, ['fifteen\n']);
});

test('accepting given content (the diff gutter\'s Accept Block) takes one block, and undo puts it back', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  const t = await r.pendingTexts('a.txt');
  await r.acceptContent('a.txt', engine.applyHunk(t.oldText, t.hunks[1]));
  const left = await r.pendingTexts('a.txt');
  assert.equal(left.hunks.length, 1);
  assert.deepEqual(left.hunks[0].newLines, ['three\n']);
  await r.undo();
  assert.equal((await r.pendingTexts('a.txt')).hunks.length, 2);
});

test('undo survives git gc: what the undo steps put back stays reachable', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  const [h1, h2] = (await r.pendingTexts('a.txt')).hunks;
  await r.acceptHunk('a.txt', hunkKey(h1));
  // the half-accepted a.txt is then only in the undo step of the second accept
  await r.acceptHunk('a.txt', hunkKey(h2));
  // the rejected new file is only in its undo step
  await r.rejectFile('b.txt');
  await r.acceptAll();
  git(dir, 'gc', '-q', '--prune=now');
  for (let i = 0; i < 4; i++) {
    assert.ok(await r.undo());
  }
  assert.equal(read(dir, 'b.txt'), 'new file\n');
  assert.deepEqual(await pendingPaths(r), ['M a.txt', 'A b.txt', 'D c.txt']);
  assert.deepEqual(await acceptedPaths(r), []);
});

test('an undo step whose content git gc already took is refused with a message; newer steps still work', async () => {
  const dir = agentBranch();
  const r = await openReview(dir);
  await r.ensure();
  // a step from before undo content was kept, pointing at a pruned blob
  writeFileSync(r.undoFile, JSON.stringify([{ kind: 'worktree', label: 'reject x.txt', path: 'x.txt', before: '1'.repeat(40), after: null }]));
  await r.acceptFile('b.txt');
  assert.equal(await r.undo(), 'accept b.txt');
  await assert.rejects(r.undo(), (e) => e instanceof engine.UndoConflictError && /git gc removed/.test(e.message));
});
