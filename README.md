# Second Look

Review what your coding agent changed, one change at a time: accept it,
reject it, edit it, or leave a comment the agent reads and answers. Second
Look keeps its own checklist, so you don't stage, commit or pick branches for
any of this, and the next review shows only what changed since the last one.

![A file to review, with Accept and Reject above each change](docs/review-diff.png)

## Getting started

1. Install Second Look from the Extensions view, or run
   `code --install-extension dnkats.second-look`.
2. Open the repository your agent worked in, click the Second Look icon in
   the activity bar and press **Start Review**. Until then Second Look shows
   nothing and writes nothing in that repository.
3. Go through the changes: **Alt+F5** jumps to the next one (on into the next
   file), **Alt+Y** accepts it, **Alt+N** rejects it and puts back the text
   you had accepted. The same actions are links above each change and buttons
   in the list. Edit freely; your own edits are changes to accept like any
   other. **Undo** takes back accepts and rejects.
4. When the list is empty, **Finish Review**. It can commit what is still
   uncommitted, and the next review starts from here.

On a side branch the review covers everything since the branch left main; on
main, the commits not pushed yet (without an upstream, what changes after you
start); after a finished review, what came since; uncommitted changes always. **Review From…** in the view's `...` menu starts
from any commit instead.

### Accept and reject buttons in the diff gutter

Optional: Second Look can put Accept Block and Reject Block
next to VS Code's Revert Block in the diff. They use a VS Code API still in
preview, which VS Code allows only for extensions you name. Run
**Preferences: Configure Runtime Arguments**, add

```
"enable-proposed-api": ["dnkats.second-look"]
```

inside the braces of the file that opens (with a comma after the entry before
it), then quit VS Code and start it again. With Remote-SSH, WSL or a dev
container this is the file on your own computer. Without it, the diffs show
Accept and Reject links instead.

## Comments for the agent

![The file with highlighted changes and a comment the agent answered](docs/editor-and-comment.png)

Click `+` next to a line number, or select lines first, to leave a comment
(if VS Code offers a choice, pick **Add comment for the agent (Second
Look)**). When you ask your agent to "check my comments",
it reads them with the code they were written on, does what they say and
answers in the thread. It also learns which of its changes you rejected.

The agent learns this from a skill: run **Second Look: Install Agent Skill…**
once. It works with Claude Code, Codex, GitHub Copilot and other agents that
read Agent Skills; VS Code's own chat gets it automatically. For other agents,
**Copy Open Comments as Prompt** puts the comments on the clipboard.

## Good to know

- Everything stays in the repository's `.git`; Second Look sends nothing over
  the network and never touches git's own index.
- It works locally and over Remote-SSH, WSL and dev containers, where it runs
  on the remote side. It needs VS Code 1.90 or newer and git.
- **Pause Review** in the view's `...` menu hides the review in a window
  without losing it.
- In files with many changes, `"diffEditor.diffAlgorithm": "legacy"` makes VS
  Code redraw the diff after each accept several times faster.

[The guide](docs/guide.md) has the details: every command, what a review
covers on rebases and pulls, where the state lives, the limitations, the
settings and how to build and release.
