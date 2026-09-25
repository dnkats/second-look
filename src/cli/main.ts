// review-comments: the agent's side of Git Review's code comments.
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { CommentStore, Thread, newId, relocateThread, textLines } from '../comments/store';
import { formatRejection, formatThread } from '../comments/format';

const USAGE = `review-comments: read and answer the review comments left in VS Code (Git Review)

  review-comments list [--all] [--peek] [--json]
      Open comments with file, lines, the code they were written on and the
      conversation, plus changes the user rejected since the last list.
      --all includes resolved comments; --peek does not mark anything as read.
  review-comments reply <id> [--as <name>] <text>
      Adds a reply to a comment thread (text "-" reads it from stdin).
  review-comments show <id> [--json]

Run it inside the repository, or pass --repo <dir>.`;

interface Args {
  cmd: string;
  rest: string[];
  flags: Map<string, string | true>;
}

function parse(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo' || a === '--as') {
      flags.set(a, argv[++i] ?? '');
    } else if (a.startsWith('--') || a === '-h') {
      flags.set(a, true);
    } else {
      rest.push(a);
    }
  }
  return { cmd: rest.shift() ?? 'list', rest, flags };
}

function repoPaths(dir: string): { root: string; gitDir: string } {
  const out = execFileSync('git', ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd: dir, encoding: 'utf8' });
  const [root, gitDir] = out.split('\n');
  return { root, gitDir };
}

async function fileLines(root: string, rel: string): Promise<string[] | undefined> {
  try {
    return textLines(await fs.readFile(path.join(root, ...rel.split('/')), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Relocates threads against the files as they are now. */
async function refreshAnchors(root: string, threads: Thread[]): Promise<void> {
  for (const t of threads) {
    relocateThread(t, await fileLines(root, t.path));
  }
}

async function list(store: CommentStore, root: string, args: Args): Promise<void> {
  const all = args.flags.has('--all');
  const peek = args.flags.has('--peek');
  const result = await store.update(async (d) => {
    const threads = d.threads.filter((t) => all || t.status === 'open');
    await refreshAnchors(root, threads);
    const rejections = d.rejections.filter((r) => !r.delivered);
    if (!peek) {
      for (const t of threads) {
        for (const e of t.entries) {
          e.delivered = true;
        }
      }
      for (const r of rejections) {
        r.delivered = true;
      }
    }
    return { threads: structuredClone(threads), rejections: structuredClone(rejections) };
  });
  if (args.flags.has('--json')) {
    console.log(JSON.stringify({ repo: root, ...result }, null, 1));
    return;
  }
  const { threads, rejections } = result;
  if (threads.length === 0 && rejections.length === 0) {
    console.log(`No open review comments in ${root}.`);
    return;
  }
  console.log(`Review comments in ${root} (${threads.length} ${all ? 'in total' : 'open'})\n`);
  for (const t of threads) {
    console.log(formatThread(t) + '\n');
  }
  if (rejections.length > 0) {
    console.log('Changes the user rejected in review since you last checked (do not put them back):');
    for (const r of rejections) {
      console.log(formatRejection(r));
    }
    console.log('');
  }
  if (threads.length > 0) {
    console.log('Reply to each comment you handled: review-comments reply <id> "<what you did, or your answer>"');
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function reply(store: CommentStore, args: Args): Promise<void> {
  const [id, ...words] = args.rest;
  if (!id) {
    throw new Error('usage: review-comments reply <id> <text>');
  }
  let text = words.join(' ');
  if (text === '-') {
    text = await readStdin();
  }
  text = text.trim();
  if (!text) {
    throw new Error('the reply is empty');
  }
  const as = args.flags.get('--as');
  const author = typeof as === 'string' && as ? as : 'Agent';
  await store.update((d) => {
    const t = d.threads.find((x) => x.id === id);
    if (!t) {
      throw new Error(`no comment ${id}; run review-comments list`);
    }
    t.entries.push({ id: newId(d, 'e'), role: 'agent', author, text, at: new Date().toISOString(), delivered: true });
  });
  console.log(`Replied to ${id}.`);
}

async function show(store: CommentStore, root: string, args: Args): Promise<void> {
  const id = args.rest[0];
  const t = await store.update(async (d) => {
    const found = d.threads.find((x) => x.id === id);
    if (!found) {
      throw new Error(`no comment ${id}`);
    }
    await refreshAnchors(root, [found]);
    return structuredClone(found);
  });
  console.log(args.flags.has('--json') ? JSON.stringify(t, null, 1) : formatThread(t));
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (args.cmd === 'help' || args.flags.has('--help') || args.flags.has('-h')) {
    console.log(USAGE);
    return;
  }
  const repoFlag = args.flags.get('--repo');
  const { root, gitDir } = repoPaths(typeof repoFlag === 'string' ? repoFlag : process.cwd());
  const store = CommentStore.forGitDir(gitDir);
  switch (args.cmd) {
    case 'list':
      return list(store, root, args);
    case 'reply':
      return reply(store, args);
    case 'show':
      return show(store, root, args);
    default:
      throw new Error(`unknown command ${args.cmd}\n\n${USAGE}`);
  }
}

main().catch((e: Error) => {
  console.error(`review-comments: ${e.message}`);
  process.exit(1);
});
