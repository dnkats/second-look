import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const SKILL = 'review-comments';
const MARKER = '.installed-by-git-review';

interface Target {
  label: string;
  detail: string;
  dir: string;
}

/** Skill folders agents read on this machine: Claude Code's, and the shared one Codex, Copilot and others read. */
function targets(): Target[] {
  const home = os.homedir();
  return [
    { label: 'Claude Code', detail: '~/.claude/skills', dir: path.join(home, '.claude', 'skills') },
    { label: 'Codex, GitHub Copilot and other agents', detail: '~/.agents/skills', dir: path.join(home, '.agents', 'skills') },
  ];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copySkill(context: vscode.ExtensionContext, dest: string): Promise<void> {
  const src = path.join(context.extensionPath, 'skill', SKILL);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true });
  await fs.chmod(path.join(dest, 'scripts', 'review-comments'), 0o755);
  // the node that runs this extension, for machines without node on PATH
  await fs.writeFile(path.join(dest, 'scripts', 'node-path'), process.execPath + '\n');
  await fs.writeFile(path.join(dest, MARKER), `${context.extension.packageJSON.version}\n`);
}

/** Whether any agent on this machine has the skill. */
export async function skillInstalled(): Promise<boolean> {
  for (const t of targets()) {
    if (await exists(path.join(t.dir, SKILL, 'SKILL.md'))) {
      return true;
    }
  }
  return false;
}

/** Asks which agents should get the skill, then installs it there. */
export async function installSkill(context: vscode.ExtensionContext): Promise<void> {
  const picks = await vscode.window.showQuickPick(
    targets().map((t) => ({ label: t.label, description: t.detail, picked: true, t })),
    { canPickMany: true, placeHolder: 'Install the review-comments skill for which agents?' },
  );
  if (!picks || picks.length === 0) {
    return;
  }
  for (const { t } of picks) {
    const dest = path.join(t.dir, SKILL);
    if ((await exists(dest)) && !(await exists(path.join(dest, MARKER)))) {
      const ok = await vscode.window.showWarningMessage(`${dest} exists and was not installed by Git Review. Replace it?`, { modal: true }, 'Replace');
      if (ok !== 'Replace') {
        continue;
      }
    }
    await copySkill(context, dest);
  }
  void vscode.window.showInformationMessage('Skill installed. Ask your agent to "check my comments"; new agent sessions pick it up.');
}

/** Keeps skills this extension installed up to date with its version and its node. */
export async function refreshSkills(context: vscode.ExtensionContext): Promise<void> {
  const version = `${context.extension.packageJSON.version}\n`;
  for (const t of targets()) {
    const dest = path.join(t.dir, SKILL);
    const marker = path.join(dest, MARKER);
    if (!(await exists(marker))) {
      continue;
    }
    try {
      if ((await fs.readFile(marker, 'utf8')) !== version) {
        await copySkill(context, dest);
      } else {
        await fs.writeFile(path.join(dest, 'scripts', 'node-path'), process.execPath + '\n');
      }
    } catch {
      // a read-only home or a removed folder is not worth an error
    }
  }
}
