import { diffArrays } from 'diff';

/**
 * A block of consecutive changed lines between an old and a new text.
 * Starts are 0-based line indices; a pure insertion has oldCount 0 and a
 * pure deletion newCount 0.
 */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  oldLines: string[];
  newLines: string[];
}

/** Identifies a hunk across recomputations: its content, plus a position hint for identical hunks. */
export interface HunkKey {
  hash: string;
  newStart: number;
}

/** Splits text into lines that keep their terminators, so joining gives the text back. */
export function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

const MAX_EDIT_LENGTH = 20000;

export function computeHunks(oldText: string, newText: string): Hunk[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // trimming the common head and tail keeps the diff small for typical edits
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if (am.length === 0 && bm.length === 0) {
    return [];
  }
  const changes = diffArrays(am, bm, { maxEditLength: MAX_EDIT_LENGTH });
  if (!changes) {
    return [{ oldStart: head, oldCount: am.length, newStart: head, newCount: bm.length, oldLines: am, newLines: bm }];
  }
  const hunks: Hunk[] = [];
  let i = head;
  let j = head;
  let cur: Hunk | undefined;
  for (const c of changes) {
    if (!c.added && !c.removed) {
      if (cur) {
        hunks.push(cur);
        cur = undefined;
      }
      i += c.count;
      j += c.count;
      continue;
    }
    if (!cur) {
      cur = { oldStart: i, oldCount: 0, newStart: j, newCount: 0, oldLines: [], newLines: [] };
    }
    if (c.removed) {
      cur.oldLines.push(...c.value);
      cur.oldCount += c.count;
      i += c.count;
    } else {
      cur.newLines.push(...c.value);
      cur.newCount += c.count;
      j += c.count;
    }
  }
  if (cur) {
    hunks.push(cur);
  }
  return hunks;
}

/** The old text with one hunk taken over from the new text. */
export function applyHunk(oldText: string, h: Hunk): string {
  const a = splitLines(oldText);
  return [...a.slice(0, h.oldStart), ...h.newLines, ...a.slice(h.oldStart + h.oldCount)].join('');
}

/** The new text with one hunk put back to the old text. */
export function revertHunk(newText: string, h: Hunk): string {
  const b = splitLines(newText);
  return [...b.slice(0, h.newStart), ...h.oldLines, ...b.slice(h.newStart + h.newCount)].join('');
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function hunkKey(h: Hunk): HunkKey {
  return { hash: fnv1a(h.oldLines.join('') + '\u0000' + h.newLines.join('')), newStart: h.newStart };
}

/** The hunk with the key's content, nearest to its position. */
export function findHunk(hunks: Hunk[], key: HunkKey): Hunk | undefined {
  let best: Hunk | undefined;
  for (const h of hunks) {
    if (hunkKey(h).hash !== key.hash) {
      continue;
    }
    if (!best || Math.abs(h.newStart - key.newStart) < Math.abs(best.newStart - key.newStart)) {
      best = h;
    }
  }
  return best;
}

/** The hunk covering a 0-based line of the new text; a deletion covers the line it sits before. */
export function hunkAtLine(hunks: Hunk[], line: number): Hunk | undefined {
  for (const h of hunks) {
    const end = h.newStart + Math.max(h.newCount, 1);
    if (line >= h.newStart && line < end) {
      return h;
    }
  }
  return undefined;
}

/** Heuristic git also uses: a NUL byte near the start means binary. */
export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

// ignoreBOM keeps a byte order mark in the text, so writing the text back keeps it too
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Decodes UTF-8 text; undefined for binary or other encodings, which are reviewed as whole files. */
export function decodeText(buf: Buffer): string | undefined {
  if (isBinary(buf)) {
    return undefined;
  }
  try {
    return utf8.decode(buf);
  } catch {
    return undefined;
  }
}
