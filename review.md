我看了你仓库里的实际代码。现在可以很明确地定位了，而且比我上一条猜得更准确：

**你现在其实有两个独立的 Node 生命周期 Bug。**

[你的 subagent-exec 仓库](https://github.com/tooandy/subagent-exec?utm_source=chatgpt.com)

---

## 1. 正常任务结束后 Node 还不退出：罪魁祸首是 `sleep(timeoutMs)`

我看了你现在的 `cli.ts`。

这里：

```typescript
const timeoutPromise = sleep(timeoutMs).then(
  () => {
    throw new Error("TIMEOUT");
  }
);

await Promise.race([settledPromise, timeoutPromise]);
```



这是当前**最核心的 Bug**。

假设：

```text
timeoutMs = 15 分钟
```

实际 Worker：

```text
第 30 秒 agent_settled
```

那么：

```text
Promise.race()
    ↓
settledPromise 胜出
    ↓
继续执行
```

但是：

```typescript
sleep(timeoutMs)
```

**并没有被取消。**

所以 Node 的 event loop 里面仍然有一个：

```text
15 分钟 Timer
```

这意味着：

```text
agent_settled
 ↓
Pi shutdown
 ↓
scope
 ↓
verification
 ↓
task_finished
 ↓
process.exitCode = 0
```

之后：

> **Node 不会立刻退出，因为那个 15 分钟的 timer 还活着。**

而你的代码最后只是：

```typescript
process.exitCode = ...
```

这只是在说：

> “Node 进程下次退出时返回这个 code。”

它**不会强制 Node 退出**。

所以你看到：

> 任务已经完成，但 node 进程还在。

这个我现在可以非常确定地说：**就是这里。**

---

# 2. 这也解释了为什么 `Ctrl+C` 只打印日志

你现在的代码是：

```typescript
const handleSignal = (signal: NodeJS.Signals) => {
  signalReceived = signal;

  logger.log("signal_received", {
    signal
  });
};

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));
```



这段代码**只记录 signal，没有做任何 cancellation。**

所以：

```text
Ctrl+C
 ↓
SIGINT
 ↓
signalReceived = "SIGINT"
 ↓
打印 signal_received
 ↓
什么都没发生
```

而你的主流程仍然卡在：

```typescript
await Promise.race([
  settledPromise,
  timeoutPromise
]);
```

它根本不知道：

```text
signalReceived
```

发生了。

更糟糕的是，**你只有等 `Promise.race()` 结束以后才检查 `signalReceived`**：

```typescript
if (signalReceived) {
   ...
}
```



所以如果 Worker 还要跑 10 分钟：

```text
Ctrl+C
 ↓
signal_received
 ↓
继续等 Worker
 ↓
agent_settled
 ↓
才发现 signalReceived
 ↓
shutdownPi
```

这显然是不对的。

---

# 3. 所以现在其实不用引入复杂的 CancellationController

我上一条给你的设计有点过度工程化了。

你这个项目当前最合适的解决方案其实很简单：

## 用一个真正可取消的 timeout + cancellation race。

Node 本身的 `timers/promises` 已经支持 `AbortSignal`。

你现在：

```typescript
import {
  setTimeout as sleep
} from "node:timers/promises";
```

可以继续用。

---

# 4. 建议直接改成 `AbortController`

在进入 Worker 执行阶段之后：

```typescript
const abortController =
  new AbortController();
```

然后 signal：

```typescript
let signalReceived:
  NodeJS.Signals | undefined;

process.on("SIGINT", () => {
  if (signalReceived) {
    return;
  }

  signalReceived = "SIGINT";

  logger.log("signal_received", {
    signal: "SIGINT"
  });

  abortController.abort();
});

process.on("SIGTERM", () => {
  if (signalReceived) {
    return;
  }

  signalReceived = "SIGTERM";

  logger.log("signal_received", {
    signal: "SIGTERM"
  });

  abortController.abort();
});
```

这样 signal 到来以后：

```text
Ctrl+C
 ↓
abortController.abort()
 ↓
Promise race 被打断
 ↓
shutdownPi()
```

---

# 5. timeout 也使用同一个机制

把你现在：

```typescript
const timeoutPromise = sleep(timeoutMs).then(
  () => {
    throw new Error("TIMEOUT");
  }
);
```

改成：

```typescript
const timeoutPromise =
  sleep(timeoutMs, undefined, {
    signal: abortController.signal
  }).then(() => {
    throw new Error("TIMEOUT");
  });
```

不过这里还存在一个问题：

**signal 和 timeout 共用了一个 AbortController，就无法区分到底是谁触发的。**

所以更干净的是两个 controller：

```typescript
const cancellationController =
  new AbortController();

const timeoutController =
  new AbortController();
```

然后：

```typescript
process.on("SIGINT", () => {
  signalReceived = "SIGINT";

  logger.log("signal_received", {
    signal: "SIGINT"
  });

  cancellationController.abort();
});

process.on("SIGTERM", () => {
  signalReceived = "SIGTERM";

  logger.log("signal_received", {
    signal: "SIGTERM"
  });

  cancellationController.abort();
});
```

timeout：

```typescript
const timeoutPromise =
  sleep(timeoutMs, undefined, {
    signal: timeoutController.signal
  }).then(() => {
    throw new Error("TIMEOUT");
  });
```

---

# 6. 但是更简单：直接做一个 `Promise.race`

我实际上更推荐你现在 V1.5 这么写：

```typescript
const timeoutPromise = new Promise<never>(
  (_, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error("TIMEOUT")
      );
    }, timeoutMs);

    cleanupTimers.push(() => {
      clearTimeout(timer);
    });
  }
);
```

然后：

```typescript
const cancellationPromise =
  new Promise<never>((_, reject) => {
    cancelReject = reject;
  });
```

Signal：

```typescript
cancelReject(
  new TaskCancelledError(
    signal
  )
);
```

最后：

```typescript
await Promise.race([
  settledPromise,
  timeoutPromise,
  cancellationPromise
]);
```

但我还是更推荐 `AbortController`，因为以后 verification timeout、stats timeout 都可以统一。

---

# 7. 你现在还有第三个小问题：`session_stats` 也留下了 Timer

这里：

```typescript
const timeoutPromise = sleep(5000).then(
  () => null
);

const statsResponse =
  await Promise.race([
    statsPromise,
    timeoutPromise
  ]);
```



同样存在：

```text
stats 返回
 ↓
Promise.race 结束
 ↓
5 秒 timer 仍然存在
```

这个只会让 Node 多活 5 秒，所以不是大问题。

但应该一起修掉。

---

# 8. 你当前的 `shutdownPi()` 本身其实已经写得不错

这个我得纠正我上一条的判断。

你现在已经有：

```text
RPC abort
 ↓
等待 3s
 ↓
SIGTERM
 ↓
等待 2s
 ↓
SIGKILL
 ↓
等待 1s
```



这部分架构是合理的。

所以**不是需要重新设计 shutdownPi**。

真正的问题是：

> **正常完成和 Ctrl+C 都没有可靠地进入 shutdown lifecycle。**

正常完成的问题是 Node 的 timer。

Ctrl+C 的问题是 signal handler 没有触发 cancellation。

---

# 9. 还有一个非常值得你马上修的点：`settledPromise` listener 泄漏

你现在：

```typescript
const settledPromise = new Promise<void>((resolve) => {
  const check = rpc.on((event) => {
    if (event.type === "agent_settled") {
      check();
      resolve();
    }
  });
});
```

这一段实际上还好，因为：

```typescript
check();
```

会把 listener 删除。

但如果发生：

```text
timeout
```

或者：

```text
SIGINT
```

那么：

```text
agent_settled 永远没来
```

这个 listener 就一直留在：

```typescript
PiRpcClient.listeners
```

里面。

所以最终应该让它有统一 cleanup。

---

# 10. 我建议你把第 7 步直接重构成这个模式

伪代码：

```typescript
let removeSettledListener:
  (() => void) | undefined;

let timeoutTimer:
  NodeJS.Timeout | undefined;

let cancelReject:
  ((error: Error) => void) | undefined;

const settledPromise =
  new Promise<void>((resolve) => {

    removeSettledListener =
      rpc.on((event) => {

        if (
          event.type === "agent_settled"
        ) {
          resolve();
        }

      });
  });

const timeoutPromise =
  new Promise<never>((_, reject) => {

    timeoutTimer =
      setTimeout(() => {
        reject(
          new Error("TIMEOUT")
        );
      }, timeoutMs);

  });

const cancelledPromise =
  new Promise<never>((_, reject) => {
    cancelReject = reject;
  });
```

Signal：

```typescript
const handleSignal = (
  signal: NodeJS.Signals
) => {

  if (signalReceived) {
    return;
  }

  signalReceived = signal;

  logger.log(
    "signal_received",
    { signal }
  );

  cancelReject?.(
    new Error(
      `CANCELLED:${signal}`
    )
  );
};
```

然后：

```typescript
try {

  await Promise.race([
    settledPromise,
    timeoutPromise,
    cancelledPromise
  ]);

} catch (error) {

  // timeout / cancellation

} finally {

  removeSettledListener?.();

  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
  }

}
```

这样生命周期才是闭合的。

---

# 11. 然后你的正常执行路径就是完全干净的

```text
agent_settled
      ↓
race resolved
      ↓
finally
  ├─ remove RPC listener
  └─ clear timeout
      ↓
get stats
      ↓
shutdownPi
      ↓
scope
      ↓
verification
      ↓
print result
      ↓
process.exitCode = 0
      ↓
Node event loop empty
      ↓
Node exits
```

不会再存在：

```text
15min timeout timer
```

挂在那里。

---

# 12. Ctrl+C 则是

```text
Ctrl+C
  ↓
SIGINT
  ↓
signal_received
  ↓
cancelReject()
  ↓
Promise.race reject
  ↓
cleanup timer/listener
  ↓
shutdownPi
     ↓
RPC abort
     ↓
SIGTERM
     ↓
SIGKILL
  ↓
build cancelled result
  ↓
exitCode = 130
  ↓
Node exits
```

这才是你 README 里已经承诺的：

```text
130 — Task cancelled by SIGINT
```

目前 README 已经定义了这个 exit code，但代码实际上还没有实现完整的 SIGINT cancellation lifecycle。([GitHub][1])

---

# 13. 还有一个我看完代码后发现的 scope 问题

你之前说：

> scope check 30 秒，因为 `git ls-files` 扫描 node_modules。

我现在看了最新代码，发现你**已经改掉了 `git ls-files`**：

```typescript
git(cwd, [
  "ls-files",
  "--others",
  "--exclude-standard"
])
```

而且 baseline 现在只是：

```typescript
git status --porcelain=v1 -z
```



所以这版已经比我之前看到的设计合理很多。

不过你现在 `checkScope()` 同时跑了 **5 个 git 命令**，其中：

```text
diff --name-only
ls-files --others
diff --cached --name-only
diff --name-only
diff --name-only --diff-filter=D
```

而且 `diff --name-only` 跑了两次。

这里还可以继续优化。

尤其：

```typescript
const [tracked, untracked, staged, modified, deleted]
```

里面：

```text
tracked = diff --name-only
modified = diff --name-only
```

是完全重复的。

可以直接删掉一个。

所以你现在 scope check **9 秒的问题，我暂时不会把锅全部甩给 node_modules**。更值得先测一下到底是哪一个 Git command 慢。

---

# 14. 最关键的结论

我现在看完你仓库的实际代码后，可以明确给你一个结论：

### 你现在的 Pi shutdown 机制其实已经基本正确。

问题不在：

```text
RPC abort
SIGTERM
SIGKILL
```

这部分。

真正的问题是 **Node Runtime Lifecycle**：

### Bug #1 —— P0

```typescript
sleep(timeoutMs)
```

在 `Promise.race()` 胜出后没有 cancel。

**这就是正常任务完成后 Node 还活着的直接原因。**

### Bug #2 —— P0

```typescript
SIGINT → signalReceived = SIGINT
```

只记录状态，没有打断当前等待。

**这就是 Ctrl+C 后只打印 `signal_received`，却不退出的直接原因。**

### Bug #3 —— P1

`session_stats` 的 5 秒 timeout timer 也没有 cleanup。

### Bug #4 —— P1

`settledPromise` 在 timeout/cancel 路径没有统一 cleanup。

### Bug #5 —— P2

`scope check` 有重复 Git 查询，需要继续优化。

---

## 我建议你现在让 Codex 直接修这 5 个点

而且**不要让它大改架构**。现在这个仓库只有 4 commits，代码结构已经很清楚：`cli.ts / process.ts / rpc.ts / workspace.ts / result.ts / usage.ts` 分层也合理。([GitHub][1])

给 Codex 的任务甚至可以非常明确：

> **修复 subagent-exec runtime lifecycle：**
>
> 1. 修复 `Promise.race` 中 timeout timer 未清理导致 Node 在任务完成后继续存活的问题。
> 2. SIGINT/SIGTERM 必须立即打断当前 worker wait，而不是仅设置 `signalReceived`。
> 3. cancellation 后必须执行 `shutdownPi()`，包括 RPC abort → SIGTERM → SIGKILL。
> 4. 所有 timeout timer、RPC listeners 必须在 `finally` 中清理。
> 5. session_stats timeout timer 同样必须 cleanup。
> 6. 保持现有 Task/Result Contract，不改变 stdout strict JSON。
> 7. `process.exitCode` 只负责 exit code，不允许用它代替 cleanup。
> 8. 增加测试：正常完成后 Node 必须在数秒内退出；Ctrl+C 必须返回 130；timeout 必须返回 124；Pi 必须不存在 orphan process。
> 9. 检查并删除 `workspace.ts` 中重复的 `git diff --name-only` 调用。

**这次我不建议再给 Codex 一大坨新架构。你的代码已经到了“修生命周期 bug”的阶段，而不是重新设计阶段。**

另外，你这个项目现在 README 所描述的架构已经很清楚：一任务一 Pi 进程、一无状态 session、JSONL RPC、stdout 严格 JSON、stderr 实时日志，这个边界我建议继续保持，不要为了修 lifecycle 把整个设计推倒重来。([GitHub][1])

[1]: https://github.com/tooandy/subagent-exec/tree/main/subagent-exec "subagent-exec/subagent-exec at main · tooandy/subagent-exec · GitHub"

