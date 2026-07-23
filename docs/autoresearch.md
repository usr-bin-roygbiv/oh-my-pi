# Autoresearch and spare-machine contributions

`/autoresearch` runs a user-directed experiment loop. `/contribute` is an opt-in,
more constrained profile that reuses the same native autoresearch machinery for one
official upstream goal. Neither command changes global tool-approval policy.

## Ordinary `/autoresearch`

Run OMP in the target checkout, then use:

```text
/autoresearch <goal>
```

On a clean Git checkout, OMP creates or reuses a dedicated `autoresearch/*`
branch, enables `init_experiment`, `run_experiment`, `log_experiment`, and
`update_notes`, then sends the goal to the current model. With no argument,
`/autoresearch` enables the mode and waits for the next goal message; while active,
the same bare command disables it.

Phase 1 builds and validates `./autoresearch.sh`. The harness must exit successfully
and print `METRIC <name>=<value>`. `init_experiment` commits the harness baseline on
an autoresearch branch. Later iterations use the fixed `bash autoresearch.sh`
entrypoint; `log_experiment keep` commits a result, while discard/failure statuses
revert that iteration. State and run artifacts live under `~/.omp/autoresearch/`.
An active session can be resumed later on its recorded branch.

Control commands:

- `/autoresearch off` disables the mode and experiment tools but preserves the
  branch and session for later resumption.
- `/autoresearch clear` closes the active session and, on an autoresearch branch,
  resets and cleans the worktree to its recorded baseline. Inspect work first.
  `--keep-tree` preserves the worktree; `--reset-tree` requests the reset even when
  currently off the recorded branch.

Ordinary autoresearch does not fetch an official goal, select a contribution model
or fork, publish a branch, or create a pull request. `/contribute` does not alter
these ordinary semantics.

## `/contribute`: operating model

`/contribute` runs in one foreground, process-local OMP session. It starts a fresh
dedicated candidate branch and a fresh uncapped autoresearch session. “Uncapped”
means no experiment-count limit; it does not grant more provider quota, money,
machine capacity, tool permission, or time.

Keep it attached to a persistent interactive terminal such as `tmux`. Do not wrap
it in a daemon, service, cron job, scheduler, queue worker, shell restart loop, or
remote orchestration layer. Do not pool accounts, donate raw tokens, copy credential
databases, upload credentials, or move credentials between people or machines.
Authenticate the machine locally with your own provider and GitHub accounts. Never
paste a credential into the chat or place one in a Git remote URL.

### Availability before merge

The command hardcodes `can1357/oh-my-pi` `main` and
`.github/AUTORESEARCH_GOAL.md`. End-to-end official-main use cannot succeed until
the canonical goal file lands on official `main` and a build containing
`/contribute` is installed. Branch-only tests or an injected goal can prove the
contract before merge; they are not an official-main live smoke test.

## Shortest spare-machine setup

### 1. Install current OMP and authenticate locally

Use a current official install. The Bun path is:

```sh
bun install -g @oh-my-pi/pi-coding-agent
omp --version
```

Install GitHub CLI if needed, then authenticate its API and the HTTPS Git transport
without printing a token:

```sh
gh auth login
gh auth setup-git
gh auth status
```

An SSH fork remote is also supported, but its SSH key must already work on this
machine. Keep `gh` authenticated separately because contribution goal and fork
verification use the GitHub API.

### 2. Clone your fork and pin the official base

Create a personal GitHub fork if needed, then clone it. `gh repo fork --clone`
usually creates `origin` for the fork and `upstream` for the official repository:

```sh
gh repo fork can1357/oh-my-pi --clone
cd oh-my-pi
git remote -v
```

If `upstream` is absent, add it; then verify both exact destinations:

```sh
git remote add upstream https://github.com/can1357/oh-my-pi.git
git remote get-url origin
git remote get-url upstream
git fetch --prune upstream main
git switch --detach upstream/main
git status --porcelain=v1 --untracked-files=all
git rev-parse HEAD
```

Skip `git remote add` when the name already exists. `origin` must be your
`github.com/<you>/oh-my-pi` fork, never `can1357/oh-my-pi`; `upstream` must resolve
to the official repository. The status command must print nothing. `/contribute`
requires whole-worktree cleanliness and local `HEAD` exactly equal to the live
commit fetched from official `main`; if official `main` moves, fetch and detach at
`upstream/main` again.

### 3. Start one fresh persistent OMP session

```sh
tmux new -s omp-contribute
cd /path/to/oh-my-pi
omp
```

Use plain `omp`, not a resumed session. In OMP, authenticate the provider locally
and select the model you intend to pay for:

```text
/login <provider>
/model
```

`default` supplies the current model for a new ordinary session. `/model` may
change it. `/contribute` lists only authenticated models, preselects the current
model, and still requires an explicit contribution-model selection. At final
start it switches to that selection; the selected model remains current until you
change it.

A fresh clone should have no autoresearch state. If preflight reports active or
resumable state, inspect it and deliberately run `/autoresearch clear` before
trying again; clear may reset and clean the recorded worktree.

## Start and inspect

Enter:

```text
/contribute
```

The first confirmation authorizes bounded, read-only preflight only. Preflight:

- fetches the official `main` goal and provenance;
- verifies clean local `HEAD` equals that official-main commit;
- rejects active/resumable autoresearch state or an existing autoresearch branch;
- lists authenticated models and GitHub remotes whose fetch and push-effective
  destinations resolve to the same safe fork;
- verifies the selected repository is a GitHub fork of `can1357/oh-my-pi`.

The final confirmation discloses the exact goal title, official-main commit/base,
goal blob SHA, goal SHA-256, selected `provider/model`, fork remote name and URL,
push-effective destination, and fresh candidate branch. It also discloses that the
foreground session can run
indefinitely, consumes model tokens, executes tests and commands under normal
approval policy, and may create commits. Confirm only those exact values and
costs. The command does not estimate or cap provider charges.

After confirmation OMP rechecks the goal, base, fork URL, push-effective URL,
fork metadata, and fresh branch name; switches model; creates the candidate branch
at the frozen base; activates existing autoresearch tools; and starts the goal
turn. It never weakens
approval mode.

Use:

```text
/contribute status
```

While running, status shows candidate branch, goal title, frozen initial base and
goal commit, current segment goal commit and SHA-256, model, and confirmed fork.
After handoff it shows the immutable SHA review URL, mutable branch compare URL,
and candidate SHA.

## Lifecycle and costs

Safe terminal turns continue automatically in the same native OMP process.
Automatic continuation stops for queued human input, an explicit
`[CONTRIBUTE_PAUSE]` gate, an interrupted/aborted turn, a provider/tool error,
`/contribute review`, `/contribute off`, session or tree/branch switching, or
session exit. A switch, branch, or tree transition attempted while contribution
startup, mutation, shutdown, or publication work is settling is canceled
immediately; wait for the stop to finish, inspect `/contribute status`, then retry
the transition. After an interruption or input gate, resolve the gate explicitly,
then send a deliberate message or stop the flow. There is no background restart.

`/contribute off` closes the process-local experiment session and deactivates its
tools. It does not reset or delete the candidate branch or restore the previous
model. Session exit also drops contribution authorization and running state; a
reopened OMP session cannot resume it. Local files and commits may remain, but a
new contribution run must start fresh from a clean, exact official-main base.

Budget for all costs before confirming:

- provider input/output/cache tokens, subscription quota, and possible API charges
  for an indefinite uncapped loop;
- CPU/GPU, memory, disk, network, electricity, and terminal availability;
- benchmark, build, and test duration plus any normally approved command effects;
- autoresearch database/run artifacts, harness and kept-result commits, and one
  local candidate branch;
- at review only, one exact branch ref on the selected personal fork.

Monitor the chosen provider account and OMP usage display. Stop with
`/contribute off` before an allowed budget is exhausted.

## Goal refresh boundaries

At start, OMP fetches the goal from official `main`, shows its provenance, then
requires it to remain unchanged through final confirmation. The goal stays frozen
within a segment; it is not polled between turns or experiments. An explicit
`init_experiment` with `new_segment: true` fetches and validates the current
official-main goal before segment mutation. The draft records both the initial
base/goal commit and the current segment goal commit, blob, and SHA-256.

## Review and fork-only handoff

Prepare an unflagged `keep` result in the current segment, with its commit at exact
`HEAD` and a completely clean worktree. Publication also requires executable TDD
evidence for the fixed harness command: an earlier, completed, unflagged
`checks_failed` run in the same segment that actually exited nonzero or timed out,
followed by the completed kept run exiting zero without timeout. Then enter:

```text
/contribute review
```

Review revalidates the recorded branch, exact candidate `HEAD`, frozen-base
ancestry, executable red/green evidence, clean worktree, unchanged fetch and
push-effective remote URLs, and GitHub fork metadata. It builds the exact PR
title/body and asks for a second confirmation. That confirmation authorizes only
this push:

```text
<validated-candidate-SHA>:refs/heads/<candidate-branch>
```

The destination is the verified push-effective URL for the previously confirmed
fork. A unique command-scoped remote uses an explicit `pushurl` through a random,
exact-match URL alias. This bypasses configured `pushurl`, `pushInsteadOf`, and
ordinary `insteadOf` redirection while retaining the verified destination. The
push also disables local push hooks and recursive submodule publication so the
confirmed exact refspec is its only repository publication effect.
A force-with-lease expecting an absent remote branch prevents overwriting an
existing ref. Nothing is pushed to the official repository. The command never
creates, approves, or merges a pull request.

Immediately before transport, OMP records and displays the immutable candidate,
destination ref, review URLs, and exact draft as a durable “push outcome pending”
intent. Once that immutable push begins, lifecycle commands drain it rather than
canceling an ambiguously completed transport. A successful push always retains the
review URLs and draft handoff before the transition completes. If the process exits
before recording success, `/contribute status` in the reopened session checks the
exact fork ref and reports recovered success, a different SHA, or an unknown
outcome; it never retries the push.

After the push, OMP stops the research loop and prints:

- an immutable review URL comparing frozen base SHA to candidate SHA;
- a mutable convenience URL comparing official `main` to the fork branch;
- PR draft text whose human-summary placeholder remains visibly empty.

Review from the immutable SHA URL; the branch URL can change if the fork branch
moves. Before creating any PR, a human must:

1. review every changed file and understand the resulting behavior;
2. personally exercise the changed path and record the exact scenario and result;
3. write their own sentence explaining what changed and why, bound in the final
   draft to the frozen base SHA, candidate SHA, and current goal commit/SHA-256;
4. verify the final exact PR title, complete body, base/head, and provenance;
5. explicitly approve the final “create draft pull request” action.

Only after those human steps may the user create, or explicitly authorize, the
exact draft PR action using the mutable compare URL after the immutable review.
The contribution loop must never trigger a PR API or button unattended, open a
ready-for-review PR, or treat `/contribute review` confirmation as PR approval.

A `CODEOWNERS` match only requests reviewers. Whether approval is actually required
before merge depends on GitHub branch-protection or ruleset configuration; files in
this repository cannot assert or enforce those server-side settings.

Follow [`CONTRIBUTING.md`](../CONTRIBUTING.md) for scope, verification, and
human-authorship requirements.

## Candidate cleanup

`/contribute off`, interruption, and process exit intentionally leave the local
candidate branch for inspection. Do not delete unreviewed or needed work. To
abandon a clean candidate after recording its name:

```sh
candidate_branch='PASTE_EXACT_CANDIDATE_BRANCH'
git fetch --prune upstream main
git switch --detach upstream/main
git branch -D "$candidate_branch"
```

If `/contribute review` pushed the branch, keep the fork ref while a draft PR needs
it. After merge, closure, or deliberate abandonment, delete only that exact fork
ref with your chosen fork remote:

```sh
fork_remote='origin' # Replace if /contribute confirmed another fork remote.
candidate_branch='PASTE_EXACT_CANDIDATE_BRANCH'
git push "$fork_remote" --delete "$candidate_branch"
```

Never run cleanup against `upstream`. Re-fetch official `main`, confirm an empty
whole-worktree status, and start a new plain OMP session for another contribution.
