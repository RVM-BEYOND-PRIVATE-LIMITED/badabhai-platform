---
name: bb-prune-merged-branches
description: Find stale branches already merged into main, verify they are old and safe, and prune them only after confirmation. Use for repository cleanup and branch hygiene.
---

# Skill: Prune merged branches

**Goal.** Remove obsolete local and remote branches that are already merged into main, without deleting active or protected branches.

**Inputs.** The repository root; current branch; remote refs; the target branch (usually `main`); optional age threshold such as `30 days`.

**Process.**
1. Fetch the latest refs and prune stale remote-tracking branches: `git fetch --all --prune`.
2. Verify the merge status against `main` using `git branch --merged main` and `git branch -r --merged origin/main`.
3. Identify candidates that are older than the requested age threshold (or default to the repo's stale-branch policy).
4. Exclude protected branches such as `main`, `master`, `develop`, the current branch, and any branch with unmerged work.
5. Report the candidates first; ask for explicit confirmation before deleting anything.
6. Delete only after confirmation, using safe commands such as `git branch -d <branch>` and `git push origin --delete <branch>` when appropriate.
7. Re-run the branch listing to confirm the cleanup result.

**Checklist.**
- [ ] Latest refs were fetched and remote-tracking branches were pruned.
- [ ] Candidate branches were verified as merged into `main`.
- [ ] Protected/active branches were excluded.
- [ ] The user was shown the list of candidates before any deletion.
- [ ] Only confirmed branches were removed.
- [ ] No branch deletion occurred if the repository state was ambiguous.

**Expected Output.** A safe list of stale merged branches, any deletions performed, and a confirmation that the remaining branch state is correct.

**Failure Conditions.** Deleting branches that are not actually merged; deleting the current branch or protected branches; deleting without confirmation; deleting remote branches without verifying the branch is truly stale.
