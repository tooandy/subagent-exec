对你现在这个 `subagent-exec` 架构，我建议把 **SKILL 和说明书彻底分成两层**：

* **SKILL.md：给 Codex 看，告诉它“什么时候用、怎么用、怎么判断结果、怎么继续工作”**
* **README / CONTRACT.md：给人和其他 Agent 看，定义 `subagent-exec` 本身的稳定接口**
* 不要把 Pi RPC 的实现细节塞进 Skill。Codex 不应该关心 Pi 的 `prompt/agent_settled/get_session_stats` 怎么实现，它只应该把 `subagent-exec` 当成一个可靠的 Worker API。

你这个项目的定位其实已经很清楚了：

```text
                 Codex
          Planner / Reviewer
                 │
        subagent-exec
        Worker Gateway
                 │
        ┌────────┴────────┐
        │                 │
       Pi                Pi
    Worker #1          Worker #2
        │                 │
     DeepSeek          MiniMax
```

---

# 一、我建议最终目录这样设计

```text
subagent-exec/
├── README.md
├── CONTRACT.md
├── SKILL.md
├── examples/
│   ├── task.json
│   ├── long_task.json
│   └── review_task.json
│
├── subagent-exec/
│   └── src/
│       ├── cli.ts
│       ├── rpc.ts
│       ├── process.ts
│       ├── result.ts
│       ├── usage.ts
│       └── workspace.ts
│
└── dist/
```

其中：

| 文件                | 使用者         | 作用                    |
| ----------------- | ----------- | --------------------- |
| `SKILL.md`        | Codex       | **怎么调用 Worker**       |
| `CONTRACT.md`     | Codex / 开发者 | **Task/Result 的正式协议** |
| `README.md`       | 人           | 安装、配置、调试、开发           |
| `examples/*.json` | Codex / 测试  | Task 示例               |

---

# 二、最重要的是 SKILL.md 不要写成“工具说明书”

很多 Skill 容易写成：

> `subagent-exec` 是什么、参数是什么、Pi 是什么……

这对 Codex 帮助不大。

你的 Skill 真正应该解决的是：

> **“我作为 Codex，现在手里有一个任务，什么情况下应该把它交给 Worker？交给 Worker 后怎么描述？拿到结果后怎么判断？失败后怎么办？”**

所以 Skill 应该是**决策规则 + 操作流程**。

---

# 三、我建议你的 `SKILL.md` 直接采用下面这个版本

可以直接放到：

```text
~/.codex/skills/subagent-exec/SKILL.md
```

或者你的项目 Skill 目录。

```markdown
# Subagent Worker Skill

## Purpose

`subagent-exec` is the standard worker gateway for delegating concrete
implementation, investigation, testing, refactoring, or review tasks to
an external coding agent.

The current worker runtime is Pi.

Codex is the planner, coordinator, and reviewer.
The worker is an executor.

The worker must not replace Codex's planning or final review responsibilities.

Architecture:

    Codex
      |
      | Task JSON
      v
    subagent-exec
      |
      v
    Pi Worker
      |
      v
    Workspace
      |
      v
    Result JSON
      |
      v
    Codex Review


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

Workers should perform bounded tasks with explicit acceptance criteria.


# When to Use a Worker

Use `subagent-exec` when a task is:

- implementation-heavy
- repetitive
- independently testable
- well-scoped
- suitable for execution by another coding agent
- useful to run in parallel with other tasks
- likely to consume substantial reasoning/tool-call budget

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


# When NOT to Use a Worker

Do not delegate a task when:

- the task requires understanding the entire project architecture
- the requirements are still ambiguous
- the task requires a major architectural decision
- the worker would need to make product-level decisions
- the result cannot be independently verified
- the task is so small that delegation overhead exceeds the work
- Codex needs to maintain continuous context across many dependent steps


# Task Decomposition

Before invoking a worker, Codex should convert the work into a concrete task.

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

    "Fix the project."

Instead:

    "Fix the RPC lifecycle in src/rpc.ts so that an agent_settled event
     cannot be missed when it arrives before prompt() returns."


# Task Contract

The task must be supplied as JSON.

Example:

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
  ]
}

See `CONTRACT.md` for the complete Task Contract.


# Task Prompt Requirements

The prompt sent to a worker must be self-contained.

Do not assume that the worker knows the conversation between Codex and the user.

Include:

- exact problem
- relevant files
- desired behavior
- constraints
- tests to run
- acceptance criteria

Bad:

    "Fix the timeout issue."

Good:

    "In src/cli.ts, the current Promise.race waits on a cancellation
     promise that resolves immediately. This causes the task to finish
     before agent_settled.

     Replace this with a real race between:
     1. agent_settled
     2. timeout
     3. SIGINT/SIGTERM cancellation

     Preserve the existing Result Contract.

     Add a regression test proving that a long-running task remains
     active until agent_settled."


# Scope

Workers must only modify files explicitly allowed by the task.

Codex should specify `allowed_paths` whenever the task has a meaningful
scope boundary.

Examples:

    allowed_paths:
      - src/rpc.ts
      - src/cli.ts
      - tests/rpc.test.ts

If the worker modifies files outside the allowed scope, treat the result
as requiring review.

Do not silently accept scope violations.


# Invocation

Run:

    subagent-exec --task <task.json>

Example:

    subagent-exec --task /tmp/task-RPC-042.json


# Output Contract

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


# Worker Status

Treat worker status as follows:

## completed

The worker claims that the task completed successfully.

This does NOT mean Codex should blindly accept the result.

Codex must still review:

- summary
- changed_files
- validation
- scope
- tests
- relevant code changes

## failed

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

## cancelled

The worker was intentionally interrupted.

Do not retry automatically.

Determine whether partial changes exist and inspect the workspace.

## timeout

The worker exceeded its execution budget.

Inspect partial changes before retrying.

Prefer splitting the task or increasing timeout only when justified.


# Error Handling

Errors are classified into categories such as:

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
- another model/provider
- reducing task size

### auth

Authentication or credential failure.

Do not modify the code to work around authentication failures.

### token

Token/context limitation.

Reduce task scope or split the task.

### scope

The worker modified files outside the permitted scope.

Review the diff before accepting anything.

### runtime

The worker process or RPC runtime failed.

Inspect logs and determine whether the task itself or the worker runtime is responsible.

### validation

The implementation was produced but validation failed.

Review the failure before retrying.


# Review Protocol

A worker result is evidence, not truth.

After a worker returns `completed`, Codex should verify:

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
reported `completed`.


# Parallel Workers

Independent tasks may be delegated to multiple workers.

Example:

    Worker A:
      implement RPC cancellation

    Worker B:
      add lifecycle regression tests

    Worker C:
      review usage parsing

Workers should not concurrently modify the same files unless explicitly
planned.

Prefer independent workspaces or sequential execution when tasks overlap.


# Worker Prompt Style

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


# Important Runtime Rules

The worker runtime currently follows:

    one task
      =
    one Pi process
      =
    one stateless session

Do not assume session state survives between invocations.

Do not rely on previous worker conversations.

Every task must contain all necessary context.


# Cost Control

The primary reason to use workers is to reduce expensive Codex execution.

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


# Recommended Workflow

For a non-trivial task:

1. Codex analyzes the requirement.
2. Codex creates a high-level plan.
3. Codex decomposes the plan into bounded worker tasks.
4. Codex invokes workers.
5. Workers implement concrete tasks.
6. Codex receives structured results.
7. Codex inspects important changes.
8. Codex runs integration tests when needed.
9. Codex fixes or delegates remaining problems.
10. Codex provides the final answer.

The worker is never the final authority.


# Failure Recovery

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

A retry should normally contain additional information or a smaller scope.


# Security / Safety

Never delegate secrets, credentials, private keys, or unrelated sensitive
data unless explicitly required.

Do not ask workers to modify files outside the intended project.

Do not disable tests, validation, or scope checking merely to make a task
pass.


# Summary

Codex = planner + coordinator + reviewer.

Worker = executor.

The correct pattern is:

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

---

# 四、然后 `CONTRACT.md` 才负责“协议”

这个文件不要写成教程。

它应该像 API specification。

我建议：

```markdown
# subagent-exec Task / Result Contract

## 1. Task Contract

### Required

| Field | Type | Description |
|---|---|---|
| schema_version | string | Contract version |
| task_id | string | Unique task identifier |
| prompt | string | Complete worker instruction |

### Optional

| Field | Type | Description |
|---|---|---|
| cwd | string | Worker working directory |
| timeout_ms | number | Maximum execution time |
| allowed_paths | string[] | Permitted modification paths |
| metadata | object | Caller-defined metadata |


## 2. Example

{
  "schema_version": "1.0",
  "task_id": "AUTH-001",
  "cwd": "/workspace/project",
  "prompt": "Implement...",
  "timeout_ms": 300000,
  "allowed_paths": [
    "src/auth/",
    "tests/auth/"
  ]
}


## 3. Result Contract

### Success

{
  "schema_version": "1.0",
  "task_id": "AUTH-001",
  "status": "completed",
  "summary": "...",
  "changed_files": [],
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0,
    "cost": 0
  },
  "validation": {
    "status": "passed",
    "commands": []
  }
}


## 4. Failure

{
  "schema_version": "1.0",
  "task_id": "AUTH-001",
  "status": "failed",
  "error": {
    "category": "runtime",
    "code": "RUNTIME_ERROR",
    "message": "...",
    "retryable": false
  }
}


## 5. Cancellation

{
  "schema_version": "1.0",
  "task_id": "AUTH-001",
  "status": "cancelled",
  "error": {
    "category": "runtime",
    "code": "TASK_CANCELLED",
    "message": "...",
    "retryable": false
  }
}


## 6. Timeout

{
  "schema_version": "1.0",
  "task_id": "AUTH-001",
  "status": "failed",
  "error": {
    "category": "runtime",
    "code": "TASK_TIMEOUT",
    "message": "...",
    "retryable": true
  }
}
```

---

# 五、但我建议再增加一个东西：`WORKFLOW.md`

这是因为你这个项目实际上已经不是简单的“subagent CLI”。

你真正要构建的是：

> **Codex → Worker 的 Agent Orchestration Pattern**

以后很可能会出现：

```text
Codex
 ├── Worker A：实现
 ├── Worker B：测试
 ├── Worker C：Review
 └── Worker D：调查
```

这时候 Skill 只告诉 Codex“怎么调用”。

而 `WORKFLOW.md` 告诉 Codex：

> **什么样的任务应该怎么拆。**

例如：

```markdown
# Worker Workflow

## Pattern 1: Implement + Review

Codex:
1. Analyze requirement.
2. Delegate implementation.
3. Review worker result.
4. Run integration validation.

Use when implementation is bounded.


## Pattern 2: Investigate + Implement

Worker A:
    investigate root cause

Codex:
    review investigation

Worker B:
    implement fix

Codex:
    validate


## Pattern 3: Parallel Implementation

Worker A:
    backend

Worker B:
    tests

Worker C:
    documentation

Only use when file scopes do not overlap.


## Pattern 4: Worker as Reviewer

Worker:
    inspect implementation

Codex:
    use review as evidence

Codex remains final reviewer.
```

---

# 六、实际上你的 Skill 最重要的是告诉 Codex：**不要让 Worker 替自己思考**

这是整个架构最核心的一点。

例如用户说：

> “帮我给这个 Agent 增加自动 Skill 优化。”

Codex 不应该直接：

```text
Worker:
    给我把自动 Skill 优化做了
```

而应该：

```text
Codex
 │
 ├─ 分析现有 Skill architecture
 │
 ├─ Task A
 │    调研 Langfuse evaluation
 │
 ├─ Task B
 │    实现 evaluator
 │
 ├─ Task C
 │    实现 optimizer
 │
 ├─ Task D
 │    添加测试
 │
 └─ Codex
      ↓
    review
      ↓
    integration
```

这才真正能发挥：

**Codex 的高质量 reasoning + DeepSeek/MiniMax 的低成本 execution。**

---

# 七、还有一个非常重要的设计：Skill 不应该绑定 DeepSeek / MiniMax

这一点我非常建议你现在就做对。

不要在：

```text
SKILL.md
```

里写：

```text
Pi 使用 DeepSeek
Pi 使用 MiniMax
```

应该只写：

```text
subagent-exec
    ↓
external worker
```

因为以后你很可能会变成：

```text
subagent-exec
    ├── pi + DeepSeek
    ├── pi + MiniMax
    ├── another worker
    └── future worker
```

甚至：

```text
subagent-exec --profile cheap
subagent-exec --profile coding
subagent-exec --profile review
```

Codex 不需要知道。

---

# 八、我甚至建议你把 `subagent-exec` 定义成一个“Worker ABI”

这是我觉得你这个项目后面最有价值的方向。

不要把它理解成：

> “我写了一个程序让 Codex 调 Pi。”

而应该定义成：

> **`subagent-exec` 是 Codex 与廉价外部 Agent 之间的标准 Worker Interface。**

于是：

```text
                    Worker Interface
                         │
              ┌──────────┼──────────┐
              │          │          │
             Pi       Claude      xxx
              │          │          │
         DeepSeek     MiniMax      ...
```

统一：

```text
Task Contract
Result Contract
Exit Codes
JSONL Events
Cancellation
Timeout
Scope
Usage
Error Categories
```

这时候 Pi 只是第一个 backend。

---

# 九、最终 Codex 使用起来应该非常简单

理想情况下，Codex 只需要知道：

```bash
subagent-exec --task /tmp/task.json
```

然后：

```json
{
  "task_id": "RPC-042",
  "status": "completed",
  "summary": "Fixed RPC lifecycle race",
  "changed_files": [
    "src/cli.ts",
    "src/rpc.ts"
  ],
  "usage": {
    "input_tokens": 12430,
    "output_tokens": 3821,
    "total_tokens": 16251,
    "cost": 0.18
  },
  "validation": {
    "status": "passed",
    "commands": [
      "npm test"
    ]
  }
}
```

Codex 接下来：

```text
读取 Result
     ↓
看 changed_files
     ↓
git diff
     ↓
review
     ↓
测试
     ↓
继续下一 Task / 接受
```

**这就是你真正想要的工作流。**

---

## 我给你一个最终的职责边界

| 层                    | 负责什么                                              |
| -------------------- | ------------------------------------------------- |
| **Codex**            | 理解需求、架构、拆解、调度、最终 Review                           |
| **SKILL.md**         | 告诉 Codex 如何正确使用 Worker                            |
| **subagent-exec**    | Worker 生命周期、RPC、timeout、cancel、scope、usage、Result |
| **CONTRACT.md**      | Task/Result/错误/exit code 的稳定协议                    |
| **Pi**               | 实际执行 Agent                                        |
| **DeepSeek/MiniMax** | Worker 的模型能力                                      |

这样以后你甚至可以**完全替换 Pi，而不需要改 Codex Skill**。

而且这套东西一旦稳定下来，你之前一直在研究的 **“Codex 规划 + Worker 执行 + Codex Review”** 就真正落地了，而不是简单地让一个 Agent 去调用另一个 Agent。

