---
name: bb-prune-merged-branches
description: Find stale branches already merged into main, verify they are old and safe, and prune them only after confirmation. Use for repository cleanup and branch hygiene.
---

# Skill: Prune merged branches

**Goal.** Remove obsolete local and remote branches that are already merged into main, without deleting active or protected branches.

**Inputs.** The repository root; current branch; remote refs; the target branch (usually `main`); optional age threshold such as `30 days`.

> **THIS REPO SQUASH-MERGES — `--merged` and `-d` both LIE here.** A squash merge replays
> the branch as one new commit, so the branch tip is never an ancestor of `main`. Measured on
> this repo: `git branch --merged main` reported **none** of the just-merged PR branches.
> Both directions matter:
>
> - `git branch --merged` **under-reports** — it will look like there is nothing to prune.
>   That is the safe direction, and it is why step 2 alone is not evidence of anything.
> - `git branch -d` **refuses** a squash-merged branch for the same reason. That refusal is
>   correct-but-useless here, and the trap is that it invites reaching for `-D`, which
>   deletes unmerged work with no check at all. **Do not escalate to `-D` to get past a
>   refusal** — a refusal you did not expect means the evidence is ambiguous, so stop
>   (see Failure Conditions).
>
> Judge merged-ness by CONTENT instead: a branch is prunable when its PR is merged
> (`gh pr list --state merged --json headRefName,mergeCommit`) or when
> `git diff <branch> origin/main` over the paths it touched is empty. Reusing a
> squash-merged branch has already cost this project a 155-file PR (see the tech-debt and
> decisions registers), so treat an ambiguous branch as live, never as stale.

**Process.**
1. Fetch the latest refs and prune stale remote-tracking branches: `git fetch --all --prune`.
2. Verify the merge status against `main` using `git branch --merged main` and `git branch -r --merged origin/main`. **Treat a negative result as inconclusive, not as "unmerged"** — see the squash-merge note above, and confirm against merged-PR head refs before calling anything stale.
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
