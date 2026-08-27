# subagent-exec

A stateless Worker Runtime for Pi coding agent.

Architecture:

```
Codex
  ↓
Task Contract
  ↓
subagent-exec
  ↓
Pi RPC process
  ↓
DeepSeek / MiniMax
  ↓
Task result
  ↓
Codex Review
```

## Design

V1 deliberately uses:

- one task = one Pi process
- one task = one stateless session
- `pi --mode rpc --no-session`
- JSONL RPC over stdin/stdout
- strict JSON result on stdout
- realtime JSONL logs on stderr

V1 does NOT implement:

- daemon mode
- worker pool
- cross-task session reuse
- task-to-task communication

## Install

```bash
npm install
npm run build
npm link
```

Make sure pi is available:

```bash
pi --version
```

## Run

```bash
subagent-exec --task examples/task.json
```

Or:

```bash
cat examples/task.json | subagent-exec
```

## Output

stdout:

```json
{
  "schema_version": "1.0",
  "task_id": "TEST-001",
  "status": "success"
}
```

stderr:

```json
{"event":"task_started","task_id":"TEST-001"}
{"event":"process_spawned","task_id":"TEST-001","pid":12345}
{"event":"prompt_accepted","task_id":"TEST-001"}
{"event":"agent_start","task_id":"TEST-001"}
{"event":"tool_execution_start","task_id":"TEST-001"}
{"event":"agent_end","task_id":"TEST-001"}
{"event":"agent_settled","task_id":"TEST-001"}
```

## Exit Codes

- `0` — Task succeeded.
- `1` — Task failed.
- `124` — Task timeout.
- `130` — Task cancelled by SIGINT.

## Task Contract

```json
{
  "task_id": "TASK-001",
  "objective": "Implement X",
  "prompt": "Detailed instructions...",
  "cwd": "/workspace/project",
  "allowed_paths": [
    "src/foo/**",
    "tests/foo/**"
  ],
  "constraints": [
    "Do not add dependencies"
  ],
  "acceptance_criteria": [
    "Tests pass"
  ],
  "model": {
    "provider": "deepseek",
    "model": "deepseek-chat"
  },
  "timeout_ms": 900000
}
```

## Error Categories

- **quota** — Provider quota or rate limit.
- **auth** — Authentication or credential failure.
- **token** — Context or token limit.
- **runtime** — Worker runtime failure, timeout, process crash, scope violation, etc.
- **protocol** — Invalid RPC protocol, missing final message, malformed JSON, etc.
