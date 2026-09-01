# subagent-exec

A bounded Worker Runtime that gives Codex (or any orchestrating agent) a
reliable, machine-parseable interface for delegating concrete coding tasks
to an external worker agent.

## What it does

`subagent-exec` takes a Task Contract (JSON), spawns one worker process,
runs the task to completion or failure, and emits one strict-JSON
Result Contract on stdout. Realtime JSONL lifecycle events are written
to stderr.

Tasks may be continued with coordinator feedback in the exact Pi session that
executed the first round. Continuation is bounded to two rounds by default and
three at most.

It owns:

- Worker process lifecycle (spawn, shutdown, SIGTERM, SIGKILL)
- JSONL RPC transport
- Timeout (per-task) and cancellation (SIGINT/SIGTERM)
- Token / cost usage capture
- Per-task delegation outcome and coordinator-rework measurement
- Workspace scope verification
- Disposable write candidates with OS-contained Worker and verification processes
- Verification command execution
- Structured error classification
- Delegation admission and change-budget enforcement

It does NOT own:

- Planning, decomposition, architecture decisions
- Final review of worker output
- The model's reasoning capability

## Architecture

```
┌────────────────────────────────────┐
│  Codex (Planner / Coordinator)     │
└─────────────┬──────────────────────┘
              │ Task JSON
              ▼
┌────────────────────────────────────┐
│  subagent-exec                      │
│  (process, RPC, timeout, scope)    │
└─────────────┬──────────────────────┘
              │ spawn
              ▼
┌────────────────────────────────────┐
│  Worker Process                     │
│  (Pi today, swap-in later)         │
└─────────────┬──────────────────────┘
              │
              ▼
       Workspace + Result
              │
              ▼
┌────────────────────────────────────┐
│  Codex Review                       │
└────────────────────────────────────┘
```

## Install

```bash
cd subagent-exec
npm install
npm run build
npm link
```

Verify:

```bash
pi --version
subagent-exec --doctor
subagent-exec --task examples/task.json
```

Every task explicitly selects a Worker model. The standard policy uses
`minimax-cn/MiniMax-M2.7` and permits one quota-only fallback to
`deepseek/deepseek-v4-flash`. Each new task tries Minimax first, so service
automatically returns to Minimax after its quota recovers; a task already
running on DeepSeek keeps that model for exact-session continuations.

Continue an existing task:

```bash
subagent-exec --continue TASK-123 --feedback feedback.json
```

Apply a reviewed isolated candidate:

```bash
subagent-exec --accept-candidate TASK-123
subagent-exec --reject-candidate TASK-123
```

Runtime metadata and Pi transcripts live separately under
`<cwd>/.subagent-exec/{metadata,pi-sessions}`. This directory can contain full
prompts and worker output, is ignored by Git, and should be removed or archived
according to the workspace's data-retention policy.

## Execution modes

- `fast`: low-risk, bounded implementation in one round.
- `checkpoint`: medium-risk work with a read-only planning round followed by
  one coordinator-approved implementation round.
- `investigation`: high-risk, single-round, read-only evidence gathering.

Write-capable tasks must declare allowed paths, acceptance criteria,
verification commands, and file/diff budgets. Tasks that do not meet their mode
requirements are rejected before a Worker is started. Prompts are capped at
12,000 characters and whole-repository path patterns are rejected; the
coordinator remains responsible for making each prompt semantically
self-contained.

Checkpoint tasks can reserve a third round for one repair. Result
`continuation` state stops immediately on scope, budget, architecture,
requirement, or non-retryable runtime failures, and after repeated failure or
unchanged diagnostics. Optional direct-cost estimates and ratios provide a
worker-cost circuit. Successful and terminal metadata is archived under
`.subagent-exec/archive`; only actionable sessions stay active.

Implementation Workers run in disposable detached Git worktrees. Checkpoint
planning is read-only and delays worktree creation until continuation. A successful
Result points to a candidate patch; the main checkout changes only after the
coordinator explicitly accepts it. Failed candidates are discarded.

## Run

```bash
subagent-exec --task examples/task.json
```

Or pipe via stdin:

```bash
cat examples/task.json | subagent-exec
```

## Output

**stdout**: exactly one strict JSON object (the Result Contract).

Every Result includes normalized `acceptance_evidence`: assumptions,
decisions, criterion statuses and reproducible references, changed symbols,
tests, risks, unresolved items, review locations, and a recommended next
action. Unsupported completion claims are marked `manual_review_required`.

**stderr**: JSONL lifecycle events for observability.

## Documentation

- [`CONTRACT.md`](./CONTRACT.md) — Task and Result Contract specification
- [`SKILL.md`](./SKILL.md) — How Codex should use `subagent-exec`
- [`WORKFLOW.md`](./WORKFLOW.md) — Decomposition patterns

## Exit Codes

| Code | Meaning                  |
| ---: | ------------------------ |
|    0 | Task succeeded, or Checkpoint plan awaits continuation |
|    1 | Task failed              |
|    2 | Protocol / schema error  |
|  124 | Task timeout             |
|  130 | Task cancelled (SIGINT/SIGTERM) |
