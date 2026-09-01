# subagent-exec Task / Result Contract

This document is the authoritative specification for the JSON contracts
exchanged with `subagent-exec`. The contract is stable; the worker
runtime behind it (currently Pi) is an implementation detail and may
change.

---

## 1. Task Contract

The Task Contract is supplied to `subagent-exec` either as a JSON file
(`--task <path>`) or as JSON piped on stdin.

### Required fields

| Field | Type | Description |
| --- | --- | --- |
| `schema_version` | string `"1.0"` | Contract version. |
| `task_id` | string | Unique task identifier. Matches `^[A-Za-z0-9._:-]+$`, max 200 chars. |
| `prompt` | string | Self-contained instruction sent to the worker. When `constraints` or `acceptance_criteria` are present they are appended as named sections so the worker receives them as structured data. |

### Optional fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `objective` | string | — | High-level intent. **Coordinator-only**; NOT transmitted to the worker. Useful for Codex to track task purpose. |
| `cwd` | string | process cwd | Working directory for the worker. |
| `scope` | enum | `read_write` | `read_only` or `read_write`. In `read_only` mode any file creation, modification, or deletion fails the task regardless of `allowed_paths`. |
| `allowed_paths` | string[] (glob) | `[]` | Files/directories the worker may modify. `read_write` + empty = scope not checked. `read_only` + any value = ANY change is a violation. |
| `constraints` | string[] | `[]` | Implementation constraints sent to worker as a fixed `### CONSTRAINTS` section. Each entry becomes a bullet point. |
| `acceptance_criteria` | string[] | `[]` | Acceptance criteria sent to worker as a fixed `### ACCEPTANCE CRITERIA` section. Each entry becomes a bullet point. |
| `verification` | object | — | Commands to run after worker completes (see below). |
| `iteration` | object | `{ max_iterations: 2 }` | Bounded session rounds. `max_iterations` is 1–3 and includes the first round. |
| `execution_policy` | object | — | Required delegation mode, risk, failure behavior, and implementation change budgets. |
| `model` | object | — | `{ provider, model }` forwarded to worker runtime. |
| `timeout_ms` | number | 900000 | Max execution time in ms. Max 24h (86400000). |
| `metadata` | object | — | Free-form data passed through to the Result. |

### Prompt normalization

When `constraints` or `acceptance_criteria` are present, they are **not**
concatenated into the prompt text. Instead they are appended as named
sections:

```
<prompt>

### CONSTRAINTS
- Do not add new dependencies
- Use TypeScript strict mode

### ACCEPTANCE CRITERIA
- PKCE flow implemented
- Unit tests added
```

This prevents prompt injection and ensures the worker cannot accidentally
overwrite constraints by editing the prompt.

### verification sub-object

| Field | Type | Description |
| --- | --- | --- |
| `commands` | string[] | Shell commands to run after worker finishes. Fail-fast on first failure. |
| `timeout_ms` | number | Per-command timeout (default 120000). |

### iteration sub-object

| Field | Type | Description |
| --- | --- | --- |
| `max_iterations` | integer | Total rounds including the first invocation. Defaults to 2; maximum 3. |

### execution_policy sub-object

| Field | Type | Description |
| --- | --- | --- |
| `mode` | enum | `fast`, `checkpoint`, or `investigation`. |
| `risk` | enum | `low`, `medium`, or `high`; constrained by mode. |
| `max_changed_files` | integer | Required positive file budget for implementation modes. |
| `max_diff_lines` | integer | Required positive changed-line budget for implementation modes. |
| `on_failure` | enum | V1 requires `return_to_coordinator`. |

Admission rules:

- Fast requires `scope=read_write`, low risk, one iteration, allowed paths,
  acceptance criteria, verification commands, and both change budgets.
- Checkpoint requires the same implementation boundaries, medium risk, and two
  iterations. Round one is forced read-only and returns
  `needs_continuation`; round two performs implementation after coordinator
  approval.
- Investigation requires `scope=read_only`, high risk, and one iteration.
- Missing or inconsistent boundaries return `DELEGATION_NOT_RECOMMENDED`
  before Pi is spawned.
- Prompts are capped at 12,000 characters. Implementation path patterns must
  be repository-relative and may not select the whole repository (`*`, `**`,
  `**/*`, absolute paths, and parent traversal are rejected). The coordinator
  remains responsible for ensuring the prompt is semantically self-contained;
  that property cannot be established reliably by syntax alone.
- An implementation exceeding either budget returns
  `CHANGE_BUDGET_EXCEEDED`.

## 1.1 Continue Task Contract

Continuation is supplied with `--continue <task_id>` and either
`--feedback <path>` or JSON on stdin:

```json
{
  "schema_version": "1.0",
  "task_id": "AUTH-001",
  "action": "continue",
  "feedback": "Fix the failing refresh-token test",
  "timeout_ms": 300000
}
```

Only feedback and an optional per-round timeout are accepted. Working directory,
scope, constraints, acceptance criteria, verification, model, and iteration
policy are restored from validated runtime metadata. The runtime resumes the
exact Pi session ID assigned to the task; it never selects the most recent
session implicitly.

Verification is rerun after every continuation that reaches post-worker
processing, including rounds with a scope or worker-result error. An earlier
primary error is preserved if verification also fails. A round terminated by
timeout, cancellation, prompt rejection, or process exit before post-worker
processing reports verification as `not_run`.

Runtime state is stored under `<cwd>/.subagent-exec/`: contract metadata in
`metadata/` and Pi transcripts in `pi-sessions/`. Metadata writes are atomic.

### Examples

**Standard task:**

```json
{
  "schema_version": "1.0",
  "task_id": "AUTH-001",
  "objective": "Add OAuth support",
  "prompt": "Implement OAuth 2.0 PKCE flow in src/auth/oauth.ts...",
  "cwd": "/workspace/project",
  "allowed_paths": ["src/auth/**", "tests/auth/**"],
  "iteration": { "max_iterations": 1 },
  "execution_policy": {
    "mode": "fast",
    "risk": "low",
    "max_changed_files": 4,
    "max_diff_lines": 500,
    "on_failure": "return_to_coordinator"
  },
  "constraints": ["Do not add new dependencies"],
  "acceptance_criteria": ["PKCE flow implemented", "Unit tests added"],
  "verification": { "commands": ["npm test"], "timeout_ms": 120000 },
  "timeout_ms": 900000,
  "metadata": { "parent_agent": "codex", "attempt": 1 }
}
```

**Read-only review task:**

```json
{
  "schema_version": "1.0",
  "task_id": "REVIEW-042",
  "objective": "Review RPC lifecycle implementation",
  "prompt": "Review src/rpc.ts and src/cli.ts for race conditions...",
  "cwd": "/workspace/project",
  "scope": "read_only",
  "iteration": { "max_iterations": 1 },
  "execution_policy": {
    "mode": "investigation",
    "risk": "high",
    "on_failure": "return_to_coordinator"
  }
}
```

---

## 2. Result Contract

`subagent-exec` writes exactly one Result Contract on stdout.

### Top-level fields

| Field | Type | Description |
| --- | --- | --- |
| `schema_version` | string `"1.0"` | Always present. |
| `task_id` | string | Echoed from the Task Contract. |
| `status` | enum | `success` / `needs_continuation` / `failed` / `cancelled` / `timeout`. |
| `worker` | object | Worker runtime info. |
| `execution` | object | Timing and process info. |
| `result` | object | Worker output (summary, final message, changed files). |
| `scope` | object | Workspace scope verification. |
| `verification` | object | Verification command results. |
| `acceptance_evidence` | object | Structured criterion evidence and review guidance. |
| `usage` | object or null | Token / cost usage (may be null if unavailable). |
| `iteration` | integer | Current one-based session round. |
| `needs_continuation` | object | Present when a Checkpoint plan awaits coordinator review. |
| `error` | object or null | Structured error for failed, cancelled, or timeout results. |
| `metadata` | object | Echoed from Task Contract. |

### acceptance_evidence

The Worker is instructed to end its response with a fenced
`subagent-evidence` JSON object. The gateway validates and normalizes it into
assumptions, decisions, criterion statuses and evidence, changed symbols, tests
added, risks, unresolved items, review locations, and an optional recommended
next action. Evidence types are `command`, `test`, `file`, and `symbol`, each
with a non-empty concrete reference.

The evidence fence must be the final response block. A `command` reference must
exactly match a successful configured verification command; a `test` reference
must equal a complete line in successful verification output; a `file` must identify a changed
file (optionally with a positive integer `:line`); and a `symbol` must use `path#symbol` for a
changed file. These checks establish reproducibility, not semantic sufficiency.

Missing or malformed evidence, omitted criteria, and `passed` claims without
evidence are normalized to `manual_review_required`. The overall task may still
return `success`; the coordinator must inspect this field before acceptance.

### worker

```json
{
  "runtime": "pi",
  "provider": "deepseek",
  "model": "deepseek-chat"
}
```

`runtime` is `"pi"` in V1. Future versions may add other runtimes; the
contract does not change.

### execution

```json
{
  "started_at": "2026-08-27T10:00:00.000Z",
  "finished_at": "2026-08-27T10:00:21.000Z",
  "duration_ms": 21000,
  "pid": 12345,
  "exit_code": 143,
  "signal": null
}
```

`exit_code` reflects the worker process exit. When the worker is
deliberately shut down via SIGTERM after a normal completion, this will
typically be `143` (128 + 15).

### result

```json
{
  "summary": "Implemented PKCE flow ...",
  "final_message": "...",
  "changed_files": ["src/auth/oauth.ts", "tests/auth/oauth.test.ts"]
}
```

`final_message` is **only ever populated from assistant-role worker
messages**. It is never taken from the user prompt.

`changed_files` is sourced from the scope check, not from worker
self-report.

### scope

```json
{
  "status": "passed",
  "allowed_paths": ["src/auth/**"],
  "scope_mode": "read_write",
  "changed_files": ["src/auth/oauth.ts"],
  "added_files": ["src/auth/oauth.ts"],
  "modified_files": [],
  "deleted_files": [],
  "violations": []
}
```

- `status` = `not_checked` when `allowed_paths` was empty in `read_write` mode
- `status` = `failed` when worker modified files outside `allowed_paths` (read_write)
  or when worker modified any file in `read_only` mode
- `scope_mode` reflects the `scope` field from the Task Contract

### verification

```json
{
  "status": "passed",
  "commands": ["npm test"],
  "results": [
    {
      "command": "npm test",
      "exit_code": 0,
      "duration_ms": 12000,
      "stdout": "...",
      "stderr": ""
    }
  ]
}
```

`status` = `not_run` when `verification.commands` was empty or the round ended
before post-worker verification could safely begin.

### usage

```json
{
  "input_tokens": 12000,
  "output_tokens": 3500,
  "cache_read_tokens": 8000,
  "cache_write_tokens": 1000,
  "total_tokens": 24500,
  "cost": 0.12,
  "currency": "USD"
}
```

May be null if the worker runtime does not support session stats.

### error

```json
{
  "category": "quota",
  "code": "PROVIDER_QUOTA_EXCEEDED",
  "message": "Provider quota exceeded: ...",
  "retryable": true,
  "details": null
}
```

#### Error categories

| Category | Typical cause | Retryable |
| --- | --- | --- |
| `quota` | Provider rate limit / quota exceeded | yes |
| `auth` | Missing or invalid API key | no |
| `token` | Context window / token limit exceeded | no |
| `runtime` | Worker crash, timeout, cancellation, unexpected exit, workspace error | varies |
| `protocol` | Invalid RPC, missing events, schema mismatch | varies |
| `scope` | Worker modified files outside `allowed_paths` (read_write) or any file (read_only) | no |
| `verification` | Verification command failed | no |

#### Common error codes

| Code | Category | Meaning |
| --- | --- | --- |
| `TASK_TIMEOUT` | runtime | Worker exceeded `timeout_ms` |
| `TASK_CANCELLED` | runtime | Worker interrupted by SIGINT/SIGTERM |
| `PI_PROCESS_EXIT_NONZERO` | runtime | Worker exited abnormally before `agent_settled` |
| `READ_ONLY_SCOPE_VIOLATION` | scope | Worker modified files in `read_only` scope |
| `MODIFICATION_SCOPE_VIOLATION` | scope | Worker changed files outside `allowed_paths` |
| `VERIFICATION_FAILED` | verification | One or more verification commands failed |
| `AGENT_SETTLED_MISSING` | protocol | Worker ended without reporting completion |
| `FINAL_MESSAGE_MISSING` | protocol | Worker produced no assistant output (not used when auth/quota/token error is already set) |
| `PROMPT_REJECTED` | protocol | Worker runtime rejected the prompt |
| `TASK_ID_MISMATCH` | protocol | `--task-id` CLI flag disagreed with task.json |
| `PROVIDER_QUOTA_EXCEEDED` | quota | Provider quota exhausted |
| `AUTH_ERROR` | auth | Authentication / credential failure |
| `TOKEN_LIMIT` | token | Context or token limit exceeded |
| `WORKSPACE_ERROR` | runtime | Git repository check failed; workspace state unverifiable |
| `DELEGATION_NOT_RECOMMENDED` | protocol | Admission policy rejected the task before Worker spawn |
| `CHECKPOINT_PLAN_NOT_APPROVED` | protocol | Checkpoint continuation requested after an unsuccessful planning round |
| `CHANGE_BUDGET_EXCEEDED` | scope | Worker exceeded the declared file-count or diff-line budget |

---

## 3. Status Values

All five status values are mutually exclusive and exhaustive.

| Status | When it occurs |
| --- | --- |
| `success` | No error; task completed normally |
| `needs_continuation` | Checkpoint planning completed; coordinator review is required before implementation |
| `failed` | An error occurred (scope violation, verification failure, protocol error, runtime crash, etc.) |
| `cancelled` | Task was interrupted by SIGINT or SIGTERM |
| `timeout` | Task exceeded `timeout_ms` |

---

## 4. Exit Codes

| Code | Meaning |
| ---: | --- |
| 0 | success or needs_continuation |
| 1 | failed |
| 2 | protocol / schema error (task.json invalid, task_id mismatch, etc.) |
| 124 | timeout |
| 130 | cancelled |
