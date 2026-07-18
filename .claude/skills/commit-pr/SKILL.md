---
name: commit-pr
description: Commit current changes and create a GitHub pull request.
disable-model-invocation: true
argument-hint: "[optional PR title/context]"
allowed-tools:
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git add *)
  - Bash(git commit *)
  - Bash(git push *)
  - Bash(git branch *)
  - Bash(gh pr create *)
  - Bash(gh pr view *)
  - Bash(gh auth status *)
---

Commit current changes and create a GitHub PR.

User context:
$ARGUMENTS

Steps:
1. Inspect `git status --short` and `git diff`.
2. Summarize changed files and identify any unrelated or risky changes.
3. If there are no changes, stop.
4. Run relevant focused tests if obvious from the changed files. If tests are expensive or unclear, ask before running broad suites.
5. Stage only the intended files. Do not stage unrelated user changes.
6. Create a concise conventional commit message.
7. Commit the staged changes.
8. Push the current branch to origin.
9. Create a PR with `gh pr create`.
10. PR body must include:
   - Summary
   - Tests run
   - Risks / notes
11. Return the commit hash and PR URL.