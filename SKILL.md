---
name: subagent-exec
description: Delegate a bounded implementation, testing, investigation, refactoring, or review task to an external worker session, then validate its structured result and workspace scope.
---

# Subagent Worker Skill

## Purpose

`subagent-exec` is the standard bounded worker gateway for delegating concrete
implementation, investigation, testing, refactoring, or review tasks to
an external coding agent.

Codex is the planner, coordinator, and reviewer.
The worker is an executor.

The worker must not replace Codex's planning or final review
responsibilities.

```
Codex
  │
  │ Task JSON
  v
subagent-exec
  │
  v
Worker Process
  │
  v
Workspace
  │
  v
Result JSON
  │
  v
Codex Review
```

## Core Principle

Use workers for execution.

Do not delegate ownership of the overall task to a worker.

Codex must:

1. Understand the overall requirement.
2. Decompose the work into concrete tasks.
3. Decide what should be delegated.
4. Provide precise task contracts.
5. Review worker results.
6. Inspect important changes when necessary.
7. Decide whether the task is actually complete.

Workers perform bounded tasks with explicit acceptance criteria.

## When to Use a Worker

Use `subagent-exec` when a task is:

- implementation-heavy
- repetitive
- independently testable
- well-scoped
- suitable for execution by another coding agent
- useful to run in parallel with other tasks
- likely to consume substantial reasoning / tool-call budget

Typical examples:

- implement a specific module
- add unit tests
- refactor a bounded component
- investigate a specific bug
- inspect a subsystem
- update documentation
- run tests and diagnose failures
- implement a well-defined API
- perform a focused code review

## Execution Mode Selection

- Use `fast` only for low-risk, single-round implementation with deterministic
  verification and explicit change budgets.
- Use `checkpoint` for medium-risk implementation. The first round is a
  read-only plan; review it before sending continuation feedback that authorizes
  implementation.
- Use `investigation` for high-risk or ambiguous work. It is always read-only
  and single-round.

Write-capable tasks without allowed paths, acceptance criteria, verification,
or change budgets are intentionally rejected as `DELEGATION_NOT_RECOMMENDED`.

## When NOT to Use a Worker

Do not delegate a task when:

- the task requires understanding the entire project architecture
- the requirements are still ambiguous
- the task requires a major architectural decision
- the worker would need to make product-level decisions
- the result cannot be independently verified
- the task is so small that delegation overhead exceeds the work
- Codex needs to maintain continuous context across many dependent steps

## Task Decomposition

Before invoking a worker, Codex should convert the work into a concrete
task.

A good worker task contains:

1. Objective
2. Context
3. Scope
4. Constraints
5. Acceptance criteria
6. Validation requirements
7. Expected output

Prefer one coherent task per worker invocation.

Avoid sending a large vague task such as:

> "Fix the project."

Instead:

> "Fix the RPC lifecycle in src/rpc.ts so that an agent_settled
> event cannot be missed when it arrives before prompt() returns."

## Task Contract

The task must be supplied as JSON.

Example:

```json
{
  "schema_version": "1.0",
  "task_id": "RPC-042",
  "cwd": "/workspace/project",
  "prompt": "Fix the RPC lifecycle race described below...",
  "timeout_ms": 300000,
  "allowed_paths": [
    "src/rpc.ts",
    "src/cli.ts",
    "tests/"
  ],
  "acceptance_criteria": ["Regression test passes"],
  "verification": { "commands": ["npm test"] },
  "iteration": { "max_iterations": 1 },
  "execution_policy": {
    "mode": "fast",
    "risk": "low",
    "max_changed_files": 3,
    "max_diff_lines": 300,
    "on_failure": "return_to_coordinator"
  }
}
```

See `CONTRACT.md` for the complete Task Contract.

## Task Prompt Requirements

The prompt sent to a worker must be self-contained.

Do not assume the worker knows the conversation between Codex and the
user.

Include:

- exact problem
- relevant files
- desired behavior
- constraints
- tests to run
- acceptance criteria

Bad:

> "Fix the timeout issue."

Good:

> "In src/cli.ts, the current Promise.race waits on a cancellation
> promise that resolves immediately. This causes the task to finish
> before agent_settled.
>
> Replace this with a real race between:
> 1. agent_settled
> 2. timeout
> 3. SIGINT/SIGTERM cancellation
>
> Preserve the existing Result Contract.
>
> Add a regression test proving that a long-running task remains
> active until agent_settled."

## Scope

Workers must only modify files explicitly allowed by the task.

Codex should specify `allowed_paths` whenever the task has a meaningful
scope boundary.

Examples:

```yaml
allowed_paths:
  - src/rpc.ts
  - src/cli.ts
  - tests/rpc.test.ts
```

If the worker modifies files outside the allowed scope, treat the
result as requiring review.

Do not silently accept scope violations.

## Invocation

Run:

```bash
subagent-exec --task <task.json>
```

Example:

```bash
subagent-exec --task /tmp/task-RPC-042.json
```

## Output Contract

`subagent-exec` writes exactly one final JSON result to stdout.

Operational JSONL logs are written to stderr.

Do not parse stderr as the final task result.

The final result contains:

- task_id
- status
- summary
- changed_files
- usage
- validation
- error when applicable

See `CONTRACT.md` for the exact Result Contract.

## Worker Status

Treat worker status as follows:

### success

The worker claims that the task completed successfully.

This does NOT mean Codex should blindly accept the result.

Codex must still review:

- summary
- changed_files
- validation
- scope
- tests
- relevant code changes

### failed

The worker failed to complete the task.

Read:

- error.category
- error.code
- error.message
- retryable

Decide whether to:

- retry
- narrow the task
- fix the problem directly
- delegate a different task

### cancelled

The worker was intentionally interrupted.

Do not retry automatically.

Determine whether partial changes exist and inspect the workspace.

### timeout

The worker exceeded its execution budget.

Inspect partial changes before retrying.

Prefer splitting the task or increasing timeout only when justified.

## Error Handling

Errors are classified into categories:

- task
- validation
- scope
- quota
- auth
- token
- runtime

Do not treat all errors equally.

### quota

The worker or provider has exhausted a quota.

Do not repeatedly retry immediately.

Consider:

- another worker
- another model / provider
- reducing task size

### auth

Authentication or credential failure.

Do not modify the code to work around authentication failures.

### token

Token / context limitation.

Reduce task scope or split the task.

### scope

The worker modified files outside the permitted scope.

Review the diff before accepting anything.

### runtime

The worker process or RPC runtime failed.

Inspect logs and determine whether the task itself or the worker runtime
is responsible.

### validation

The implementation was produced but validation failed.

Review the failure before retrying.

## Review Protocol

A worker result is evidence, not truth.

After a worker returns `success`, Codex should verify:

1. Did the requested files change?
2. Are the changes inside the allowed scope?
3. Does the implementation satisfy the acceptance criteria?
4. Did the required tests run?
5. Did the tests actually pass?
6. Is the worker summary consistent with the diff?
7. Are there obvious regressions?
8. Is additional work required?

For important tasks, inspect the actual diff.

Never mark the overall user task complete solely because the worker
reported `success`.

## Parallel Workers

Independent tasks may be delegated to multiple workers.

Example:

- Worker A: implement RPC cancellation
- Worker B: add lifecycle regression tests
- Worker C: review usage parsing

Workers should not concurrently modify the same files unless explicitly
planned.

Prefer independent workspaces or sequential execution when tasks
overlap.

## Worker Prompt Style

Worker prompts should be:

- concrete
- bounded
- testable
- implementation-oriented

Avoid:

- broad architectural speculation
- unnecessary background
- vague goals
- asking the worker to decide the overall product direction

## Important Runtime Rules

The worker runtime currently follows:

```
one task
  =
one exact persisted worker session
  =
one initial round plus bounded coordinator feedback
```

The first task must remain self-contained. A continuation may rely on the exact
persisted session identified by the runtime, but must only provide focused
review feedback. Do not use continuation as an unbounded retry loop: the default
limit is two total rounds and the hard maximum is three.

The runtime stores metadata and Pi transcripts below `.subagent-exec/`. Treat
that directory as sensitive runtime state and never commit it.

## Cost Control

The primary reason to use workers is to reduce expensive Codex
execution.

Use Codex for:

- planning
- decomposition
- architecture
- difficult reasoning
- final review

Use workers for:

- concrete implementation
- mechanical changes
- testing
- bounded investigation
- repetitive coding

Do not invoke a worker for every trivial operation.

Delegation overhead is itself a cost.

## Failure Recovery

If a worker fails:

1. Read the structured error.
2. Inspect partial workspace changes.
3. Determine whether the failure is:
   - task-related
   - runtime-related
   - provider-related
   - scope-related
4. Do not blindly retry the same task.
5. Modify the task contract if retrying.

A retry should normally contain additional information or a smaller
scope.

## Security / Safety

Never delegate secrets, credentials, private keys, or unrelated
sensitive data unless explicitly required.

Do not ask workers to modify files outside the intended project.

Do not disable tests, validation, or scope checking merely to make a
task pass.

## Worker Runtime is an Implementation Detail

Codex should treat `subagent-exec` as a black-box worker gateway. The
underlying worker runtime (currently Pi) may be swapped without changes
to this skill. Do not hardcode assumptions about specific worker
internals in prompts or contracts.

## Summary

Codex = planner + coordinator + reviewer.
Worker = executor.

The correct pattern is:

```
PLAN
  ↓
DECOMPOSE
  ↓
DELEGATE
  ↓
EXECUTE
  ↓
REVIEW
  ↓
VERIFY
  ↓
ACCEPT / RETRY / FIX
```
