import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Access to working-tree files by repository-relative path. The editor
 * implementation reads open documents and writes through them, so unsaved
 * text is seen and undo works there.
 */
export interface WorktreeIO {
  /** The file's content, or undefined when it does not exist. */
  read(rel: string): Promise<Buffer | undefined>;
  /** Writes the file; `mode` 100755 makes it executable, 100644 not. */
  write(rel: string, content: Buffer, mode?: string): Promise<void>;
  remove(rel: string): Promise<void>;
}

export class FsIO implements WorktreeIO {
  constructor(private readonly root: string) {}

  private abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  async read(rel: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(this.abs(rel));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
        return undefined;
      }
      throw e;
    }
  }

  async write(rel: string, content: Buffer, mode?: string): Promise<void> {
    const file = this.abs(rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    await applyMode(file, mode);
  }

  async remove(rel: string): Promise<void> {
    await fs.rm(this.abs(rel), { force: true });
  }
}

export async function applyMode(file: string, mode: string | undefined): Promise<void> {
  if (mode !== '100755' && mode !== '100644') {
    return;
  }
  const st = await fs.stat(file);
  const exec = (st.mode & 0o111) !== 0;
  if (mode === '100755' && !exec) {
    await fs.chmod(file, st.mode | 0o111);
  } else if (mode === '100644' && exec) {
    await fs.chmod(file, st.mode & ~0o111);
  }
}

/** The git mode a new file would get: symlink, executable or plain. */
export async function worktreeMode(file: string): Promise<string> {
  const st = await fs.lstat(file);
  if (st.isSymbolicLink()) {
    return '120000';
  }
  return (st.mode & 0o111) !== 0 ? '100755' : '100644';
}
