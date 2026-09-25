import type { Rejection, Thread } from './store';

// Plain-text rendering of comments for agents, shared by the command line tool and "Copy as Prompt".

function lineRange(s: number, e: number): string {
  return s === e ? `${s}` : `${s}-${e}`;
}

export function formatThread(t: Thread): string {
  const out: string[] = [];
  let flag = '';
  if (t.anchor.state === 'outdated') {
    flag = '  [outdated: these lines are gone from the file]';
  } else if (t.status === 'resolved') {
    flag = '  [resolved]';
  }
  out.push(`${t.id}  ${t.path}:${lineRange(t.anchor.start, t.anchor.end)}${flag}`);
  const plural = t.original.start === t.original.end ? '' : 's';
  const moved = t.anchor.state !== 'outdated' && t.anchor.start !== t.original.start ? `, now at ${lineRange(t.anchor.start, t.anchor.end)}` : '';
  out.push(`    code when the comment was written (line${plural} ${lineRange(t.original.start, t.original.end)}${moved}):`);
  const width = String(t.original.end).length;
  t.original.code.forEach((c, i) => out.push(`      ${String(t.original.start + i).padStart(width)} | ${c}`));
  for (const e of t.entries) {
    const body = e.text.split('\n').join('\n      ');
    out.push(`    ${e.author}${e.role === 'agent' ? ' (agent)' : ''}: ${body}`);
  }
  return out.join('\n');
}

export function formatRejection(r: Rejection): string {
  if (r.wholeFile) {
    return `  ${r.path}: the whole file was put back to its reviewed version`;
  }
  const out = [`  ${r.path} line ${r.line}:`];
  if (r.removed.length > 0) {
    out.push('    removed:');
    r.removed.forEach((l) => out.push(`      - ${l.replace(/\r?\n$/, '')}`));
  }
  if (r.restored.length > 0) {
    out.push('    put back:');
    r.restored.forEach((l) => out.push(`      + ${l.replace(/\r?\n$/, '')}`));
  }
  return out.join('\n');
}
