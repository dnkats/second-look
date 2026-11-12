# Changelog

## 0.2.2

Repositories in subfolders of the opened folder are reviewed too: the ones
that VS Code's Source Control finds there, including ones cloned or created
after the window opened. Before, Second Look looked only at the repository
the opened folder itself is in, and a folder holding several repositories
showed "Open a folder that is a git repository". Refresh looks for new
repositories as well.

With more than one repository, a Repositories view above the review lists
them, as in Source Control. The review view, now called Changes, stays empty
until one is chosen there, then shows that one; the commands that act on a
whole review act on it, and choosing another switches to that one.

## 0.2.1

A logo, and a shorter README: getting started, the gutter buttons and the
comments come first; the details moved to docs/guide.md.

## 0.2.0

Opening a repository no longer starts a review in it. The view shows Start
Review, and until it is pressed nothing is highlighted or counted and nothing
is written into `.git`; from then on the repository is reviewed whenever it
is opened, in all its worktrees. Repositories reviewed with an earlier version
count as started. Comments work without a start. The README covers installing
from the Marketplace, allowing the gutter buttons, and the commands it did not
mention.

Undo works after `git gc`: what it would put back is kept reachable from the
review's ref. Before, `git gc` could remove it after two weeks, and undoing an
older step then failed with a git error; a step whose content is already gone
is now refused with a message. The review files and refs of deleted branches
are removed when the checkout is opened or switches branches; before, they
stayed for good.

## 0.1.14

After an accept or reject the diff's left side is updated right away, before
the list and the links, which takes about half the time it did. The README
says how to make VS Code redraw diffs of files with many changes faster.

## 0.1.13

Accept no longer fails now and then with "index.lock: File exists": the list's
refresh, which updates the review's index too, waits for accepts and rejects,
and a step that finds the index locked by another git process waits for it
briefly instead of giving up.

## 0.1.12

Pause Review and Resume Review in the view's menu: paused, Second Look shows
nothing in that window (no highlights, links, keys, arrows, counts or list)
and keeps the review as it was. The pause holds across restarts.

## 0.1.11

An Open File button on each row of the list opens the change in the file
itself instead of a diff. secondLook.openIn: set it to `editor` and a click in
the list does that, the next change in another file opens the same way (except
from a review diff), and the row button becomes Open Diff. The default stays
`diff`. In the editor, hovering a highlighted change or the dashed line of a
removal shows the text it replaced.

Next and previous change to review are on Alt+F5 and Shift+Alt+F5 now, VS
Code's own keys for the next and previous change, taken over in review diffs
and in files with changes to review; the Julia extension starts its two-key
shortcuts with Alt+J, which swallowed Second Look's Alt+J. The line at the top
of the view lists the keys: Alt+F5 next, Alt+Y accept, Alt+N reject,
Shift+Alt+F5 back.

Reject Block next to Accept Block in the review diff's gutter. It rejects the
way Reject does: Undo takes it back and the agent is told. VS Code's own
Revert Block, which is also there, only edits the file.

Where the diff's gutter has Accept Block, review diffs go without the Accept
and Reject links, so no more empty lines for them. A local window knows from
the start; over Remote-SSH VS Code does not tell the extension, which then
learns it from the first click on one of its gutter buttons (once per VS Code version).
Other diffs of a file, such as git's, never get the links: they compare
something else. The Second Look output channel says what the extension knows.
The view's `...` menu has Hide (or Show) CodeLens Links in Diffs: it switches
VS Code's diffEditor.codeLens, which Second Look turns on by default and which
also brings other extensions' links into diffs, such as Julia's Run, Above,
Below and Debug above each cell.

The title bar no longer has Accept and Reject: VS Code shows about seven title
bar buttons and moves the rest under `...`, and they pushed the arrows there.
Second Look's previous and next arrows now come first, in the diff and in the
editor; Alt+Y and Alt+N still accept and reject at the cursor.

## 0.1.2

The + for a new comment says what it does: "Add comment for the agent
(Second Look)" in the menu VS Code shows when another extension offers
comments on the same line.

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
