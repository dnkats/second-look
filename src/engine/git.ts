import { spawn } from 'node:child_process';

export interface GitRunOptions {
  cwd: string;
  env?: Record<string, string>;
  input?: string | Buffer;
  /** Exit codes that are not errors, besides 0. */
  okCodes?: number[];
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
  }
}

/** Runs the git binary. All output is raw bytes; callers decode. */
export class Git {
  constructor(readonly path = 'git') {}

  run(args: string[], opts: GitRunOptions): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.path, args, {
        cwd: opts.cwd,
        env: {
          ...process.env,
          // stable messages, no pager or prompts, no optional locks on the real index
          LC_ALL: 'C',
          GIT_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          // paths are file names, never glob patterns
          GIT_LITERAL_PATHSPECS: '1',
          ...opts.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', reject);
      child.on('close', (code) => {
        const result = { stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), code: code ?? -1 };
        if (result.code === 0 || opts.okCodes?.includes(result.code)) {
          resolve(result);
        } else {
          reject(new GitError(args, result.code, result.stderr));
        }
      });
      child.stdin.on('error', () => {
        // git may exit before reading all input; the exit code tells what happened
      });
      if (opts.input !== undefined) {
        child.stdin.end(opts.input);
      } else {
        child.stdin.end();
      }
    });
  }

  async text(args: string[], opts: GitRunOptions): Promise<string> {
    return (await this.run(args, opts)).stdout.toString('utf8');
  }

  /** stdout with the trailing newline removed; undefined when git exits with an allowed non-zero code. */
  async line(args: string[], opts: GitRunOptions): Promise<string | undefined> {
    const r = await this.run(args, { ...opts, okCodes: opts.okCodes ?? [1, 128] });
    if (r.code !== 0) {
      return undefined;
    }
    return r.stdout.toString('utf8').replace(/\r?\n$/, '');
  }

  /** NUL-separated output, empty entries dropped. */
  async zList(args: string[], opts: GitRunOptions): Promise<string[]> {
    const t = await this.text(args, opts);
    return t.split('\0').filter((s) => s.length > 0);
  }
}

export async function gitVersion(git: Git, cwd: string): Promise<[number, number]> {
  const v = await git.text(['--version'], { cwd });
  const m = /(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}
