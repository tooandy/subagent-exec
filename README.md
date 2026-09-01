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
- Workspace scope verification
- Verification command execution
- Structured error classification

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
subagent-exec --task examples/task.json
```

Continue an existing task:

```bash
subagent-exec --continue TASK-123 --feedback feedback.json
```

Runtime metadata and Pi transcripts live separately under
`<cwd>/.subagent-exec/{metadata,pi-sessions}`. This directory can contain full
prompts and worker output, is ignored by Git, and should be removed or archived
according to the workspace's data-retention policy.

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

**stderr**: JSONL lifecycle events for observability.

## Documentation

- [`CONTRACT.md`](./CONTRACT.md) — Task and Result Contract specification
- [`SKILL.md`](./SKILL.md) — How Codex should use `subagent-exec`
- [`WORKFLOW.md`](./WORKFLOW.md) — Decomposition patterns

## Exit Codes

| Code | Meaning                  |
| ---: | ------------------------ |
|    0 | Task succeeded           |
|    1 | Task failed              |
|    2 | Protocol / schema error  |
|  124 | Task timeout             |
|  130 | Task cancelled (SIGINT/SIGTERM) |
