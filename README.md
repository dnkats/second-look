# Second Look

Review what a coding agent changed, one change at a time: accept it, reject
it, edit it, or leave a comment the agent reads later. When you are through,
finish the review; the next one shows only what changed since. You do not
stage, commit or pick branches for any of this.

![A file to review, with Accept and Reject above each change](docs/review-diff.png)

## How it works

The Second Look icon in the activity bar opens the list of changes still to
review, file by file, with every change inside a file listed under it. The
line at the top says what the list covers, for example "Changes on damping
since it left main".

Click a file or a change to open it in a diff: on the left the text you have
accepted so far, on the right the file as it is now. For every change you can

- **accept** it: it counts as reviewed and leaves the list,
- **reject** it: the text you had accepted goes back into the file,
- **edit** the file: your own edits are changes like any other; accept them
  when they look right.

The buttons are on the rows of the list, in the diff's title bar (for the
change at the cursor), as Accept and Reject links above each change in the
diff and in the editor (below long changes too), and on the keys Alt+Y
(accept) and Alt+N (reject). The circled arrow in the title bar, or Alt+J,
goes to the next change to review, on into the next file; Alt+K goes back. In
the ordinary editor the lines still to review are highlighted.

In the diff, VS Code shows its own buttons next to the change under the
cursor or the mouse: Revert Block, which rejects, and from Second Look Accept
Block (Accept Selection when lines are selected). VS Code shows Accept Block
only once you allow it, because it uses an API that is still in preview: run
**Preferences: Configure Runtime Arguments**, add

```
"enable-proposed-api": ["dnkats.second-look"]
```

to the file that opens, and restart VS Code. With Remote-SSH this is the file
on your own computer, where the VS Code window runs.

Accepted changes are listed under **Accepted**; **Review Again** puts one back
on the list. **Undo** in the view's title bar takes back the last accept or
reject, several steps deep, also after a restart.

New edits, by the agent or by you, show up in the list as they happen, and
commits change nothing about what you see: the review compares what you
accepted with the files as they are.

**Finish Review** (the double check mark) ends the review once nothing is
left. It can commit whatever is uncommitted as one "Review edits on
&lt;branch&gt;" commit or leave it as it is; it asks the first time. The next
review starts from what you finished with.

![The file with highlighted changes and a comment the agent answered](docs/editor-and-comment.png)

## Comments for the agent

Hover a line number and click `+`, or select lines first, to leave a comment.
If another extension offers comments on that line too, VS Code first shows a
menu; pick **Add comment for the agent (Second Look)**. Comments stay on their
lines when the file changes and say so when the code they were on is gone.
They are yours until you ask the agent to "check my comments": it then lists
them, with the code each one was written on, does what they say and answers in
the thread. It also learns which of its changes you rejected, so it does not
put them back. You resolve threads when you are satisfied.

The agent learns this from a skill that ships with the extension. Install it
once with **Second Look: Install Agent Skill…**; it goes to `~/.claude/skills`
(Claude Code) and `~/.agents/skills` (Codex, GitHub Copilot and other agents
that read Agent Skills), on the machine where the extension runs. VS Code's own
chat gets it automatically. The skill's command is
`review-comments list | reply <id> <text>`; it needs Node.js, and uses the one
that runs VS Code when there is none on the PATH. For an agent without skills,
**Copy Open Comments as Prompt** puts them on the clipboard.

## What a review covers

Nothing needs to be chosen by hand. For the branch you are on, the review
covers:

- after a finished review: everything since then;
- the first time on a side branch: everything since it left main (or master);
- the first time on main: the commits not pushed yet, if main has an upstream,
  otherwise everything from the moment the review started;

and always the uncommitted changes. **Review From…** in the view's menu starts
over from any commit instead. When you rebase a side branch onto a newer main,
or merge main into it, the review moves along: what came from main does not
show up for review, and what you accepted stays accepted. A file where main's
changes conflict with the review is shown for review again. On main itself the
review does not follow origin, so a push never hides unreviewed commits;
changes you pull show up for review too.

Each branch has its own review. Switch branches, come back, and it is as you
left it.

## Install

The extension runs where your files are: locally, or on the remote machine in
a Remote-SSH, WSL or dev-container window. Install the `.vsix` from the
Extensions view's `…` menu (Install from VSIX), or in the window's terminal:

```
code --install-extension second-look-0.1.2.vsix
```

Requirements: VS Code 1.90 or newer and git on the PATH (or in `git.path`).
Moving a review along a rebase needs git 2.40 or newer; with an older git,
main's changes show up for review after a rebase.

## Where the state lives

Everything is inside the checkout's git directory and never touches git's own
index, the staging area:

- `.git/second-look/<branch>.json`, `.index` and `.undo.json`: the review in
  progress (the index file holds what you accepted),
- `.git/second-look/comments.json`: the comments,
- `refs/second-look/<branch>`: keeps the accepted content safe from
  `git gc`,
- `refs/reviewed/<branch>`: where the last finished review ended.

Delete those and the extension has never been there.

## With the git-review command line tool

This extension grew out of [git-review](https://github.com/dnkats/git-review),
which uses git's index as the checklist. Both record a finished review in
`refs/reviewed/<branch>`, so either one continues where the other finished.
When a terminal review is open in the checkout, the view offers to take it
over: what you accepted there stays accepted, and git's index goes back to
normal.

## Limitations

- If the agent works in its own worktree or clone, open that folder to review
  it.
- VS Code's Source Control view keeps showing git's own changes (uncommitted
  against HEAD). They differ from the review list whenever the agent has
  committed.
- To show its Accept and Reject links in diffs, Second Look turns VS Code's
  `diffEditor.codeLens` on by default. Links of other extensions then show in
  diffs too; set `diffEditor.codeLens` to `false` to turn them all off.
- Accept Block uses a proposed VS Code API: it needs the runtime argument
  above, and an extension using it cannot be published on the Marketplace as
  it is.
- Binary files, renames (a deletion plus a new file), submodules and changes of
  the file mode are accepted or rejected as whole files.
- One person reviews a checkout at a time.

## Settings

- `secondLook.finish.commitEdits`: `ask`, `always` or `never` commit
  uncommitted changes when finishing.
- `secondLook.codeLens`, `secondLook.highlightChanges`, `secondLook.statusBar`:
  turn the links, the line highlights and the status bar count off.
- `secondLook.codeLensBelow`: changes of at least this many lines (10) get
  the Accept and Reject links below them too; 0 turns that off.

## Development

```
npm install
npm test               # engine and comment tests on scratch repositories
npm run test:vscode    # the extension in a real VS Code, headless via Xvfb
npm run package        # builds second-look-<version>.vsix
node test/vscode/demo.mjs shots   # screenshots of the UI
```

Both VS Code runs use `/usr/share/code/code` unless `VSCODE_PATH` names
another VS Code; the screenshot script also reads `GRV_SCREEN` (screen size)
and `GRV_SETTINGS` (extra settings as JSON).

The engine (`src/engine`) and the comment store (`src/comments/store.ts`) do
not depend on VS Code; the agent's command (`src/cli`) is built into the
skill folder.
