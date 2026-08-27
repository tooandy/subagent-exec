import {
  readFile,
  open
} from "node:fs/promises";

import {
  resolve
} from "node:path";

import {
  setTimeout as sleep
} from "node:timers/promises";

import type {
  ChildProcessWithoutNullStreams
} from "node:child_process";

import {
  parseTask
} from "./task.js";

import {
  Logger
} from "./logger.js";

import {
  spawnPi,
  type PiProcess
} from "./process.js";

import {
  PiRpcClient,
  type RpcEvent
} from "./rpc.js";

import {
  ClassifiedError,
  classifyError,
  createError,
  protocolError
} from "./errors.js";

import {
  captureBaseline,
  checkScope,
  type WorkspaceBaseline
} from "./workspace.js";

import {
  runVerification
} from "./verify.js";

import {
  parseUsage
} from "./usage.js";

import {
  buildResult,
  updateRpcState,
  type RpcState
} from "./result.js";

import type {
  ExecutionInfo,
  ScopeInfo,
  Task,
  VerificationResult,
  WorkerError,
  WorkerInfo
} from "./types.js";

const DEFAULT_TIMEOUT =
  15 * 60 * 1000;

const DEFAULT_VERIFY_TIMEOUT =
  2 * 60 * 1000;

const SHUTDOWN_GRACE_MS = 3000;

const SIGTERM_GRACE_MS = 2000;

const STATS_TIMEOUT_MS = 5000;

/*
 * Custom error types for distinguishing timeout vs cancellation.
 */
class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super("TIMEOUT");
    this.name = "TimeoutError";
  }
}

class CancelledError extends Error {
  constructor(public readonly signal: NodeJS.Signals) {
    super(`CANCELLED:${signal}`);
    this.name = "CancelledError";
  }
}

function printResult(result: unknown): void {
  process.stdout.write(
    JSON.stringify(result) + "\n"
  );
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function loadTaskInput(): Promise<unknown> {
  const taskFile = getArg("--task");

  if (taskFile) {
    const text = await readFile(resolve(taskFile), "utf8");
    return JSON.parse(text);
  }

  const stdinHandle = await open("/dev/stdin", "r");
  const stdin = await stdinHandle.readFile("utf8");
  await stdinHandle.close();

  return JSON.parse(stdin);
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }

  return new Promise((resolvePromise) => {
    const timer = setTimeout(
      () => resolvePromise(false),
      timeoutMs
    );

    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}


async function shutdownPi(
  pi: PiProcess,
  rpc: PiRpcClient,
  logger: Logger
): Promise<void> {
  /*
   * RPC abort to stop current operation.
   */
  try {
    logger.log("shutdown_abort_requested");
    await rpc.abort();
    logger.log("shutdown_abort_sent");
  } catch (error) {
    logger.log("shutdown_abort_failed", {
      error: String(error)
    });
  }

  /*
   * Give Pi a short grace period to exit.
   */
  const exited = await waitForExit(
    pi.child,
    SHUTDOWN_GRACE_MS
  );

  if (exited) {
    logger.log("process_exited_gracefully", {
      exit_code: pi.child.exitCode
    });
    return;
  }

  /*
   * SIGTERM if still running.
   */
  logger.log("sending_sigterm");
  pi.child.kill("SIGTERM");

  const exitedAfterTerm = await waitForExit(
    pi.child,
    SIGTERM_GRACE_MS
  );

  if (exitedAfterTerm) {
    logger.log("process_exited_sigterm", {
      exit_code: pi.child.exitCode
    });
    return;
  }

  /*
   * SIGKILL if still running.
   */
  logger.log("sending_sigkill");
  pi.child.kill("SIGKILL");

  await waitForExit(pi.child, 1000);

  logger.log("process_exited_sigkill");
}

function createDefaultVerification(): VerificationResult {
  return {
    status: "not_run",
    commands: [],
    results: []
  };
}

function createFailedResult(
  taskId: string,
  error: WorkerError,
  startedAt: Date,
  exitCode: number | null = null
) {
  return {
    schema_version: "1.0",
    task_id: taskId,
    status: "failed",
    worker: { runtime: "pi" },
    execution: {
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms:
        Date.now() - startedAt.getTime(),
      exit_code: exitCode
    },
    result: { changed_files: [] },
    scope: {
      status: "not_checked",
      allowed_paths: [],
      changed_files: [],
      added_files: [],
      modified_files: [],
      deleted_files: [],
      violations: []
    },
    verification: createDefaultVerification(),
    error
  };
}

/*
 * =============================================================================
 * RuntimeController — single source of truth for cancellation and signals.
 *
 * Installed at module load (before main() is even called) so that signals
 * received during early initialization are not lost.
 *
 * Architecture:
 *   Signal -> handleSignal() -> cancellationController.abort(reason)
 *                                ↓
 *                          worker wait Promise.race
 *                                ↓
 *                          shutdownPi()
 *                                ↓
 *                          RPC abort -> SIGTERM -> SIGKILL
 *
 * Single state — no parallel signalReceived / cancelReject / controller.
 * =============================================================================
 */
interface RuntimeState {
  signalReceived?: NodeJS.Signals;
  logger?: Logger;
  cancelReject?: (error: Error) => void;
}

const runtime: RuntimeState = {};

const cancellationController = new AbortController();

function abortCancellation(signal: NodeJS.Signals) {
  if (cancellationController.signal.aborted) {
    return;
  }
  /*
   * Use signal as abort reason so downstream code
   * can distinguish cancellation from timeout.
   */
  cancellationController.abort(
    new CancelledError(signal)
  );
}

function handleSignal(signal: NodeJS.Signals) {
  /*
   * Second signal of the same kind: force exit immediately.
   */
  if (runtime.signalReceived) {
    runtime.logger?.log(
      "signal_force_exit",
      { signal }
    );
    process.exit(130);
  }

  runtime.signalReceived = signal;

  runtime.logger?.log("signal_received", { signal });

  /*
   * Reject the local cancellationPromise (registered by main())
   * so the three-way race wakes up immediately. The global
   * cancellationController is for downstream callers.
   */
  runtime.cancelReject?.(
    new CancelledError(signal)
  );

  abortCancellation(signal);
}

/*
 * Install signal handlers IMMEDIATELY at module load.
 * Per review-2: handlers must be registered before any async init
 * so signals arriving during early startup are not lost.
 */
process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

async function main(): Promise<void> {
  /*
   * 1. Parse task.
   */
  let rawTask: unknown;

  try {
    rawTask = await loadTaskInput();
  } catch (error) {
    printResult(
      createFailedResult(
        "unknown",
        classifyError(error, "protocol"),
        new Date()
      )
    );
    process.exitCode = 2;
    return;
  }

  const cliTaskId = getArg("--task-id");
  let task: Task;

  try {
    task = parseTask(rawTask);

    if (cliTaskId && cliTaskId !== task.task_id) {
      printResult(
        createFailedResult(
          cliTaskId,
          createError(
            "protocol",
            "TASK_ID_MISMATCH",
            `Task ID mismatch: CLI "${cliTaskId}" vs task.json "${task.task_id}"`,
            { retryable: false }
          ),
          new Date()
        )
      );
      process.exitCode = 2;
      return;
    }
  } catch (error) {
    printResult(
      createFailedResult(
        "unknown",
        classifyError(error, "protocol"),
        new Date()
      )
    );
    process.exitCode = 2;
    return;
  }

  const cwd = resolve(task.cwd ?? process.cwd());
  const startedAt = new Date();
  const logger = new Logger(task.task_id);

  /*
   * Register logger in runtime state so signal handler
   * can log even before main() finishes its first await.
   */
  runtime.logger = logger;

  /*
   * 2. Capture baseline.
   */
  let baseline: WorkspaceBaseline;

  try {
    baseline = await captureBaseline(cwd);
  } catch (error) {
    printResult(
      createFailedResult(
        task.task_id,
        classifyError(error, "runtime"),
        startedAt
      )
    );
    process.exitCode = 1;
    return;
  }

  /*
   * 3. Spawn Pi.
   */
  let pi: PiProcess;
  let rpc: PiRpcClient;

  try {
    pi = spawnPi({ ...task, cwd });
    rpc = new PiRpcClient(pi.child);
    logger.log("process_spawned", { pid: pi.pid });
  } catch (error) {
    printResult(
      createFailedResult(
        task.task_id,
        classifyError(error, "runtime"),
        startedAt
      )
    );
    process.exitCode = 1;
    return;
  }

  const state: RpcState = {
    settled: false,
    agentStarted: false,
    agentEnded: false,
    usage: undefined
  };

  let workerError: WorkerError | null = null;
  let timeoutTriggered = false;

  /*
   * 4. Listen to RPC events.
   */
  rpc.on((event: RpcEvent) => {
    logger.log(
      (event.type ?? "unknown_event") as any,
      { rpc_type: event.type }
    );

    updateRpcState(state, event);
  });

  pi.child.on("error", (error) => {
    if (!workerError) {
      workerError = classifyError(error);
    }
  });

  /*
   * 5. Build the three-way race promise set BEFORE sending prompt.
   *
   *    Per review-3: a fast Pi may emit agent_settled between
   *    prompt RPC response and the moment we register a listener.
   *    So we register the settled listener BEFORE awaiting prompt().
   *
   *    Three competitors:
   *    - settledPromise:    resolves on agent_settled RPC event
   *    - timeoutPromise:    rejects after timeoutMs
   *    - cancellationPromise: rejects when SIGINT/SIGTERM fires
   */
  const timeoutMs = task.timeout_ms ?? DEFAULT_TIMEOUT;

  let removeSettledListener: (() => void) | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  function cleanupRace() {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    if (removeSettledListener) {
      removeSettledListener();
      removeSettledListener = undefined;
    }
    runtime.cancelReject = undefined;
  }

  const settledPromise = new Promise<void>((resolve) => {
    removeSettledListener = rpc.on((event) => {
      if (event.type === "agent_settled") {
        resolve();
      }
    });
  });

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutTimer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });

  const cancellationPromise = new Promise<never>(
    (_resolve, reject) => {
      runtime.cancelReject = reject;
    }
  );

  /*
   * 6. Send prompt.
   */
  try {
    logger.log("prompt_sent");

    const response = await rpc.prompt(task.prompt);

    if (!response.success) {
      throw protocolError(
        "PROMPT_REJECTED",
        response.error ?? "Pi rejected prompt"
      );
    }

    logger.log("prompt_accepted");
  } catch (error) {
    workerError =
      error instanceof ClassifiedError
        ? createError(
            error.category,
            error.code,
            error.message,
            { retryable: error.retryable }
          )
        : classifyError(error);

    await shutdownPi(pi, rpc, logger);

    printResult(
      buildResult(
        task,
        { runtime: "pi" },
        {
          started_at: startedAt.toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt.getTime(),
          pid: pi.pid,
          exit_code: pi.child.exitCode,
          signal: null
        },
        state,
        {
          status: "not_checked",
          allowed_paths: [],
          changed_files: [],
          added_files: [],
          modified_files: [],
          deleted_files: [],
          violations: []
        },
        createDefaultVerification(),
        workerError
      )
    );

    process.exitCode = 1;
    return;
  }

  /*
   * 7. Wait for agent_settled, timeout, or cancellation.
   *
   *    The three promises were set up in step 5 (BEFORE prompt send)
   *    so a fast agent_settled will not race past us.
   */
  try {
    await Promise.race([
      settledPromise,
      timeoutPromise,
      cancellationPromise
    ]);
  } catch (error) {
    cleanupRace();

    if (error instanceof TimeoutError) {
      timeoutTriggered = true;

      workerError = createError(
        "runtime",
        "TASK_TIMEOUT",
        `Task exceeded ${timeoutMs}ms`,
        { retryable: true }
      );

      logger.log("task_timeout", { timeout_ms: timeoutMs });
    } else if (error instanceof CancelledError) {
      workerError = createError(
        "runtime",
        "TASK_CANCELLED",
        `Task cancelled by ${error.signal}`,
        { retryable: false }
      );

      logger.log("task_cancelled", {
        signal: error.signal
      });
    } else if (!workerError) {
      workerError = classifyError(error);
    }

    await shutdownPi(pi, rpc, logger);

    printResult(
      buildResult(
        task,
        { runtime: "pi" },
        {
          started_at: startedAt.toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt.getTime(),
          pid: pi.pid,
          exit_code: pi.child.exitCode,
          signal: runtime.signalReceived ?? null
        },
        state,
        {
          status: "not_checked",
          allowed_paths: [],
          changed_files: [],
          added_files: [],
          modified_files: [],
          deleted_files: [],
          violations: []
        },
        createDefaultVerification(),
        workerError
      )
    );

    process.exitCode = timeoutTriggered ? 124 : 130;
    return;
  } finally {
    /*
     * Per review-3: explicit cleanup of all race resources.
     * clearTimeout(timeoutTimer) removes the pending timer.
     * removeSettledListener() unregisters the RPC listener.
     * cancelReject = undefined releases the closure ref.
     */
    cleanupRace();
  }

  /*
   * 7. Get session stats with proper timer cleanup.
   */
  logger.log("session_stats_requested");

  const statsAbort = new AbortController();

  try {
    const statsPromise = rpc.getSessionStats();
    const timeoutPromise = sleep(
      STATS_TIMEOUT_MS,
      undefined,
      { signal: statsAbort.signal }
    ).then(() => null);

    const statsResponse =
      await Promise.race([
        statsPromise,
        timeoutPromise
      ]);

    statsAbort.abort();

    if (!statsResponse) {
      logger.log("session_stats_timeout");
    } else {
      logger.log("session_stats_response", {
        raw: JSON.stringify(statsResponse)
      });

      const usage = parseUsage(statsResponse);

      if (usage) {
        state.usage = usage;
        logger.log("session_stats_received", { usage });
      } else {
        logger.log("session_stats_parse_failed", {
          raw: JSON.stringify(statsResponse)
        });
      }
    }
  } catch (error) {
    statsAbort.abort();
    logger.log("session_stats_failed", {
      error: String(error)
    });
  }

  /*
   * 8. Shutdown Pi.
   */
  await shutdownPi(pi, rpc, logger);

  const exitCode = pi.child.exitCode;

  logger.log("process_exit", {
    exit_code: exitCode
  });

  /*
   * 9. Check for unexpected non-zero exit.
   *
   * Note: When we successfully complete agent_settled
   * and then call shutdownPi(), Pi is killed via SIGTERM
   * which gives exit code 143 (128+15). This is expected
   * and should NOT be treated as an error.
   *
   * Only treat as error if exit code is non-zero AND
   * the agent never reported agent_settled.
   */
  if (
    !workerError &&
    exitCode !== null &&
    exitCode !== 0 &&
    !state.settled
  ) {
    workerError = createError(
      "runtime",
      "PI_PROCESS_EXIT_NONZERO",
      `Pi exited with code ${exitCode} before agent_settled`,
      { retryable: true }
    );
  }

  /*
   * 10. Validate agent completed.
   */
  if (!workerError && !state.settled) {
    workerError = createError(
      "protocol",
      "AGENT_SETTLED_MISSING",
      "Pi process ended without agent_settled",
      { retryable: true }
    );
  }

  if (
    !workerError &&
    !state.assistantMessage?.trim()
  ) {
    workerError = createError(
      "protocol",
      "FINAL_MESSAGE_MISSING",
      "No final assistant message was received",
      { retryable: true }
    );
  }

  /*
   * 11. Scope check.
   */
  logger.log("scope_check_start");

  let scope: ScopeInfo;

  try {
    scope = await checkScope(
      cwd,
      baseline,
      task.allowed_paths ?? []
    );
  } catch (error) {
    scope = {
      status: "not_checked",
      allowed_paths: task.allowed_paths ?? [],
      changed_files: [],
      added_files: [],
      modified_files: [],
      deleted_files: [],
      violations: []
    };

    logger.log("scope_check_error", {
      error: String(error)
    });
  }

  logger.log("scope_check_end", {
    status: scope.status,
    changed_files: scope.changed_files
  });

  if (
    !workerError &&
    scope.status === "failed"
  ) {
    workerError = createError(
      "scope",
      "MODIFICATION_SCOPE_VIOLATION",
      "Worker modified files outside allowed_paths",
      { retryable: false, details: scope.violations }
    );
  }

  /*
   * 12. Verification.
   */
  logger.log("verification_start");

  let verification = createDefaultVerification();

  if (
    !workerError &&
    task.verification?.commands?.length
  ) {
    const verifyTimeout =
      task.verification.timeout_ms ??
      DEFAULT_VERIFY_TIMEOUT;

    try {
      verification = await runVerification(
        cwd,
        task.verification.commands,
        verifyTimeout
      );
    } catch (error) {
      verification = {
        status: "failed",
        commands: task.verification.commands,
        results: [
          {
            command: task.verification.commands[0],
            exit_code: null,
            duration_ms: 0,
            stderr: String(error)
          }
        ]
      };
    }

    if (verification.status === "failed") {
      workerError = createError(
        "verification",
        "VERIFICATION_FAILED",
        "Verification commands failed",
        { retryable: false, details: verification.results }
      );
    }
  }

  logger.log("verification_end", {
    status: verification.status
  });

  /*
   * 13. Build and print result.
   */
  const execution: ExecutionInfo = {
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    pid: pi.pid,
    exit_code: exitCode,
    signal: null
  };

  const worker: WorkerInfo = {
    runtime: "pi",
    provider: task.model?.provider,
    model: task.model?.model
  };

  const result = buildResult(
    task,
    worker,
    execution,
    state,
    scope,
    verification,
    workerError
  );

  printResult(result);

  logger.log("task_finished", {
    status: result.status
  });

  process.exitCode =
    result.status === "success"
      ? 0
      : timeoutTriggered
        ? 124
        : runtime.signalReceived
          ? 130
          : 1;

  /*
   * Bug fix #1: explicit exit so Node does not
   * wait for any lingering timers.
   */
  process.exit(process.exitCode);
}

main().catch((error) => {
  printResult(
    createFailedResult(
      "unknown",
      classifyError(error, "runtime"),
      new Date()
    )
  );

  process.exit(1);
});
