import * as path from 'node:path';
import { Git } from './git';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** One checkout: a repository's main working tree or one of its linked worktrees. */
export class Repo {
  private constructor(
    readonly git: Git,
    /** Top of the working tree. */
    readonly root: string,
    /** Per-worktree git directory. */
    readonly gitDir: string,
    /** Directory shared by all worktrees (refs, objects). */
    readonly commonDir: string,
  ) {}

  /** The checkout containing `dir`, or undefined when it is not inside a git working tree. */
  static async open(git: Git, dir: string): Promise<Repo | undefined> {
    const r = await git.run(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], {
      cwd: dir,
      okCodes: [128],
    });
    if (r.code !== 0) {
      return undefined;
    }
    const [root, gitDir, common] = r.stdout.toString('utf8').split('\n');
    if (!root || !gitDir || !common) {
      return undefined;
    }
    // --git-common-dir may be relative to the directory git ran in
    const commonDir = path.isAbsolute(common) ? common : path.resolve(dir, common);
    return new Repo(git, root, gitDir, commonDir);
  }

  run(args: string[], env?: Record<string, string>, input?: string | Buffer) {
    return this.git.run(args, { cwd: this.root, env, input });
  }

  text(args: string[], env?: Record<string, string>) {
    return this.git.text(args, { cwd: this.root, env });
  }

  line(args: string[], env?: Record<string, string>) {
    return this.git.line(args, { cwd: this.root, env });
  }

  zList(args: string[], env?: Record<string, string>) {
    return this.git.zList(args, { cwd: this.root, env });
  }

  /** The checked-out branch; undefined on a detached HEAD. */
  branch(): Promise<string | undefined> {
    return this.line(['symbolic-ref', '--short', '-q', 'HEAD']);
  }

  /** The commit HEAD points to; undefined before the first commit. */
  head(): Promise<string | undefined> {
    return this.line(['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  }

  resolve(rev: string): Promise<string | undefined> {
    return this.line(['rev-parse', '-q', '--verify', `${rev}^{commit}`]);
  }

  treeOf(rev: string): Promise<string | undefined> {
    return this.line(['rev-parse', '-q', '--verify', `${rev}^{tree}`]);
  }

  mergeBase(a: string, b: string): Promise<string | undefined> {
    return this.line(['merge-base', a, b]);
  }

  /** The repository's main line: origin's default branch, else a local main or master. */
  async defaultBranch(): Promise<{ name: string; ref: string } | undefined> {
    const origin = await this.line(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
    if (origin) {
      const name = origin.replace(/^refs\/remotes\/origin\//, '');
      if (await this.resolve(`refs/heads/${name}`)) {
        return { name, ref: `refs/heads/${name}` };
      }
      return { name, ref: origin };
    }
    for (const name of ['main', 'master']) {
      if (await this.resolve(`refs/heads/${name}`)) {
        return { name, ref: `refs/heads/${name}` };
      }
    }
    return undefined;
  }

  /** The branch's upstream, like origin/main; undefined when none is configured. */
  async upstream(branch: string): Promise<{ name: string; ref: string } | undefined> {
    const ref = await this.line(['rev-parse', '-q', '--symbolic-full-name', `${branch}@{upstream}`]);
    if (!ref) {
      return undefined;
    }
    return { name: ref.replace(/^refs\/remotes\//, ''), ref };
  }

  async userName(): Promise<string> {
    return (await this.line(['config', 'user.name'])) ?? 'You';
  }

  /** Absolute path of a repository-relative path. */
  abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  /** Repository-relative path with forward slashes, or undefined outside the working tree. */
  rel(abs: string): string | undefined {
    const r = path.relative(this.root, abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) {
      return undefined;
    }
    return r.split(path.sep).join('/');
  }
}
