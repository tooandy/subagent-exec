我看了你仓库的**最新代码**。这次问题我认为已经比较明确了：**不是 `AbortController` 的问题，也不是 `Promise.race()` 的问题，而是 Signal handler 的安装时机 + 你当前对子进程生命周期的处理方式值得调整。**

你的最新 `cli.ts` 确实已经有：

```ts
process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));
```

而 `handleSignal()` 也确实会：

```ts
cancelReject?.(new CancelledError(signal));
cancellationController.abort();
```

所以**从代码逻辑上看，Signal 一旦进入 Node，理论上应该立即打印 `signal_received` 并打断等待**。Node 官方文档也明确说明，安装了 `SIGINT` listener 后，Node 会触发该 listener，而不是执行默认退出行为。([Node.js][1])

但你的实验是：

```bash
node dist/cli.js --task long_task.json &
PID=$!
sleep 4
kill -INT $PID
```

然后：

```text
没有 signal_received
Node 继续运行
60s 后正常结束
```

这说明一个非常关键的事实：

> **`SIGINT` 根本没有到达你安装 handler 的那个 Node 进程。**

---

# 一、先说我认为最重要的原因

你现在的测试方式：

```bash
node dist/cli.js ... &
PID=$!
kill -INT $PID
```

和：

```text
Ctrl+C
```

其实是两个不同的 Signal 场景。

`Ctrl+C` 是终端的 **foreground process group** 收到 SIGINT。

而：

```bash
kill -INT $PID
```

是直接向某个 PID 发 POSIX signal。

正常情况下二者都应该最终让 Node 收到 SIGINT。

所以：

> **如果 `kill -INT $PID` 确实针对的是 Node PID，那么 Node 没收到 SIGINT 是不正常的。**

Node 官方 API 明确规定 `process.kill(pid, signal)` 会向指定 PID 发送 signal。([Node.js][1])

因此现在第一件事不是继续改代码，而是**确认 `$PID` 到底是不是你以为的 Node PID**。

---

# 二、你马上执行这个测试

不要用：

```bash
PID=$!
```

猜。

直接：

```bash
node dist/cli.js --task long_task.json &
PID=$!

echo "PID=$PID"

ps -o pid,ppid,pgid,sid,stat,cmd -p "$PID"

sleep 4

echo "sending SIGINT to $PID"

kill -INT "$PID"

sleep 1

ps -o pid,ppid,pgid,sid,stat,cmd -p "$PID"
```

你应该看到类似：

```text
PID=12345

  PID   PPID   PGID    SID STAT CMD
12345  10000  12345  10000 S    node dist/cli.js ...

sending SIGINT to 12345

  PID   PPID   PGID    SID STAT CMD
12345  10000  12345  10000 S    node dist/cli.js ...
```

如果还是这样，我们继续。

---

# 三、再做一个非常关键的对照实验：SIGTERM

直接：

```bash
node dist/cli.js --task long_task.json &
PID=$!

sleep 4

kill -TERM "$PID"

wait "$PID"

echo "exit=$?"
```

### 如果得到：

```text
signal_received SIGTERM
```

那就非常有意思了：

```text
SIGTERM ✅
SIGINT  ❌
```

这种情况下重点查 SIGINT。

---

### 如果连 SIGTERM 都没有：

```text
SIGTERM ❌
SIGINT  ❌
```

那么我会优先怀疑：

> **你测试的 PID 不是实际正在运行的 Node，或者 Node 进程的 signal disposition 被改变。**

---

# 四、我建议你在 `cli.ts` 最顶部直接加入一个诊断

在 `main()` **之前**安装 signal handler。

现在你的 handler 是在：

```text
load task
 ↓
capture baseline
 ↓
spawn Pi
 ↓
create rpc
 ↓
...
 ↓
安装 signal handler
```

之后才注册的。

这虽然不解释你“4 秒以后”仍然收不到 signal 的问题，但**没有必要承担这个风险**。

现在的结构应该改成：

```ts
let signalReceived: NodeJS.Signals | undefined;

let cancelReject:
  ((error: Error) => void) | undefined;

function handleSignal(signal: NodeJS.Signals) {
  ...
}

process.on("SIGINT", () => {
  handleSignal("SIGINT");
});

process.on("SIGTERM", () => {
  handleSignal("SIGTERM");
});

async function main() {
   ...
}
```

也就是：

```text
Node 启动
 ↓
立即注册 SIGINT/SIGTERM
 ↓
main()
```

而不是：

```text
Node 启动
 ↓
main()
 ↓
很多 async initialization
 ↓
注册 signal handler
```

这才是一个 CLI runtime 应该有的结构。

---

# 五、但是这里有一个更深的问题

你现在的 handler：

```ts
const handleSignal = (signal: NodeJS.Signals) => {
  if (signalReceived) {
    logger.log("signal_force_exit", { signal });
    process.exit(130);
  }

  signalReceived = signal;

  logger.log("signal_received", { signal });

  cancelReject?.(
    new CancelledError(signal)
  );

  cancellationController.abort();
};
```

这里实际上存在一个设计问题：

## Signal handler 依赖 `cancelReject`

但是：

```ts
let cancelReject:
  ((error: Error) => void) | undefined;
```

是在后面才赋值的。

所以如果：

```text
SIGINT
 ↓
cancelReject === undefined
```

handler 虽然打印了：

```text
signal_received
```

但不会真正打断 worker。

这不是你当前“完全没有日志”的原因，但它说明 lifecycle 设计还可以再收紧。

---

# 六、最好的方式其实是不需要 `cancelReject`

我建议你直接用一个统一的 cancellation Promise。

例如：

```ts
let resolveCancellation:
  ((signal: NodeJS.Signals) => void) | undefined;

const cancellationPromise =
  new Promise<never>((_, reject) => {
    resolveCancellation = (signal) => {
      reject(
        new CancelledError(signal)
      );
    };
  });
```

然后：

```ts
function handleSignal(
  signal: NodeJS.Signals
) {
  if (signalReceived) {
    logger.log(
      "signal_force_exit",
      { signal }
    );

    process.kill(
      process.pid,
      "SIGKILL"
    );

    return;
  }

  signalReceived = signal;

  logger.log(
    "signal_received",
    { signal }
  );

  resolveCancellation?.(signal);
}
```

但这依然只是实现细节。

---

# 七、实际上我更推荐：`AbortController` 作为唯一 Cancellation Source

你现在已经有：

```ts
const cancellationController =
  new AbortController();
```

那就干脆不要再同时维护：

```text
signalReceived
cancelReject
cancellationController
```

三套状态。

统一：

```text
Signal
  ↓
AbortController.abort(reason)
  ↓
Worker wait abort
  ↓
shutdown
```

Node 的很多 API 本身都已经支持 AbortSignal，包括 child process。([Node.js][2])

---

# 八、不过你的 Pi 子进程还有一个值得注意的问题

现在：

```ts
const child = spawn(
  "pi",
  args,
  {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env
  }
);
```

这里没有：

```ts
detached: true
```

这是**正确的**。

不要因为现在 Signal 有问题就去加：

```ts
detached: true
```

否则反而会让 process group 生命周期变复杂。

Node 官方对 `detached` 的定义就是让 child 独立于 parent 运行。([Node.js][2])

你的设计是：

```text
subagent-exec
      │
      └── Pi
```

Pi 就应该是普通 child。

---

# 九、还有一个非常重要的测试

我建议你暂时**绕过 Pi**，证明 Node 自己到底能不能收到 SIGINT。

创建：

```bash
node -e '
process.on("SIGINT", () => {
  console.error("GOT SIGINT");
  process.exit(130);
});
setInterval(() => {
  console.error("alive", process.pid);
}, 1000);
' &
PID=$!

echo PID=$PID
sleep 3
kill -INT "$PID"
wait "$PID"

echo exit=$?
```

正常应该：

```text
PID=12345
alive 12345
alive 12345
GOT SIGINT
exit=130
```

---

## 如果这个测试都失败

那就**完全不是 `subagent-exec` 的代码问题**。

你的 shell / 环境 / signal forwarding 有问题。

---

## 如果这个测试成功

那么：

```text
Node signal 机制 ✅
```

再测试：

```bash
node dist/cli.js ...
```

如果失败，就说明是：

```text
subagent-exec
```

自己改变了运行环境/生命周期。

---

# 十、我看你的代码后，还有一个非常值得做的检查

你现在：

```ts
spawnPi(...)
```

是在注册 signal handler **之前**执行的。

而 Pi 本身是：

```ts
spawn("pi", ...)
```

普通 child process。

所以我建议把 signal registration 提到 `main()` 最前面，甚至：

```ts
const runtime =
  new RuntimeController(logger);
```

在任何：

```text
loadTask
captureBaseline
spawnPi
RPC
```

之前初始化。

---

# 十一、我认为最终应该形成这样的结构

这是你现在 `subagent-exec` 最需要稳定下来的 Runtime 架构：

```text
┌───────────────────────────────────────┐
│              Node CLI                 │
│                                       │
│  installSignalHandlers()              │
│          │                            │
│          ▼                            │
│  RuntimeCancellation                 │
│          │                            │
│    ┌─────┴─────┐                      │
│    │           │                      │
│ SIGINT      SIGTERM                   │
│    │           │                      │
│    └─────┬─────┘                      │
│          ▼                            │
│       abort()                         │
│          │                            │
│          ▼                            │
│     worker wait                       │
│          │                            │
│          ▼                            │
│     shutdownPi()                      │
│          │                            │
│       RPC abort                       │
│          │                            │
│       SIGTERM                         │
│          │                            │
│       SIGKILL                         │
│          │                            │
│          ▼                            │
│      result JSON                      │
│          │                            │
│       exitCode                        │
└───────────────────────────────────────┘
```

---

# 十二、但现在先不要改太多

**我建议你先做下面三个实验，结果基本就能把问题钉死：**

### Test A：最小 Node

```bash
node -e 'process.on("SIGINT",()=>{console.error("GOT SIGINT");process.exit(130)});setInterval(()=>console.error("alive",process.pid),1000)' &
PID=$!
sleep 3
kill -INT "$PID"
wait "$PID"
echo "exit=$?"
```

### Test B：subagent-exec + SIGTERM

```bash
node dist/cli.js --task long_task.json &
PID=$!
sleep 4
kill -TERM "$PID"
wait "$PID"
echo "exit=$?"
```

### Test C：subagent-exec + SIGINT

```bash
node dist/cli.js --task long_task.json &
PID=$!
sleep 4
kill -INT "$PID"
wait "$PID"
echo "exit=$?"
```

把 **A/B/C 三个结果**给我。

我现在最想确认的是：

```text
A: SIGINT ?
B: SIGTERM ?
C: SIGINT ?
```

如果是：

```text
A ✅
B ❌
C ❌
```

我会继续查你的 runtime signal disposition。

如果：

```text
A ✅
B ✅
C ❌
```

那就专门查 SIGINT。

如果：

```text
A ✅
B ❌
C ❌
```

则很可能是你当前 Node 进程在某个初始化阶段修改了 signal disposition。

而如果：

```text
A ✅
B ✅
C ✅
```

但你的原测试仍然失败，那就说明**你测试脚本里的 `$PID` 或实际启动链路有问题**。

先把这三个实验跑一下，比继续盲改 `cli.ts` 靠谱得多。Node 对 SIGINT/SIGTERM 的行为本身是确定的，而且安装 listener 后默认终止行为会被移除。([Node.js][1])

[1]: https://nodejs.org/api/process.html?utm_source=chatgpt.com "Process | Node.js v26.8.1 Documentation"
[2]: https://nodejs.org/api/child_process.html?utm_source=chatgpt.com "Child process | Node.js v26.7.0 Documentation"

