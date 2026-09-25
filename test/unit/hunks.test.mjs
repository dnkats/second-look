import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lines, replaceLine } from './helpers.mjs';

const { computeHunks, applyHunk, revertHunk, splitLines, hunkKey, findHunk, hunkAtLine, decodeText } = engine;

test('splitLines keeps terminators and a last line without newline', () => {
  assert.deepEqual(splitLines('a\nb\r\nc'), ['a\n', 'b\r\n', 'c']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('\n'), ['\n']);
});

test('separate edits give separate hunks', () => {
  const a = lines(20);
  const b = replaceLine(replaceLine(a, 3, 'three\n'), 15, 'fifteen\n');
  const hs = computeHunks(a, b);
  assert.equal(hs.length, 2);
  assert.deepEqual([hs[0].oldStart, hs[0].oldCount, hs[0].newStart, hs[0].newCount], [2, 1, 2, 1]);
  assert.deepEqual(hs[1].newLines, ['fifteen\n']);
});

test('applying every hunk to the old text gives the new text, reverting every hunk gives the old', () => {
  const a = lines(30);
  let b = replaceLine(a, 5, 'five\nfive and a half\n');
  b = b.replace('line 20\n', '');
  b = b + 'appended\n';
  const hs = computeHunks(a, b);
  assert.equal(hs.length, 3);
  // apply from the last hunk backwards so earlier positions stay valid
  let x = a;
  for (const h of [...hs].reverse()) {
    x = applyHunk(x, h);
  }
  assert.equal(x, b);
  let y = b;
  for (const h of [...hs].reverse()) {
    y = revertHunk(y, h);
  }
  assert.equal(y, a);
});

test('one hunk at a time: the other hunks stay pending', () => {
  const a = lines(20);
  const b = replaceLine(replaceLine(a, 3, 'three\n'), 15, 'fifteen\n');
  const [h1] = computeHunks(a, b);
  const partial = applyHunk(a, h1);
  const rest = computeHunks(partial, b);
  assert.equal(rest.length, 1);
  assert.deepEqual(rest[0].newLines, ['fifteen\n']);
});

test('missing final newline is a change of its own', () => {
  const hs = computeHunks('a\nb\n', 'a\nb');
  assert.equal(hs.length, 1);
  assert.deepEqual(hs[0].oldLines, ['b\n']);
  assert.deepEqual(hs[0].newLines, ['b']);
});

test('new and deleted files are one hunk each', () => {
  assert.equal(computeHunks('', 'x\ny\n').length, 1);
  assert.equal(computeHunks('x\ny\n', '').length, 1);
  assert.deepEqual(computeHunks('same\n', 'same\n'), []);
});

test('hunk keys find the same content after lines shift', () => {
  const a = lines(20);
  const b = replaceLine(a, 10, 'ten\n');
  const key = hunkKey(computeHunks(a, b)[0]);
  const shifted = 'new first line\n' + b;
  const h = findHunk(computeHunks('new first line\n' + a, shifted), key);
  assert.ok(h);
  assert.equal(h.newStart, 10);
  assert.equal(findHunk(computeHunks(a, replaceLine(a, 10, 'TEN\n')), key), undefined);
});

test('hunkAtLine finds deletions at the line they sit before', () => {
  const a = lines(10);
  const b = a.replace('line 5\n', '');
  const hs = computeHunks(a, b);
  assert.equal(hs[0].newCount, 0);
  assert.equal(hunkAtLine(hs, 4), hs[0]);
  assert.equal(hunkAtLine(hs, 5), undefined);
});

test('decodeText rejects binary and invalid UTF-8 but keeps a BOM', () => {
  assert.equal(decodeText(Buffer.from([0x61, 0x00, 0x62])), undefined);
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x41])), undefined);
  assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), '﻿A');
});
