我重新按你说的 **`d457551`** 看了最新代码。现在这 4 个问题其实可以串成一个很明确的根因链，而且这里有一个比前面更重要的问题：

> **目前 `subagent-exec` 对 Pi RPC 的“任务完成语义”理解错了。**

这不是简单的 `SIGINT` 测试问题。

### 先给结论

你现在的执行链实际上是：

```text
subagent-exec
    │
    ├─ spawn pi --mode rpc --no-session
    │
    ├─ rpc.prompt(task.prompt)
    │
    ├─ 收到某个 response
    │
    ├─ 立即认为 agent 已经 settled
    │
    └─ buildResult()
```

而正确的应该是：

```text
subagent-exec
    │
    ├─ spawn Pi
    │
    ├─ 建立 RPC event listener
    │
    ├─ prompt
    │
    ├─ 等待真正的 agent lifecycle
    │      │
    │      ├─ agent_start
    │      ├─ message/tool/...
    │      ├─ agent_end
    │      └─ agent_settled
    │
    ├─ 获取最终 assistant message
    ├─ get_session_stats
    └─ shutdown Pi
```

而你现在代码里面，**最危险的一处就是 `awaitWithCancellation()`。**

---

# 1. 你现在的 `awaitWithCancellation()` 有一个致命 bug

最新代码里：

```ts
function awaitWithCancellation(
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {

    ...

    const timer = setTimeout(...);

    ...

    resolve();
  });
}
```

也就是说：

> **这个 Promise 在创建的时候就立即 `resolve()` 了。**

然后下面：

```ts
const settledPromise = new Promise<void>((resolve) => {
  removeSettledListener = rpc.on((event) => {
    if (event.type === "agent_settled") {
      resolve();
    }
  });
});

const cancellationPromise =
  awaitWithCancellation(timeoutMs);

await Promise.race([
  settledPromise,
  cancellationPromise
]);
```

这里实际上发生的是：

```text
settledPromise
    ↓
等待 agent_settled

cancellationPromise
    ↓
awaitWithCancellation()
    ↓
resolve()
    ↓
立即完成
```

所以：

```text
Promise.race()
    ↓
几乎立即完成
```

这就完美解释了你现在看到的：

```text
prompt 发出
 ↓
~200ms
 ↓
agent_settled
```

以及为什么：

```text
assistantMessages = 0
toolCalls = 0
tokens = 0
```

---

# 2. 所以第一个问题其实不是“任务运行太快”

你报告：

> LONG-005 200ms 就完成，无法测试 SIGINT

实际上**不是 Pi 真的 200ms 完成了任务**。

是你的：

```ts
awaitWithCancellation()
```

自己立即 resolve 了。

所以当前测试得到的：

```text
200ms
```

没有任何意义。

这是当前版本的 **P0 bug**。

---

# 3. 正确实现应该是“三方竞争”

这里真正需要的是：

```text
               ┌─ agent_settled
               │
Promise.race ──┼─ timeout
               │
               └─ cancellation
```

而不是：

```text
Promise.race(
    agent_settled,
    一个立即 resolve 的 Promise
)
```

---

# 4. 我建议直接删掉 `awaitWithCancellation()`

这个函数现在职责混乱，而且实际上实现错误。

直接在 `main()` 中建立三个 Promise：

```ts
const settledPromise =
  new Promise<void>((resolve) => {
    removeSettledListener = rpc.on((event) => {
      if (event.type === "agent_settled") {
        resolve();
      }
    });
  });

const timeoutPromise =
  new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

const cancellationPromise =
  new Promise<never>((_, reject) => {
    cancellationReject = reject;
  });
```

然后：

```ts
await Promise.race([
  settledPromise,
  timeoutPromise,
  cancellationPromise
]);
```

这样才是真正的：

```text
agent_settled
timeout
SIGINT/SIGTERM
```

三选一。

---

# 5. 但这里又暴露了第二个问题：Cancellation Controller 目前是全局的

你现在：

```ts
const cancellationController =
  new AbortController();
```

是在 module level。

这对于：

```text
一进程 = 一个 task
```

其实暂时没有问题。

但是它和：

```ts
awaitWithCancellation()
```

组合以后会非常容易出现状态混乱。

我建议 V1.5 不要搞复杂：

```text
Runtime
 ├── signal
 ├── cancellationPromise
 ├── timeoutPromise
 └── worker
```

统一管理。

---

# 6. 第二个问题：为什么 `final_message` 变成了 prompt？

这个也能从你的代码直接解释。

你的 `result.ts` 的 `updateRpcState()` 本身并没有主动读取 `prompt`：

```ts
case "message_start":
case "message_end":
case "message_update":
```

它只要看到符合结构的 message，就会：

```ts
state.finalMessage = text;
```

问题在于：

> **你现在没有区分 user message 和 assistant message。**

也就是说：

```text
user message
    ↓
message_start
    ↓
extractText()
    ↓
finalMessage = task.prompt
```

所以最后：

```json
{
  "summary": "请使用 sleep 命令 sleep 60..."
}
```

不是 Pi 给你的 assistant response。

而是：

> **你把 user prompt 当成了 final message。**

---

# 7. 这里必须改成“只接受 assistant message”

这是非常重要的。

你的 `extractText()` 本身没问题。

问题是：

```ts
case "message_start":
```

不能无条件：

```ts
state.finalMessage = text;
```

应该判断：

```ts
message.role === "assistant"
```

例如：

```ts
function isAssistantMessage(
  message: unknown
): boolean {
  if (
    !message ||
    typeof message !== "object"
  ) {
    return false;
  }

  const role =
    (message as Record<string, unknown>).role;

  return role === "assistant";
}
```

然后：

```ts
case "message_end": {
  if (
    isAssistantMessage(event.message)
  ) {
    const text =
      extractText(event.message);

    if (text) {
      state.finalMessage = text;
    }
  }

  break;
}
```

`message_start` 同样。

---

# 8. `message_update` 也要保护

现在：

```ts
case "message_update": {
  const assistantEvent =
    event.assistantMessageEvent;

  if (...) {
    if (e.type === "text_delta") {
      state.finalMessage =
        (state.finalMessage ?? "") +
        e.delta;
    }
  }
}
```

这里虽然变量叫：

```text
assistantMessageEvent
```

看起来像 assistant，但最好还是不要假设。

至少应该维护：

```ts
state.currentAssistantMessage
```

而不是直接把所有 `text_delta` 都拼进 `finalMessage`。

---

# 9. 最稳妥的 Result State 应该这样设计

我建议：

```ts
interface RpcState {
  settled: boolean;
  agentStarted: boolean;
  agentEnded: boolean;

  assistantMessage?: string;

  usage?: UsageInfo;
}
```

然后：

```text
message_start
    ↓
判断 role
    ↓
assistant?
    ↓ yes
开始 currentAssistantMessage

message_update
    ↓
assistant text_delta
    ↓
append

message_end
    ↓
assistant
    ↓
assistantMessage = complete text
```

最终：

```ts
final_message:
  state.assistantMessage
```

而不是：

```ts
state.finalMessage
```

这种命名也更准确。

---

# 10. 第三个问题：为什么 `agent_settled` 会这么早？

这里要特别注意。

**在修掉 `awaitWithCancellation()` 之后再判断这个问题。**

目前：

```text
200ms
```

本身就是假的。

但是修完以后，如果依然：

```text
agent_start
agent_end
agent_settled
```

在 200ms 内出现，那才需要进一步查 Pi RPC。

所以当前不要先修改 Pi RPC protocol。

---

# 11. 第四个问题：usage = 0 是前两个问题的自然结果

这个就非常容易解释了。

你的：

```text
agent
 ↓
实际上没有运行
 ↓
没有 LLM
 ↓
没有 tool
 ↓
没有 tokens
```

然后：

```ts
getSessionStats()
```

自然得到：

```text
0
```

所以目前：

> **usage 不是独立 Bug。**

先修 execution lifecycle。

---

# 12. 但 `usage.ts` 我也建议一起增强

目前：

```ts
const respData =
  response.data ??
  response.stats ??
  response;
```

然后只认识：

```text
tokens.input
tokens.output
```

你之前已经遇到过：

```text
session_stats_unavailable
```

所以我建议不要继续猜字段。

**直接记录原始 `get_session_stats` response 到 JSONL。**

例如：

```text
session_stats_requested
response
session_stats_parsed
```

其中：

```json
{
  "event": "session_stats_response",
  "data": {
    "rpc": { ...原始 response... }
  }
}
```

这样以后 Pi 升级 API，我们可以直接看到实际格式。

---

# 13. 还有一个很关键的问题：你现在 `rpc.prompt()` 等 response

这里：

```ts
const response =
  await rpc.prompt(task.prompt);
```

这本身没问题。

但要理解：

```text
prompt response
```

**不等于：**

```text
agent finished
```

它只代表：

```text
Pi 接受了这个 RPC command
```

所以正确语义应该是：

```text
rpc.prompt()
      ↓
prompt accepted
      ↓
WAIT
      ↓
agent_start
      ↓
...
      ↓
agent_end
      ↓
agent_settled
```

你现在实际上已经在等 `agent_settled`，这个方向是对的。

---

# 14. 还有一个 race condition，我建议顺手修

你目前是：

```text
prompt()
  ↓
await response
  ↓
再注册 agent_settled listener
```

如果 Pi 极快：

```text
prompt
 ↓
agent_start
agent_end
agent_settled
 ↓
response
```

那么：

```text
agent_settled
```

可能已经发生了。

于是你后面才：

```ts
rpc.on(...)
```

就永远收不到。

**正确顺序应该是：**

```text
spawn Pi
 ↓
注册所有 event listener
 ↓
创建 settledPromise
 ↓
发送 prompt
 ↓
等待
```

也就是：

```ts
const settledPromise =
  waitForAgentSettled(rpc);

const response =
  await rpc.prompt(task.prompt);

await Promise.race([
  settledPromise,
  timeoutPromise,
  cancellationPromise
]);
```

而不是：

```ts
await rpc.prompt();

const settledPromise =
  waitForAgentSettled(rpc);
```

这个 race condition 在你的 Pi 这种轻量 runtime 里尤其值得防。

---

# 15. Signal 的问题也因此可以真正测试了

把上述 P0 修掉以后：

```json
{
  "timeout_ms": 120000
}
```

然后：

```bash
node dist/cli.js --task long_task.json &
PID=$!

sleep 4

kill -INT $PID

wait $PID

echo $?
```

应该看到：

```text
process_spawned
prompt_sent
prompt_accepted
agent_start
...
signal_received
task_cancelled
shutdown_abort_requested
shutdown_abort_sent
...
```

最终：

```json
{
  "status": "cancelled",
  "error": {
    "code": "TASK_CANCELLED"
  }
}
```

exit code：

```text
130
```

---

# 16. 我建议这次不要只修代码，要加 5 个回归测试

这个项目现在已经进入一个阶段：

> **没有 lifecycle tests，后面每改一次都可能把另一个生命周期 bug 带回来。**

至少加：

### Test 1 — 正常完成

```text
prompt
→ agent_start
→ agent_end
→ agent_settled
→ result
→ Node exit
```

验证：

```text
exit = 0
process exits
final_message = assistant response
usage > 0
```

---

### Test 2 — Cancellation

```text
start
→ SIGINT
→ cancellation
→ abort
→ shutdown
→ exit 130
```

验证：

```text
signal_received
task_cancelled
Pi 不存在
```

---

### Test 3 — Timeout

```text
start
→ timeout
→ abort
→ shutdown
→ exit 124
```

---

### Test 4 — Fast agent

这是最重要的 race test：

```text
agent_start
agent_end
agent_settled
```

在 prompt response **之前**完成。

验证不会丢 `agent_settled`。

---

### Test 5 — Prompt ≠ final message

输入：

```text
user:
hello
```

assistant：

```text
hello, I am done
```

验证：

```json
"final_message": "hello, I am done"
```

而不是：

```json
"final_message": "hello"
```

---

# 17. 我建议你让 Codex 这次直接按这个任务修

可以直接把下面这段扔给 Codex：

```text
修复 subagent-exec 当前 commit d457551 的 execution lifecycle。

问题：

1. awaitWithCancellation() 当前 Promise executor 最后无条件 resolve()，
   导致 cancellationPromise 创建后立即完成，Promise.race() 不会等待
   agent_settled。这是 P0。

2. task execution 的等待必须是真正的三方 race：
   agent_settled / timeout / SIGINT|SIGTERM cancellation。

3. 必须先注册 RPC event listener 和 agent_settled listener，
   再发送 prompt，避免极快 Pi 在 listener 注册前已经产生
   agent_settled 的 race condition。

4. prompt RPC response 只表示 prompt command accepted，
   不表示 agent execution finished。

5. result.ts 当前没有区分 user message 和 assistant message，
   导致 final_message 可能被 user prompt 覆盖。
   final_message 必须只能来自 assistant message。
   message_start/message_end/message_update 都需要正确处理
   assistant role。

6. 重命名 RpcState.finalMessage 为 assistantMessage（如果不会造成
   不必要兼容问题），明确其语义。

7. session_stats 的 usage=0 目前是 execution 没有真正执行导致的
   连带问题。修复 execution lifecycle 后重新验证。
   同时增加 session_stats 原始 response 的 JSONL debug event，
   方便确认 Pi RPC 实际返回格式。

8. timeout timer、settled listener、cancellation listener 必须在
   finally 中清理，不能因为 Promise.race 结束而遗留 active timer。

9. 保持：
   - 一任务一 Pi 进程
   - 一任务一无状态 session
   - stdout 严格 JSON
   - stderr/JSONL 实时日志
   - RPC abort -> SIGTERM -> SIGKILL shutdown
   - 现有 Task Contract / Result Contract

10. 增加回归测试：
   - normal completion
   - SIGINT cancellation
   - SIGTERM cancellation
   - timeout
   - fast agent_settled before prompt response
   - final_message 必须是 assistant message
   - 正常结束后 Node event loop 必须能退出
   - cancellation 后 Pi 不得成为 orphan process

不要重新设计整个项目，只修 execution lifecycle、message extraction
和测试。
```

---

## 最后一个判断很重要

这次你暴露出来的 4 个“错误”，实际上不是 4 个独立问题：

```text
awaitWithCancellation() 立即 resolve
             │
             ▼
       worker 没有真正等待
             │
       ┌─────┴──────┐
       ▼            ▼
  200ms结束       没有LLM
       │            │
       ▼            ▼
final_message     usage=0
拿到了 prompt
```

所以**第一优先级只有一个：修 execution wait lifecycle。**

修完以后再跑 LONG-005。

如果它真的能跑到：

```text
sleep 60
```

那时候再发：

```bash
kill -INT $PID
```

我们才是在测试真正的 SIGINT cancellation，而不是在测试当前这个“200ms 假完成”。

另外，当前 `process.ts` 的 Pi 启动方式本身仍然是普通 `spawn("pi", ["--mode","rpc","--no-session"])`，没有 detached process 等会干扰 signal/process-group 的配置，所以这次我**不建议再去碰 Pi spawn 层**。

