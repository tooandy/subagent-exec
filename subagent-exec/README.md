# subagent-exec (source)

This directory contains the source code for `subagent-exec`.

For installation, architecture, and usage, see the top-level
[`README.md`](../README.md).

For the Task / Result JSON contracts, see
[`CONTRACT.md`](../CONTRACT.md).

For how Codex should use this as a worker gateway, see
[`SKILL.md`](../SKILL.md).

For task decomposition patterns, see
[`WORKFLOW.md`](../WORKFLOW.md).

## Source layout

```
subagent-exec/
├── bin/
│   └── subagent-exec.js     # Executable entrypoint
├── src/
│   ├── cli.ts               # Main CLI, lifecycle, race, signals
│   ├── types.ts             # All shared types
│   ├── task.ts              # Zod schema for Task Contract
│   ├── process.ts           # Spawns the worker process
│   ├── rpc.ts               # JSONL RPC client
│   ├── result.ts            # State machine for RPC events
│   ├── usage.ts             # Parses session_stats response
│   ├── workspace.ts         # Git baseline + scope verification
│   ├── verify.ts            # Runs verification commands
│   ├── errors.ts            # Error classification
│   └── logger.ts            # JSONL lifecycle logger
├── examples/                # Task Contract samples
├── package.json
└── tsconfig.json
```

## Build

```bash
npm install
npm run build
```
