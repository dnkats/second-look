---
name: review-comments
description: Read and answer the code review comments the user left in VS Code with the Second Look extension, and see which changes they rejected. Use when the user asks you to check, read, look at or address their comments, review comments or review feedback.
license: MIT
metadata:
  source: https://github.com/dnkats/second-look
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/review-comments *)
---

# Review comments

The user reviews your changes in VS Code with the Second Look extension and
leaves comments on lines of code. The comments are stored in the repository's
git directory. This skill's `scripts/review-comments` command reads and
answers them. In Claude Code the command is
`${CLAUDE_SKILL_DIR}/scripts/review-comments`; for other agents it is
`scripts/review-comments` inside this skill's directory
(`scripts\review-comments.cmd` on Windows).

1. In the repository, run `review-comments list`. For every open comment it
   prints an id, the file and the lines where that code is now, the code as it
   was when the comment was written, and the conversation so far. It also
   lists changes the user rejected in review since you last looked.
2. Treat each comment as the user's request or question about that code.
   Make the change or answer the question. If a comment is marked outdated,
   its lines have changed since; use the quoted code to see what it meant.
3. After handling a comment, reply to it:
   `review-comments reply <id> "<what you changed, or your answer>"`.
   Keep replies short and name other files you touched. Use `--as <your name>`
   to sign the reply.
4. Do not put rejected changes back unless the user asks for them again.
5. Never resolve or delete comments and never edit the files under the git
   directory yourself; the user resolves threads in VS Code.

`review-comments list --json` gives the same information as JSON, and
`review-comments --help` shows all options.
