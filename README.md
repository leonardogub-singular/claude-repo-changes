# repo-changes

A Claude Code mod that shows git changes for many repos at once.

Claude Code's Changes pane reads git state from the session folder. When you open a session in a
folder that holds several repos side by side (a workspace, not a repo), that pane stays empty.
This mod adds a **Repo changes** pane that scans every child repo, and every worktree under
`<repo>/.claude/worktrees/`, and lists what changed.

## What it shows

- Every repo with uncommitted changes, sorted by name, with its worktrees nested under it.
- The branch name, and how many commits it is ahead of (↑) or behind (↓) its upstream.
- Counts per repo: modified, new, deleted and conflicted files.
- Files under their folder. A big folder (12+ files), or a folder of only new files, folds into
  one row that you can open.
- A **Flat** view: one row per file, its folder after the name. The pane remembers your choice.
- A filter field, and an **All / Tracked** switch that hides untracked files.
- Click a file to see its diff. Use ↑ / ↓ (or `k` / `j`) to move between files, and
  "‹ All files" (or `b`) to go back.

The pane refreshes after Claude edits a file or runs a command, when a turn ends, and every 30
seconds. The ↻ button refreshes it at once.

## Install

Type this at the prompt of a terminal `claude` session:

```
/plugin install repo-changes --marketplace leonardogub-singular/claude-repo-changes
```

Answer `y` to add the marketplace, then pick the user scope. A mod installed at the user scope
also loads in the Claude desktop app's Code tab.

The mod needs a Claude Code build with mods (function hooks). That API is early access and can
change between releases.

## Use

- In a session whose folder is **not** a git repo, the pane opens by itself.
- Anywhere else, type `/repo-changes` to open it.

The mod looks at the folder the session started in. A `cd` in the shell does not change it.

## Limits

- The colors are made for a dark theme. In a light theme the pane looks wrong.
- The pane uses the app's font and text size. A mod cannot change them.
- A repo shows 100 rows at first. A "Show 100 more" button under the list shows the next 100.
- Diffs are against `HEAD`. Committed work on a branch does not show.

## Develop

```
claude plugin validate .
claude plugin test .
```

`hooks/logic.ts` holds the parsing and grouping, with tests in `tests/logic.test.ts`.
`hooks/register.tsx` holds the hooks and the pane drawing.

## License

MIT
