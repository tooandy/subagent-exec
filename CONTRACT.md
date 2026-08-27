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
| `prompt` | string | Self-contained instruction sent to the worker. Must include all necessary context. |

### Optional fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `objective` | string | — | High-level intent. Not sent to worker; carried for Codex tracking. |
| `cwd` | string | process cwd | Working directory for the worker. |
| `allowed_paths` | string[] (glob) | `[]` | Files/directories the worker is allowed to modify. Empty means scope is not checked. |
| `constraints` | string[] | `[]` | Constraints on the implementation (e.g. "no new dependencies"). |
| `acceptance_criteria` | string[] | `[]` | What Codex will check after the worker returns. |
| `verification` | object | — | Commands to run after worker completes (see below). |
| `model` | object | — | `{ provider, model }` to forward to the worker runtime. |
| `timeout_ms` | number | 900000 | Maximum execution time in ms. Max 24h. |
| `metadata` | object | — | Free-form data passed through to the Result. |

### verification sub-object

| Field | Type | Description |
| --- | --- | --- |
| `commands` | string[] | Shell commands to run after the worker finishes. Fail-fast on first failure. |
| `timeout_ms` | number | Per-command timeout (default 120000). |

### Example

```json
{
  "schema_version": "1.0",
  "task_id": "AUTH-001",
  "objective": "Add OAuth support",
  "prompt": "Implement OAuth 2.0 PKCE flow in src/auth/oauth.ts...",
  "cwd": "/workspace/project",
  "allowed_paths": [
    "src/auth/**",
    "tests/auth/**"
  ],
  "constraints": [
    "Do not add new dependencies"
  ],
  "acceptance_criteria": [
    "PKCE flow implemented",
    "Unit tests added",
    "All existing tests pass"
  ],
  "verification": {
    "commands": ["npm test"],
    "timeout_ms": 120000
  },
  "timeout_ms": 900000,
  "metadata": {
    "parent_agent": "codex",
    "attempt": 1
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
| `status` | enum | `success` / `failed` / `cancelled` / `timeout`. |
| `worker` | object | Worker runtime info. |
| `execution` | object | Timing and process info. |
| `result` | object | Worker output (summary, final message, changed files). |
| `scope` | object | Workspace scope verification. |
| `verification` | object | Verification command results. |
| `usage` | object | Token / cost usage (may be `null` if unavailable). |
| `error` | object or null | Structured error when status != success. |
| `metadata` | object | Echoed from Task Contract. |

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
  "changed_files": ["src/auth/oauth.ts"],
  "added_files": ["src/auth/oauth.ts"],
  "modified_files": [],
  "deleted_files": [],
  "violations": []
}
```

- `status` = `not_checked` when `allowed_paths` was empty
- `status` = `failed` when worker modified files outside `allowed_paths`

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

`status` = `not_run` when `verification.commands` was empty.

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

May be `null` if the worker runtime does not support session stats.

### error

```json
{
  "category": "runtime",
  "code": "TASK_TIMEOUT",
  "message": "Task exceeded 900000ms",
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
| `runtime` | Worker crash, timeout, cancellation, scope violation, exit nonzero | varies |
| `protocol` | Invalid RPC, missing events, schema mismatch | varies |
| `scope` | Worker modified files outside `allowed_paths` | no |
| `verification` | Verification command failed | no |

#### Common error codes

| Code | Meaning |
| --- | --- |
| `TASK_TIMEOUT` | Worker exceeded `timeout_ms` |
| `TASK_CANCELLED` | Worker interrupted by SIGINT/SIGTERM |
| `PI_PROCESS_EXIT_NONZERO` | Worker exited abnormally before `agent_settled` |
| `MODIFICATION_SCOPE_VIOLATION` | Worker changed files outside `allowed_paths` |
| `VERIFICATION_FAILED` | One or more verification commands failed |
| `AGENT_SETTLED_MISSING` | Worker ended without reporting completion |
| `FINAL_MESSAGE_MISSING` | Worker produced no assistant output |
| `PROMPT_REJECTED` | Worker runtime rejected the prompt |
| `TASK_ID_MISMATCH` | `--task-id` CLI flag disagreed with task.json |
| `PROVIDER_QUOTA_EXCEEDED` | Provider quota exhausted |
| `AUTH_ERROR` | Authentication / credential failure |
| `TOKEN_LIMIT` | Context or token limit exceeded |

---

## 3. Exit Codes

| Code | Status |
| ---: | --- |
| 0 | success |
| 1 | failed |
| 2 | protocol / schema error (task.json invalid, task_id mismatch, etc.) |
| 124 | timeout |
| 130 | cancelled |
