# Changelog

## 0.1.1

Accept Block and Accept Selection next to Revert Block in the review diff
(needs VS Code's runtime argument for proposed APIs, see the README). A
title bar button for the next change to review, which continues in the next
file. The view with all changes no longer shows modified files as renamed.
Accept and Reject links show in diffs without any setting: the extension
turns diffEditor.codeLens on by default. Changes of ten lines or more get
the links below them as well (secondLook.codeLensBelow).

## 0.1.0

First version: the Review view, accept, reject, undo and review again per
change or file, lenses and highlights in the editor, Finish, review comments
with the review-comments agent skill, and taking over a git-review terminal
review.
