import { readFile, open } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseTask } from "./task.js";
import { Logger } from "./logger.js";
import { spawnPi } from "./process.js";
import { PiRpcClient } from "./rpc.js";
import { ClassifiedError, classifyError, protocolError } from "./errors.js";
import { captureBaseline, checkScope } from "./workspace.js";
import { buildResult, updateRpcState } from "./result.js";
const DEFAULT_TIMEOUT = 15 * 60 * 1000;
const ABORT_GRACE_MS = 5000;
const SIGTERM_GRACE_MS = 3000;
function printFinalResult(result) {
    process.stdout.write(JSON.stringify(result) + "\n");
}
function getArg(name) {
    const index = process.argv.indexOf(name);
    if (index === -1) {
        return undefined;
    }
    return process.argv[index + 1];
}
async function loadTask() {
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
async function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null) {
        return {
            code: child.exitCode,
            signal: null
        };
    }
    return new Promise((resolvePromise, reject) => {
        let timer;
        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
            }
            child.off("exit", onExit);
            child.off("error", onError);
        };
        const onExit = (code, signal) => {
            cleanup();
            resolvePromise({
                code,
                signal
            });
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        timer = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for Pi process exit"));
        }, timeoutMs);
        child.once("exit", onExit);
        child.once("error", onError);
    });
}
async function gracefulAbort(rpc, child, logger) {
    logger.log("abort_requested");
    try {
        const response = await rpc.abort();
        logger.log("abort_response", {
            success: response.success
        });
    }
    catch (error) {
        logger.log("abort_rpc_failed", {
            error: String(error)
        });
    }
    try {
        await waitForExit(child, ABORT_GRACE_MS);
        return;
    }
    catch {
        logger.log("abort_grace_timeout");
    }
    if (!child.killed) {
        logger.log("sending_sigterm");
        child.kill("SIGTERM");
    }
    try {
        await waitForExit(child, SIGTERM_GRACE_MS);
        return;
    }
    catch {
        logger.log("sigterm_grace_timeout");
    }
    if (!child.killed) {
        logger.log("sending_sigkill");
        child.kill("SIGKILL");
    }
}
async function main() {
    let task;
    try {
        const raw = await loadTask();
        task = parseTask(raw);
    }
    catch (error) {
        const result = {
            schema_version: "1.0",
            task_id: "unknown",
            status: "failed",
            worker: {
                runtime: "pi"
            },
            execution: {
                started_at: new Date().toISOString(),
                finished_at: new Date().toISOString(),
                duration_ms: 0
            },
            result: {
                changed_files: []
            },
            scope: {
                status: "not_checked",
                allowed_paths: [],
                changed_files: [],
                violations: []
            },
            tests: {
                status: "unknown",
                commands: []
            },
            error: classifyError(error, "protocol")
        };
        printFinalResult(result);
        process.exitCode = 2;
        return;
    }
    const cwd = resolve(task.cwd ?? process.cwd());
    const effectiveTask = {
        ...task,
        cwd
    };
    const logger = new Logger(effectiveTask);
    const startedAt = new Date();
    const baseline = await captureBaseline(cwd);
    let pi;
    let rpc;
    const state = {
        settled: false,
        agentStarted: false,
        agentEnded: false,
        changedFiles: []
    };
    let workerError = null;
    let signalReceived;
    let timeoutTriggered = false;
    let signalHandlerRunning = false;
    try {
        logger.log("task_started", {
            objective: task.objective,
            cwd,
            timeout_ms: task.timeout_ms ??
                DEFAULT_TIMEOUT
        });
        pi = spawnPi(effectiveTask);
        logger.log("process_spawned", {
            pid: pi.pid
        });
        rpc =
            new PiRpcClient(pi.child);
        rpc.on((event) => {
            logger.log(event.type ?? "unknown_event", {
                rpc_type: event.type
            });
            updateRpcState(state, event);
            if (event.type ===
                "extension_error") {
                logger.log("extension_error", {
                    details: event
                });
            }
            if (event.type ===
                "auto_retry_start") {
                logger.log("auto_retry_start");
            }
            if (event.type ===
                "compaction_start") {
                logger.log("compaction_start");
            }
        });
        pi.child.on("error", error => {
            if (!workerError) {
                workerError =
                    classifyError(error);
            }
        });
        /*
         * Forward signals into RPC abort.
         */
        const onSignal = (signal) => {
            if (signalHandlerRunning) {
                return;
            }
            signalHandlerRunning = true;
            signalReceived = signal;
            logger.log("signal_received", {
                signal
            });
            void gracefulAbort(rpc, pi.child, logger).finally(() => {
                signalHandlerRunning = false;
            });
        };
        process.on("SIGINT", () => onSignal("SIGINT"));
        process.on("SIGTERM", () => onSignal("SIGTERM"));
        const promptResponse = await rpc.prompt(effectiveTask.prompt);
        if (!promptResponse.success) {
            throw protocolError("PROMPT_REJECTED", promptResponse.error ??
                "Pi rejected prompt");
        }
        logger.log("prompt_accepted");
        const timeoutMs = task.timeout_ms ??
            DEFAULT_TIMEOUT;
        const timeoutPromise = sleep(timeoutMs).then(() => "timeout");
        const settledPromise = new Promise(resolvePromise => {
            const unsubscribe = rpc.on(event => {
                if (event.type ===
                    "agent_settled") {
                    unsubscribe();
                    resolvePromise("settled");
                }
            });
        });
        const outcome = await Promise.race([
            timeoutPromise,
            settledPromise
        ]);
        if (outcome === "timeout") {
            timeoutTriggered = true;
            workerError = {
                category: "runtime",
                code: "TASK_TIMEOUT",
                message: `Task exceeded ${timeoutMs}ms`
            };
            logger.log("task_timeout", {
                timeout_ms: timeoutMs
            });
            await gracefulAbort(rpc, pi.child, logger);
        }
        /*
         * If signal was received, make sure
         * process is terminated.
         */
        if (signalReceived) {
            workerError = {
                category: "runtime",
                code: "TASK_CANCELLED",
                message: `Task cancelled by ${signalReceived}`
            };
            await gracefulAbort(rpc, pi.child, logger);
        }
        /*
         * Wait for process exit.
         */
        let exitCode = null;
        let exitSignal = null;
        if (pi.child.exitCode === null) {
            try {
                const exit = await waitForExit(pi.child, 10_000);
                exitCode = exit.code;
                exitSignal = exit.signal;
            }
            catch (error) {
                if (!workerError) {
                    workerError =
                        classifyError(error);
                }
            }
        }
        else {
            exitCode =
                pi.child.exitCode;
        }
        /*
         * If Pi exits abnormally and we don't
         * already have a more meaningful error.
         */
        if (!workerError &&
            exitCode !== null &&
            exitCode !== 0) {
            workerError = {
                category: "runtime",
                code: "PI_PROCESS_EXIT_NONZERO",
                message: `Pi exited with code ${exitCode}`,
                details: {
                    signal: exitSignal
                }
            };
        }
        /*
         * agent_settled is mandatory for a normal run.
         */
        if (!workerError &&
            !state.settled) {
            workerError = {
                category: "protocol",
                code: "AGENT_SETTLED_MISSING",
                message: "Pi process ended without agent_settled"
            };
        }
        /*
         * Final assistant message is mandatory.
         */
        if (!workerError &&
            !state.finalMessage?.trim()) {
            workerError = {
                category: "protocol",
                code: "FINAL_MESSAGE_MISSING",
                message: "No final assistant message was received"
            };
        }
        const scope = await checkScope(cwd, baseline, task.allowed_paths ?? []);
        state.changedFiles =
            scope.changed_files;
        if (!workerError &&
            scope.status === "failed") {
            workerError = {
                category: "runtime",
                code: "MODIFICATION_SCOPE_VIOLATION",
                message: "Worker modified files outside allowed_paths",
                details: scope.violations
            };
        }
        const finishedAt = new Date();
        const execution = {
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() -
                startedAt.getTime(),
            pid: pi.pid,
            exit_code: exitCode,
            signal: exitSignal
        };
        const worker = {
            runtime: "pi",
            provider: task.model?.provider,
            model: task.model?.model
        };
        const tests = {
            status: "unknown",
            commands: []
        };
        const result = buildResult(task, worker, execution, state, scope, tests, workerError);
        /*
         * Strict final output.
         */
        printFinalResult(result);
        process.exitCode =
            result.status === "success"
                ? 0
                : timeoutTriggered
                    ? 124
                    : signalReceived
                        ? 130
                        : 1;
    }
    catch (error) {
        const finishedAt = new Date();
        const classified = error instanceof ClassifiedError
            ? {
                category: error.category,
                code: error.code,
                message: error.message,
                details: error.details
            }
            : classifyError(error);
        const scope = await checkScope(cwd, baseline, task.allowed_paths ?? []).catch(() => ({
            status: "not_checked",
            allowed_paths: task.allowed_paths ?? [],
            changed_files: [],
            violations: []
        }));
        const execution = {
            started_at: finishedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: finishedAt.getTime() -
                startedAt.getTime(),
            pid: pi?.pid,
            exit_code: pi?.child.exitCode ?? null,
            signal: null
        };
        const result = buildResult(task, {
            runtime: "pi",
            provider: task.model?.provider,
            model: task.model?.model
        }, execution, state, scope, {
            status: "unknown",
            commands: []
        }, classified);
        printFinalResult(result);
        process.exitCode = 1;
        if (pi?.child) {
            await gracefulAbort(rpc, pi.child, logger).catch(() => { });
        }
    }
}
main().catch(error => {
    const result = {
        schema_version: "1.0",
        task_id: "unknown",
        status: "failed",
        worker: {
            runtime: "pi"
        },
        execution: {
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: 0
        },
        result: {
            changed_files: []
        },
        scope: {
            status: "not_checked",
            allowed_paths: [],
            changed_files: [],
            violations: []
        },
        tests: {
            status: "unknown",
            commands: []
        },
        error: classifyError(error, "runtime")
    };
    printFinalResult(result);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map