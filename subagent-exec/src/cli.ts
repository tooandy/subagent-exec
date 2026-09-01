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
  parseTask,
  parseContinueTask,
  buildWorkerPrompt,
  buildContinuePrompt
} from "./task.js";

import {
  archiveSession,
  acquireSessionLease,
  loadArchivedSession,
  loadSession,
  saveSession,
  deleteSession,
  newSessionMetadata,
  withIteration,
  resolvePiSessionDir
} from "./session.js";

import type { SessionMetadata } from "./session.js";

import {
  Logger
} from "./logger.js";

import {
  spawnPi,
  supportsWriteContainment,
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
  measureDiff,
  WorkspaceError,
  type WorkspaceBaseline
} from "./workspace.js";

import {
  evaluateAdmission,
  isCheckpointPlanningRound
} from "./admission.js";

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
import { canContinueSession, diagnosticFingerprint, evaluateResultCircuit, failureClass } from "./circuit.js";
import { acceptCandidate, candidateBaseHead, createCandidateWorktree, discardCandidate, exportCandidatePatch, rejectCandidate } from "./candidate.js";
import { assessOutcome, fingerprintFiles, outcomeCandidateManifest, recordCoordinatorDecision, recordIteration, recordPersistenceFailure, validateOutcomeTaskId } from "./outcome.js";
import { DEFAULT_QUOTA_FALLBACK_MODEL, DEFAULT_WORKER_MODEL, isQuotaMessage } from "./model-policy.js";
import { runDoctor } from "./doctor.js";

import type {
  ExecutionInfo,
  ScopeInfo,
  Task,
  VerificationResult,
  WorkerError,
  WorkerInfo,
  WorkerResult
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

class ChildExitedError extends Error {
  constructor(
    public readonly exitCode: number | null,
    public readonly signal: string | null
  ) {
    super(
      `Pi process exited unexpectedly: code=${exitCode}, signal=${signal}`
    );
    this.name = "ChildExitedError";
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

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

async function loadTaskInput(): Promise<unknown> {
  /*
   * --help: print usage and exit successfully without reading stdin.
   * Must check before loading stdin to avoid treating --help as a
   * task.json path.
   */
  if (hasArg("--help") || hasArg("-h")) {
    printUsage();
    process.exitCode = 0;
    return undefined; // signals early exit
  }

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

async function loadContinueInput(): Promise<unknown> {
  /*
   * --feedback <path>: load Continue Task Contract from file.
   * Otherwise read from stdin.
   */
  const feedbackFile = getArg("--feedback");

  if (feedbackFile) {
    const text = await readFile(
      resolve(feedbackFile),
      "utf8"
    );
    return JSON.parse(text);
  }

  const stdinHandle = await open("/dev/stdin", "r");
  const stdin = await stdinHandle.readFile("utf8");
  await stdinHandle.close();

  return JSON.parse(stdin);
}

function printUsage(): void {
  const msg = `
subagent-exec — bounded Pi RPC worker runtime

USAGE
  subagent-exec [options]

OPTIONS
  --task <path>      Load Task Contract from a JSON file.
                     If omitted, reads from stdin.
  --continue <id>    Continue the exact persisted session for task id.
  --accept-candidate <id>
                     Apply a reviewed candidate patch to the main workspace.
  --reject-candidate <id>
                     Reject a candidate patch without changing the workspace.
  --assess-outcome <id>
                     Compare accepted files with their acceptance fingerprints.
  --doctor           Preflight Pi models, containment, and Git worktree permission.
  --feedback <path>  Load Continue Task feedback JSON from a file.
  --task-id <id>     Override task_id validation.
  --help, -h         Print this usage message and exit.

INPUT
  Reads a Task Contract (JSON) from --task <path> or stdin.
  Writes exactly one Result Contract (JSON) to stdout.
  Writes JSONL lifecycle events to stderr.

EXIT CODES
  0   success
  1   failed
  2   protocol / schema error
  124 timeout
  130 cancelled (SIGINT/SIGTERM)
`.trim();

  process.stdout.write(msg + "\n");
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
   * Has its own deadline; we do not wait forever.
   */
  try {
    logger.log("shutdown_abort_requested");
    await rpc.abort(10_000);
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

  /*
   * Final cleanup: clear any pending RPC requests and timers.
   */
  rpc.cleanup();
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
  exitCode: number | null = null,
  acceptanceCriteria: string[] = []
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
      scope_mode: "read_write",
      changed_files: [],
      added_files: [],
      modified_files: [],
      deleted_files: [],
      violations: []
    },
    verification: createDefaultVerification(),
    acceptance_evidence: {
      assumptions: [], decisions: [],
      criteria: acceptanceCriteria.map((criterion) => ({ criterion, status: "manual_review_required" as const, evidence: [] })),
      changed_symbols: [], tests_added: [], known_risks: [], unresolved_items: [], review_locations: [],
      recommended_next_action: error.retryable
        ? "Return to the coordinator to decide whether to retry with revised instructions."
        : "Return to the coordinator for manual review and takeover."
    },
    continuation: {
      allow_continuation: false,
      state: "coordinator_required" as const,
      reason: "coordinator_required"
    },
    error
  };
}

async function persistIterationResult(
  session: SessionMetadata,
  result: WorkerResult
): Promise<void> {
  const failure = result.error ? {
    failure_class: failureClass(result.error),
    diagnostic_fingerprint: diagnosticFingerprint(result)
  } : undefined;
  await saveSession(withIteration(session, {
    worker_session_id: session.worker_session_id,
    worker_session_dir: session.worker_session_dir,
    last_result: {
      status: result.status,
      summary: result.result.summary,
      changed_files: result.result.changed_files
    },
    failure_history: failure ? [...session.failure_history, failure] : session.failure_history,
    circuit: result.continuation,
    increment_iteration: true
  }));
  await recordIteration(session.cwd, {
    schema_version: "1.0", task_id: session.task_id, prompt: session.original_task.prompt,
    task_class: session.original_task.task_class
  }, result);
}

async function persistAndArchiveIfTerminal(session: SessionMetadata, result: WorkerResult): Promise<void> {
  await persistIterationResult(session, result);
  if (!result.continuation.allow_continuation) await archiveSession(session.cwd, session.task_id);
}

async function prepareCandidateResult(session: SessionMetadata, result: WorkerResult): Promise<void> {
  const worktree = session.candidate_worktree;
  if (!worktree) return;
  if (result.status === "success" && result.scope.changed_files.length > 0 &&
      result.acceptance_evidence.criteria.some((item) => item.status !== "passed")) {
    result.status = "failed";
    result.error = createError("verification", "ACCEPTANCE_EVIDENCE_INCOMPLETE",
      "Candidate changes lack reproducible passed evidence for every acceptance criterion", { retryable: false });
    result.acceptance_evidence.recommended_next_action ??= "Return to the coordinator for evidence review.";
    result.continuation = evaluateResultCircuit(result, session.failure_history);
    const limit = session.original_task.iteration?.max_iterations ?? 1;
    if (result.continuation.allow_continuation && result.iteration >= limit) {
      result.continuation = { allow_continuation: false, state: "coordinator_required", reason: "iteration_limit", failure_class: result.continuation.failure_class };
    }
  }
  if (result.status === "success") {
    try {
      const patchPath = await exportCandidatePatch(session.cwd, worktree, session.task_id);
      result.candidate = { status: "ready", patch_path: patchPath,
        fingerprints: await fingerprintFiles(worktree, result.scope.changed_files),
        base_head: await candidateBaseHead(worktree) };
      await discardCandidate(session.cwd, worktree);
      session.candidate_worktree = undefined;
    } catch (error) {
      result.status = "failed";
      result.error = createError("runtime", "CANDIDATE_EXPORT_FAILED", String(error), { retryable: false });
      result.continuation = { allow_continuation: false, state: "coordinator_required", reason: "coordinator_required", failure_class: "runtime:CANDIDATE_EXPORT_FAILED" };
      result.candidate = { status: "discarded" };
      try { await discardCandidate(session.cwd, worktree); session.candidate_worktree = undefined; } catch { /* surfaced by export failure */ }
    }
  } else if (!result.continuation.allow_continuation) {
    await discardCandidate(session.cwd, worktree);
    session.candidate_worktree = undefined;
    result.candidate = { status: "discarded" };
  } else {
    result.candidate = { status: "pending" };
  }
}

function applySessionPersistenceFailure(
  result: WorkerResult,
  error: unknown
): void {
  result.status = "failed";
  result.error = createError(
    "runtime",
    "SESSION_PERSISTENCE_FAILED",
    `Failed to persist continuation state: ${String(error)}`,
    { retryable: false }
  );
  result.continuation = {
    allow_continuation: false,
    state: "coordinator_required",
    reason: "coordinator_required",
    failure_class: "runtime:SESSION_PERSISTENCE_FAILED"
  };
  result.acceptance_evidence.recommended_next_action ??=
    "Return to the coordinator for manual review and takeover.";
}

/*
 * =============================================================================
 * RuntimeController — single source of truth for cancellation and signals.
 *
 * Architecture:
 *   Signal -> handleSignal() -> cancellationController.abort(reason)
 *                                ↓
 *                          worker wait Promise.race
 *                                ↓
 *                          shutdownPi()
 *                                ↓
 *                          RPC abort -> SIGTERM -> SIGKILL
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
  cancellationController.abort(
    new CancelledError(signal)
  );
}

function handleSignal(signal: NodeJS.Signals) {
  if (runtime.signalReceived) {
    runtime.logger?.log(
      "signal_force_exit",
      { signal }
    );
    process.exit(130);
  }

  runtime.signalReceived = signal;

  runtime.logger?.log("signal_received", { signal });

  runtime.cancelReject?.(
    new CancelledError(signal)
  );

  abortCancellation(signal);
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

/**
 * Classify a pi_stderr line into an error category.
 *
 * We inspect the line for known provider error signatures so that
 * FINAL_MESSAGE_MISSING is not used to mask a known auth/quota/token
 * failure that was emitted on stderr.
 */
function classifyStderrLine(line: string): WorkerError | null {
  const lower = line.toLowerCase();

  if (lower.includes("operation not permitted") || lower.includes("permission denied") || lower.includes("eacces")) {
    return createError(
      "scope",
      "WRITE_CONTAINMENT_VIOLATION",
      `Worker write was blocked by containment: ${line.slice(0, 200)}`,
      { retryable: false }
    );
  }

  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication failed") ||
    lower.includes("credential") ||
    lower.includes("auth error") ||
    lower.includes("api key")
  ) {
    return createError(
      "auth",
      "AUTH_ERROR",
      `Provider auth failure: ${line.slice(0, 200)}`,
      { retryable: false }
    );
  }

  if (isQuotaMessage(lower) || lower.includes("monthly limit")) {
    return createError(
      "quota",
      "PROVIDER_QUOTA_EXCEEDED",
      `Provider quota exceeded: ${line.slice(0, 200)}`,
      { retryable: true }
    );
  }

  if (
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("too many tokens") ||
    lower.includes("maximum tokens") ||
    lower.includes("max tokens") ||
    lower.includes("token limit") ||
    lower.includes("context limit")
  ) {
    return createError(
      "token",
      "TOKEN_LIMIT",
      `Token limit exceeded: ${line.slice(0, 200)}`,
      { retryable: false }
    );
  }

  if (
    lower.includes("runtime error") ||
    lower.includes("panic") ||
    lower.includes("crashed") ||
    lower.includes("segmentation fault")
  ) {
    return createError(
      "runtime",
      "PROVIDER_RUNTIME_ERROR",
      `Provider runtime error: ${line.slice(0, 200)}`,
      { retryable: true }
    );
  }

  return null;
}

async function main(): Promise<void> {
  if (hasArg("--doctor")) {
    const result = await runDoctor(process.cwd());
    printResult(result);
    process.exitCode = result.status === "passed" ? 0 : 1;
    return;
  }
  const assessTaskId = getArg("--assess-outcome");
  if (assessTaskId) {
    let release: (() => Promise<void>) | null = null;
    try {
      validateOutcomeTaskId(assessTaskId);
      release = await acquireSessionLease(process.cwd(), assessTaskId); if (!release) throw new Error("outcome is busy");
      printResult(await assessOutcome(process.cwd(), assessTaskId)); process.exitCode = 0;
    }
    catch (error) { printResult(createFailedResult(assessTaskId, createError("runtime", "OUTCOME_ASSESSMENT_FAILED", String(error), { retryable: false }), new Date())); process.exitCode = 1; }
    finally { await release?.(); }
    return;
  }
  const rejectTaskId = getArg("--reject-candidate");
  if (rejectTaskId) {
    let release: (() => Promise<void>) | null = null;
    try {
      validateOutcomeTaskId(rejectTaskId);
      release = await acquireSessionLease(process.cwd(), rejectTaskId);
      if (!release) throw new Error("candidate is busy");
      const rejectedPath = await rejectCandidate(process.cwd(), rejectTaskId);
      try {
        const outcome = await recordCoordinatorDecision(process.cwd(), rejectTaskId, "rejected");
        printResult({ schema_version: "1.0", task_id: rejectTaskId, status: "rejected", rejected_patch: rejectedPath, outcome });
      } catch (measurementError) {
        printResult({ schema_version: "1.0", task_id: rejectTaskId, status: "rejected", rejected_patch: rejectedPath, outcome_error: String(measurementError) });
      }
      process.exitCode = 0;
    } catch (error) {
      printResult(createFailedResult(rejectTaskId, createError("runtime", "CANDIDATE_REJECT_FAILED", String(error), { retryable: false }), new Date()));
      process.exitCode = 1;
    } finally {
      await release?.();
    }
    return;
  }
  const acceptTaskId = getArg("--accept-candidate");
  if (acceptTaskId) {
    let release: (() => Promise<void>) | null = null;
    try {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(acceptTaskId)) throw new Error("invalid candidate task id");
      release = await acquireSessionLease(process.cwd(), acceptTaskId);
      if (!release) throw new Error("candidate is busy");
      const candidate = await outcomeCandidateManifest(process.cwd(), acceptTaskId);
      const acceptedPath = await acceptCandidate(process.cwd(), acceptTaskId, candidate.files, candidate.base_head);
      try {
        const outcome = await recordCoordinatorDecision(process.cwd(), acceptTaskId, "accepted");
        printResult({ schema_version: "1.0", task_id: acceptTaskId, status: "accepted", accepted_patch: acceptedPath, outcome });
      } catch (measurementError) {
        printResult({ schema_version: "1.0", task_id: acceptTaskId, status: "accepted", accepted_patch: acceptedPath, outcome_error: String(measurementError) });
      }
      process.exitCode = 0;
    } catch (error) {
      printResult(createFailedResult(acceptTaskId, createError("runtime", "CANDIDATE_APPLY_FAILED", String(error), { retryable: false }), new Date()));
      process.exitCode = 1;
    } finally {
      await release?.();
    }
    return;
  }
  /*
   * Dispatch based on --continue flag.
   *
   * Start (default): load Task Contract, run first iteration, create session.
   * Continue:        load Continue Task Contract, find existing session,
   *                  resume Pi's conversation, run another iteration.
   *
   * In both cases the rest of the pipeline (worker spawn, RPC, scope,
   * verification, result building) is identical — only the prompt
   * sent to Pi differs.
   */
  const isContinue = hasArg("--continue");

  if (isContinue) {
    let rawContinue: unknown;
    try {
      rawContinue = await loadContinueInput();
    } catch (error) {
      printResult(
        createFailedResult(
          getArg("--continue") ?? "unknown",
          classifyError(error, "protocol"),
          new Date()
        )
      );
      process.exitCode = 2;
      return;
    }

    if (rawContinue === undefined) {
      return;
    }

    let continueTask;
    try {
      continueTask = parseContinueTask(rawContinue);
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

    /*
     * Find the existing session for this task_id.
     */
    /*
     * loadSession(cwd, task_id) resolves cwd to <cwd>/.subagent-exec
     * internally. Pass the *expected* cwd from which the user is
     * invoking the CLI — typically process.cwd() but the session
     * can also be located by walking up parents if needed.
     */
    let metadata = await loadSession(
      process.cwd(),
      continueTask.task_id
    );
    if (!metadata) {
      const archived = await loadArchivedSession(process.cwd(), continueTask.task_id);
      if (archived) {
        printResult(createFailedResult(continueTask.task_id, createError(
          "runtime", "CIRCUIT_BREAKER_OPEN",
          `Task "${continueTask.task_id}" is archived and requires coordinator takeover.`,
          { retryable: false, details: archived.circuit }
        ), new Date(), null, archived.original_task.acceptance_criteria));
        process.exitCode = 1;
        return;
      }
      printResult(
        createFailedResult(
          continueTask.task_id,
          {
            category: "protocol",
            code: "SESSION_NOT_FOUND",
            message: `No active session for task_id "${continueTask.task_id}". Start a new task with --task first.`,
            retryable: false,
            details: { task_id: continueTask.task_id }
          },
          new Date()
        )
      );
      process.exitCode = 2;
      return;
    }

    const preLeaseDelay = Number(process.env.SUBAGENT_EXEC_TEST_PRE_LEASE_DELAY_MS ?? 0);
    if (preLeaseDelay > 0) await sleep(preLeaseDelay);
    let releaseLease: (() => Promise<void>) | null;
    try {
      releaseLease = await acquireSessionLease(metadata.cwd, metadata.task_id);
    } catch (error) {
      printResult(createFailedResult(continueTask.task_id, createError(
        "runtime", "SESSION_LEASE_ERROR", `Cannot acquire task lease: ${String(error)}`,
        { retryable: false }
      ), new Date(), null, metadata.original_task.acceptance_criteria));
      process.exitCode = 1;
      return;
    }
    if (!releaseLease) {
      printResult(createFailedResult(continueTask.task_id, createError(
        "runtime", "SESSION_BUSY", `Task "${continueTask.task_id}" already has a continuation in progress.`,
        { retryable: true }
      ), new Date(), null, metadata.original_task.acceptance_criteria));
      process.exitCode = 1;
      return;
    }

    // The pre-lock lookup is only enough to locate the lease. All decisions
    // must use a fresh snapshot read while holding it.
    metadata = await loadSession(process.cwd(), continueTask.task_id);
    if (!metadata) {
      const archived = await loadArchivedSession(process.cwd(), continueTask.task_id);
      printResult(createFailedResult(continueTask.task_id, createError(
        "runtime", archived ? "CIRCUIT_BREAKER_OPEN" : "SESSION_NOT_FOUND",
        archived ? `Task "${continueTask.task_id}" became terminal before this continuation acquired its lease.` : `Task "${continueTask.task_id}" no longer has active metadata.`,
        { retryable: false, details: archived?.circuit }
      ), new Date(), null, archived?.original_task.acceptance_criteria));
      process.exitCode = archived ? 1 : 2;
      await releaseLease();
      return;
    }

    /*
     * Enforce max_iterations from the original task.
     */
    const limit = metadata.original_task.iteration?.max_iterations ?? 2;

    if (metadata.iteration >= limit) {
      const terminalCircuit = {
        allow_continuation: false,
        state: "coordinator_required" as const,
        reason: "iteration_limit" as const
      };
      if (metadata.candidate_worktree) {
        await discardCandidate(metadata.cwd, metadata.candidate_worktree);
        metadata = { ...metadata, candidate_worktree: undefined };
      }
      await saveSession({ ...metadata, circuit: terminalCircuit, updated_at: new Date().toISOString() });
      await archiveSession(metadata.cwd, metadata.task_id);
      printResult(
        createFailedResult(
          continueTask.task_id,
          createError(
            "runtime",
            "MAX_ITERATIONS_EXCEEDED",
            `Task "${continueTask.task_id}" has already used ${metadata.iteration} of ${limit} allowed iterations. Codex should take over.`,
            {
              retryable: false,
              details: {
                iteration: metadata.iteration,
                limit,
                task_id: continueTask.task_id
              }
            }
          ),
          new Date(),
          null,
          metadata.original_task.acceptance_criteria
        )
      );
      process.exitCode = 1;
      await releaseLease();
      return;
    }

    if (metadata.original_task.execution_policy?.mode === "checkpoint" &&
        metadata.iteration === 1 && metadata.last_result?.status !== "needs_continuation") {
      printResult(createFailedResult(continueTask.task_id, createError(
        "protocol", "CHECKPOINT_PLAN_NOT_APPROVED",
        `Task "${continueTask.task_id}" cannot continue because its planning round did not complete successfully.`,
        { retryable: false }
      ), new Date(), null, metadata.original_task.acceptance_criteria));
      process.exitCode = 1;
      await releaseLease();
      return;
    }

    const circuit = canContinueSession(metadata);
    if (metadata.iteration > 1 && !circuit.allow_continuation) {
      if (metadata.candidate_worktree) {
        await discardCandidate(metadata.cwd, metadata.candidate_worktree);
        metadata = { ...metadata, candidate_worktree: undefined };
        await saveSession(metadata);
      }
      await archiveSession(metadata.cwd, metadata.task_id);
      printResult(createFailedResult(continueTask.task_id, createError(
        "runtime", "CIRCUIT_BREAKER_OPEN",
        `Task "${continueTask.task_id}" requires coordinator takeover (${circuit.reason ?? circuit.state}).`,
        { retryable: false, details: circuit }
      ), new Date(), null, metadata.original_task.acceptance_criteria));
      process.exitCode = 1;
      await releaseLease();
      return;
    }

    /*
     * Synthesize a Task shape for runIteration() using original_task
     * parameters and the new feedback prompt.
     */
    const continuePrompt = buildContinuePrompt(
      continueTask.feedback,
      metadata.iteration + 1,
      metadata.last_result?.summary
    );

    const synthetic: Task = {
      schema_version: "1.0",
      task_id: continueTask.task_id,
      task_class: metadata.original_task.task_class,
      prompt: continuePrompt,
      objective: metadata.original_task.objective,
      cwd: metadata.cwd,
      scope: metadata.original_task.scope,
      allowed_paths: metadata.original_task.allowed_paths,
      constraints: metadata.original_task.constraints,
      acceptance_criteria: metadata.original_task.acceptance_criteria,
      verification: metadata.original_task.verification,
      iteration: metadata.original_task.iteration,
      execution_policy: metadata.original_task.execution_policy,
      model: metadata.original_task.model
        ? {
            provider: metadata.original_task.model.provider ?? DEFAULT_WORKER_MODEL.provider,
            model: metadata.original_task.model.model ?? DEFAULT_WORKER_MODEL.model,
            quota_fallback: metadata.original_task.model.quota_fallback ?? null
          }
        : { ...DEFAULT_WORKER_MODEL, quota_fallback: DEFAULT_QUOTA_FALLBACK_MODEL },
      timeout_ms:
        continueTask.timeout_ms ??
        metadata.original_task.timeout_ms,
      metadata: {
        ...(metadata.original_task.metadata ?? {}),
        continuation_iteration: metadata.iteration + 1,
        continuation_feedback: continueTask.feedback
      }
    };

    try {
      await runIteration(synthetic, metadata);
    } finally {
      await releaseLease();
    }
    return;
  }

  /*
   * Default path: start a new task.
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

  if (rawTask === undefined) {
    return; // --help handled
  }
  let initialTask: Task;
  try {
    initialTask = parseTask(rawTask);
  } catch {
    await runIteration(rawTask, undefined);
    return;
  }
  const initialCwd = resolve(initialTask.cwd ?? process.cwd());
  let releaseLease: (() => Promise<void>) | null;
  try {
    releaseLease = await acquireSessionLease(initialCwd, initialTask.task_id);
  } catch (error) {
    printResult(createFailedResult(initialTask.task_id, createError(
      "runtime", "SESSION_LEASE_ERROR", `Cannot acquire task lease: ${String(error)}`,
      { retryable: false }
    ), new Date(), null, initialTask.acceptance_criteria));
    process.exitCode = 1;
    return;
  }
  if (!releaseLease) {
    printResult(createFailedResult(initialTask.task_id, createError(
      "runtime", "SESSION_BUSY", `Task "${initialTask.task_id}" already has an execution in progress.`,
      { retryable: true }
    ), new Date(), null, initialTask.acceptance_criteria));
    process.exitCode = 1;
    return;
  }
  try {
    await runIteration(initialTask, undefined);
  } finally {
    await releaseLease();
  }
}

async function runIteration(
  rawTask: unknown,
  existingSession: SessionMetadata | undefined,
  fallbackAttempted = false
): Promise<void> {
  /*
   * 1. Parse task.
   */
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
          new Date(),
          null,
          task.acceptance_criteria
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

  const admission = evaluateAdmission(task);
  if (!admission.accepted) {
    printResult(createFailedResult(
      task.task_id,
      createError(
        "protocol",
        "DELEGATION_NOT_RECOMMENDED",
        `Task did not pass delegation admission: ${admission.reasons.join("; ")}`,
        { retryable: false, details: { mode: admission.mode, reasons: admission.reasons } }
      ),
      new Date(),
      null,
      task.acceptance_criteria
    ));
    process.exitCode = 2;
    return;
  }

  /*
   * 1b. Session setup.
   *
   * If continuing, reuse existing session metadata. The original_task
   * parameters (cwd, scope, model, etc.) come from session metadata,
   * not from the Continue Task Contract — the latter only carries
   * feedback.
   *
   * If starting fresh, create new metadata.
   */
  /*
   * Resolve cwd to absolute path BEFORE creating session metadata.
   * This keeps the task workspace stable across continuation rounds.
   */
  const cwd = existingSession
    ? existingSession.cwd
    : resolve(task.cwd ?? process.cwd());

  let session: SessionMetadata =
    existingSession ?? newSessionMetadata({ ...task, cwd });

  const iterationNumber =
    existingSession
      ? existingSession.iteration + 1
      : 1;
  const checkpointPlanning = isCheckpointPlanningRound(task, iterationNumber);
  const needsCandidateWorktree = task.scope === "read_write" && !checkpointPlanning && !existingSession?.candidate_worktree;
  if (!existingSession || needsCandidateWorktree) {
    const requestedModels = [
      { name: "primary_model", provider: task.model!.provider, model: task.model!.model },
      ...(task.model!.quota_fallback ? [{ name: "quota_fallback_model", ...task.model!.quota_fallback }] : [])
    ];
    const preflight = await runDoctor(cwd, {
      requireGitMetadata: needsCandidateWorktree,
      models: requestedModels
    });
    if (preflight.status === "failed") {
      printResult(createFailedResult(task.task_id, createError(
        "runtime", "PREFLIGHT_FAILED", "Worker preflight failed before session creation",
        { retryable: false, details: preflight.checks.filter(check => check.status === "failed") }
      ), new Date(), null, task.acceptance_criteria));
      process.exitCode = 1;
      return;
    }
  }
  // A checkpoint planning round is read-only and must not mutate `.git` just
  // to prepare a candidate. Its candidate worktree is created only after the
  // coordinator authorizes implementation on the continuation round.
  const isolatedWrite = task.scope === "read_write" && !checkpointPlanning;
  let executionCwd = cwd;
  if (isolatedWrite) {
    try {
      if (!supportsWriteContainment()) throw new Error("No supported OS write-containment backend");
      executionCwd = existingSession?.candidate_worktree ?? await createCandidateWorktree(cwd);
      session = { ...session, candidate_worktree: executionCwd };
    } catch (error) {
      printResult(createFailedResult(task.task_id, createError(
        "runtime", "CANDIDATE_WORKTREE_FAILED", String(error), { retryable: false }
      ), new Date(), null, task.acceptance_criteria));
      process.exitCode = 1;
      return;
    }
  }
  const startedAt = new Date();
  const logger = new Logger(task.task_id);

  runtime.logger = logger;

  /*
   * 2. Capture baseline.
   */
  let baseline: WorkspaceBaseline;

  try {
    baseline = await captureBaseline(executionCwd);
  } catch (error) {
    const classified =
      error instanceof WorkspaceError
        ? createError(
            "runtime",
            "WORKSPACE_ERROR",
            error.message,
            { retryable: false }
          )
        : classifyError(error, "runtime");

    const failed = createFailedResult(
        task.task_id,
        classified,
        startedAt,
        null,
        task.acceptance_criteria
      );
    if (session.candidate_worktree) {
      try { await discardCandidate(cwd, session.candidate_worktree); (failed as unknown as WorkerResult).candidate = { status: "discarded" }; }
      catch { /* primary workspace error remains authoritative */ }
    }
    printResult(failed);
    process.exitCode = 1;
    return;
  }

  /*
   * 3. Spawn Pi.
   */
  let pi: PiProcess;
  let rpc: PiRpcClient;

  try {
    pi = spawnPi(
      { ...task, cwd: executionCwd },
      {
        continueFrom: existingSession,
        sessionDir: existingSession?.worker_session_dir ?? resolvePiSessionDir(cwd),
        sessionId: session.worker_session_id,
        containmentWritablePaths: task.scope === "read_write"
          ? [executionCwd === cwd ? undefined : executionCwd, existingSession?.worker_session_dir ?? resolvePiSessionDir(cwd)].filter((path): path is string => Boolean(path))
          : undefined
      }
    );
    rpc = new PiRpcClient(pi.child);
    logger.log("process_spawned", {
      pid: pi.pid,
      continuing: !!existingSession,
      iteration: iterationNumber
    });
  } catch (error) {
    const failed = createFailedResult(
        task.task_id,
        classifyError(error, "runtime"),
        startedAt,
        null,
        task.acceptance_criteria
      );
    if (session.candidate_worktree) {
      try { await discardCandidate(cwd, session.candidate_worktree); (failed as unknown as WorkerResult).candidate = { status: "discarded" }; }
      catch { /* primary spawn error remains authoritative */ }
    }
    printResult(failed);
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
   * 4. Listen to RPC events and pi_stderr.
   */
  const removeRpcListener = rpc.on((event: RpcEvent) => {
    logger.log(
      (event.type ?? "unknown_event") as any,
      { rpc_type: event.type }
    );

    updateRpcState(state, event);

    if (event.type === "pi_stderr" && typeof event.line === "string" && !workerError) {
      workerError = classifyStderrLine(event.line);
    }

    /*
     * Classify protocol_error events.
     */
    if (event.type === "protocol_error") {
      const err = event.error;
      if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        if (typeof e.message === "string") {
          workerError = classifyError(
            new Error(e.message),
            "protocol"
          );
        }
      }
    }
  });

  pi.child.on("error", (error) => {
    if (!workerError) {
      workerError = classifyError(error);
    }
  });

  /*
   * 5. Build the four-way race promise set BEFORE sending prompt.
   *
   *    Four competitors:
   *    - settledPromise:    resolves on agent_settled RPC event
   *    - childExitPromise:  resolves when Pi process exits
   *    - timeoutPromise:    rejects after timeoutMs
   *    - cancellationPromise: rejects when SIGINT/SIGTERM fires
   *
   *    Per review-2/3: child exit must be in the race so that Pi
   *    exiting between prompt_accepted and agent_settled is detected
   *    immediately rather than waiting for the full timeout.
   */
  const timeoutMs = task.timeout_ms ?? DEFAULT_TIMEOUT;

  let removeSettledListener: (() => void) | undefined;
  let removeChildExitListener: (() => void) | undefined;
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
    if (removeChildExitListener) {
      removeChildExitListener();
      removeChildExitListener = undefined;
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

  const childExitPromise = new Promise<never>((_resolve, reject) => {
    /*
     * Bind a named handler so cleanup can detach ONLY this listener.
     * Using pi.child.removeAllListeners("exit") here would also strip
     * the exit handler that PiRpcClient.attach() registered, leaving
     * pending RPC requests waiting for their deadline instead of
     * being rejected immediately when Pi exits.
     */
    const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(new ChildExitedError(code, signal));
    };
    pi.child.once("exit", onChildExit);
    removeChildExitListener = () => {
      pi.child.off("exit", onChildExit);
    };
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
   * 6. Build the prompt sent to the worker.
   *    constraints and acceptance_criteria are appended as named sections,
   *    not concatenated into free-form text.
   */
  const workerPrompt = buildWorkerPrompt(
    task.prompt,
    checkpointPlanning
      ? [...(task.constraints ?? []), "Planning checkpoint only: do not modify files. Return a concise implementation plan for coordinator approval."]
      : task.constraints,
    task.acceptance_criteria
  );

  /*
   * 7. Send prompt.
   */
  try {
    logger.log("prompt_sent");

    const response = await Promise.race([
      rpc.prompt(workerPrompt),
      childExitPromise,
      timeoutPromise,
      cancellationPromise
    ]);

    if (!response.success) {
      const message = response.error ?? "Pi rejected prompt";
      const classified = classifyError(new Error(message), "protocol");
      if (classified.category !== "protocol") {
        throw new ClassifiedError(classified.category, classified.code, classified.message, classified.retryable, classified.details);
      }
      throw protocolError("PROMPT_REJECTED", message);
    }

    logger.log("prompt_accepted");
  } catch (error) {
    removeRpcListener();
    cleanupRace();

    const rejectionMessage = error instanceof Error ? error.message : String(error);
    const primaryModel = task.model;
    const fallback = primaryModel?.quota_fallback;
    if (!existingSession && !fallbackAttempted && primaryModel && fallback && isQuotaMessage(rejectionMessage)) {
      await shutdownPi(pi, rpc, logger);
      if (session.candidate_worktree) {
        try { await discardCandidate(cwd, session.candidate_worktree); }
        catch (cleanupError) {
          workerError = createError("runtime", "CANDIDATE_CLEANUP_FAILED",
            `Cannot safely start quota fallback: ${String(cleanupError)}`, { retryable: false });
        }
      }
      if (!workerError) {
        logger.log("provider_quota_fallback", {
          from_provider: primaryModel.provider,
          from_model: primaryModel.model,
          to_provider: fallback.provider,
          to_model: fallback.model
        });
        await runIteration({ ...task, model: { provider: fallback.provider, model: fallback.model, quota_fallback: null } }, undefined, true);
        return;
      }
    }

    if (error instanceof TimeoutError) {
      timeoutTriggered = true;
      workerError = createError(
        "runtime",
        "TASK_TIMEOUT",
        `Task exceeded ${timeoutMs}ms`,
        { retryable: true }
      );
    } else if (error instanceof CancelledError) {
      workerError = createError(
        "runtime",
        "TASK_CANCELLED",
        `Task cancelled by ${error.signal}`,
        { retryable: false }
      );
    } else {
      workerError ??=
        error instanceof ClassifiedError
          ? createError(
              error.category,
              error.code,
              error.message,
              { retryable: error.retryable }
            )
          : classifyError(error);
    }

    await shutdownPi(pi, rpc, logger);

    const result = buildResult(
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
          allowed_paths: task.allowed_paths ?? [],
          scope_mode: task.scope ?? "read_write",
          changed_files: [],
          added_files: [],
          modified_files: [],
          deleted_files: [],
          violations: []
        },
        createDefaultVerification(),
        workerError,
        iterationNumber,
        session.failure_history
      );
    try {
      await prepareCandidateResult(session, result);
      await persistAndArchiveIfTerminal(session, result);
    } catch (sessionError) {
      applySessionPersistenceFailure(result, sessionError);
      try { await recordPersistenceFailure(session.cwd, task, result); } catch { /* primary persistence error remains authoritative */ }
    }
    printResult(result);

    process.exitCode = timeoutTriggered
      ? 124
      : error instanceof CancelledError
        ? 130
        : 1;
    return;
  }

  /*
   * 8. Wait for agent_settled, child exit, timeout, or cancellation.
   *
   *    All four promises were registered before awaiting prompt(),
   *    so a fast agent_settled cannot race past us.
   */
  try {
    await Promise.race([
      settledPromise,
      childExitPromise,
      timeoutPromise,
      cancellationPromise
    ]);
  } catch (error) {
    removeRpcListener();
    cleanupRace();

    if (error instanceof ChildExitedError) {
      workerError = createError(
        "runtime",
        "PI_PROCESS_EXIT_NONZERO",
        error.message,
        { retryable: true }
      );

      logger.log("child_exit_during_work", {
        exit_code: error.exitCode,
        signal: error.signal
      });
    } else if (error instanceof TimeoutError) {
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

    const result = buildResult(
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
          allowed_paths: task.allowed_paths ?? [],
          scope_mode: task.scope ?? "read_write",
          changed_files: [],
          added_files: [],
          modified_files: [],
          deleted_files: [],
          violations: []
        },
        createDefaultVerification(),
        workerError,
        iterationNumber,
        session.failure_history
      );
    try {
      await prepareCandidateResult(session, result);
      await persistAndArchiveIfTerminal(session, result);
    } catch (sessionError) {
      applySessionPersistenceFailure(result, sessionError);
      try { await recordPersistenceFailure(session.cwd, task, result); } catch { /* primary persistence error remains authoritative */ }
    }
    printResult(result);

    process.exitCode = timeoutTriggered ? 124 : error instanceof CancelledError ? 130 : 1;
    return;
  } finally {
    cleanupRace();
  }

  /*
   * 9. Get session stats with deadline and cleanup.
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
   * 10. Shutdown Pi.
   */
  removeRpcListener();
  await shutdownPi(pi, rpc, logger);

  const exitCode = pi.child.exitCode;

  logger.log("process_exit", {
    exit_code: exitCode
  });

  /*
   * 11. Validate agent completed.
   *
   *    Check child exit code first — a non-zero exit is an error
   *    regardless of settled status.
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

  if (!workerError && !state.settled) {
    workerError = createError(
      "protocol",
      "AGENT_SETTLED_MISSING",
      "Pi process ended without agent_settled",
      { retryable: true }
    );
  }

  /*
   * Check for final message — but only if we haven't already classified
   * a known provider error from pi_stderr.  A missing final message
   * should not mask a quota/auth/token failure.
   */
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
   * 12. Scope check.
   */
  logger.log("scope_check_start");

  const scopeMode = checkpointPlanning || task.execution_policy?.mode === "investigation"
    ? "read_only"
    : task.scope ?? "read_write";

  let scope: ScopeInfo;

  try {
    scope = await checkScope(
      executionCwd,
      baseline,
      task.allowed_paths ?? [],
      scopeMode
    );
  } catch (error) {
    if (
      error instanceof WorkspaceError &&
      error.fatal
    ) {
      /*
       * Git repo check or git query failed — this is a fatal error.
       * Do NOT silently treat it as "not_checked" or "passed".
       */
      workerError = createError(
        "runtime",
        "WORKSPACE_ERROR",
        error.message,
        { retryable: false }
      );

      scope = {
        status: "failed",
        allowed_paths: task.allowed_paths ?? [],
        scope_mode: scopeMode,
        changed_files: [],
        added_files: [],
        modified_files: [],
        deleted_files: [],
        violations: [
          {
            path: "(workspace)",
            reason: error.message
          }
        ]
      };
    } else {
      scope = {
        status: "not_checked",
        allowed_paths: task.allowed_paths ?? [],
        scope_mode: scopeMode,
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
  }

  logger.log("scope_check_end", {
    status: scope.status,
    changed_files: scope.changed_files
  });

  if (
    !workerError &&
    scope.status === "failed"
  ) {
    const code =
      scopeMode === "read_only"
        ? "READ_ONLY_SCOPE_VIOLATION"
        : "MODIFICATION_SCOPE_VIOLATION";

    const message =
      scopeMode === "read_only"
        ? "Worker modified files in read_only scope"
        : "Worker modified files outside allowed_paths";

    workerError = createError(
      "scope",
      code,
      message,
      { retryable: false, details: scope.violations }
    );
  }

  if (!workerError && !checkpointPlanning && task.execution_policy?.mode !== "investigation") {
    const maxFiles = task.execution_policy?.max_changed_files;
    const maxLines = task.execution_policy?.max_diff_lines;
    const diff = await measureDiff(executionCwd, scope.changed_files, baseline);
    if ((maxFiles !== undefined && scope.changed_files.length > maxFiles) ||
        (diff.hasBinary && task.execution_policy?.allow_binary_changes !== true) ||
        (maxLines !== undefined && diff.textDiffLines > maxLines)) {
      workerError = createError(
        "scope",
        "CHANGE_BUDGET_EXCEEDED",
        "Worker changes exceeded the declared execution policy budget",
        {
          retryable: false,
          details: {
            changed_files: scope.changed_files.length,
            max_changed_files: maxFiles,
            diff_lines: diff.textDiffLines,
            has_binary: diff.hasBinary,
            max_diff_lines: maxLines
          }
        }
      );
    }
  }

  /*
   * 13. Verification.
   */
  logger.log("verification_start");

  let verification = createDefaultVerification();

  if (!checkpointPlanning && task.verification?.commands?.length) {
    const verifyTimeout =
      task.verification.timeout_ms ??
      DEFAULT_VERIFY_TIMEOUT;

    try {
      verification = await runVerification(
        executionCwd,
        task.verification.commands,
        verifyTimeout,
        cancellationController.signal,
        isolatedWrite ? { containment: { writablePaths: [executionCwd, session.worker_session_dir] } } : undefined
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

    if (verification.status === "failed" && !workerError) {
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

  // Verification commands execute inside the candidate and may themselves
  // modify files. Recompute scope and budgets from the original baseline so
  // the exported patch, not merely the pre-verification state, is validated.
  if (!checkpointPlanning && task.execution_policy?.mode !== "investigation") {
    try {
      scope = await checkScope(executionCwd, baseline, task.allowed_paths ?? [], scopeMode);
      if (scope.status === "failed") {
        workerError = createError("scope", "MODIFICATION_SCOPE_VIOLATION",
          "Candidate including verification side effects changed files outside allowed_paths",
          { retryable: false, details: scope.violations });
      } else {
        const finalDiff = await measureDiff(executionCwd, scope.changed_files, baseline);
        if (scope.changed_files.length > (task.execution_policy?.max_changed_files ?? Number.MAX_SAFE_INTEGER) ||
            (finalDiff.hasBinary && task.execution_policy?.allow_binary_changes !== true) ||
            finalDiff.textDiffLines > (task.execution_policy?.max_diff_lines ?? Number.MAX_SAFE_INTEGER)) {
          workerError = createError("scope", "CHANGE_BUDGET_EXCEEDED",
            "Candidate including verification side effects exceeded its change budget",
            { retryable: false, details: { changed_files: scope.changed_files.length, diff_lines: finalDiff.textDiffLines, has_binary: finalDiff.hasBinary } });
        }
      }
    } catch (error) {
      workerError = createError("runtime", "WORKSPACE_ERROR", String(error), { retryable: false });
    }
  }

  const costLimit = task.execution_policy?.estimated_direct_cost_usd !== undefined &&
    task.execution_policy.max_cost_ratio !== undefined
      ? task.execution_policy.estimated_direct_cost_usd * task.execution_policy.max_cost_ratio
      : undefined;
  if (costLimit !== undefined && state.usage?.cost !== undefined && state.usage.cost >= costLimit) {
    workerError = createError(
      "scope", "WORKER_COST_BUDGET_EXCEEDED",
      "Worker cost reached the configured fraction of estimated direct execution cost",
      { retryable: false, details: { worker_cost_usd: state.usage?.cost ?? 0, cost_limit_usd: costLimit } }
    );
  }

  /*
   * 14. Build and print result.
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
    workerError,
    iterationNumber,
    session.failure_history
  );

  if (checkpointPlanning && !result.error) {
    result.status = "needs_continuation";
    result.continuation = { allow_continuation: true, state: "checkpoint_review" };
    result.needs_continuation = {
      reason: "Checkpoint plan is ready for coordinator review"
    };
  } else if (checkpointPlanning && result.error && result.continuation.allow_continuation) {
    result.continuation = {
      allow_continuation: false,
      state: "coordinator_required",
      reason: result.error.category === "scope" ? "scope_violation" : "coordinator_required",
      failure_class: failureClass(result.error)
    };
  }

  try {
    await prepareCandidateResult(session, result);
    await persistAndArchiveIfTerminal(session, result);
  } catch (sessionError) {
    logger.log("session_save_failed", {
      error: String(sessionError)
    });
    applySessionPersistenceFailure(result, sessionError);
    try { await recordPersistenceFailure(session.cwd, task, result); } catch { /* primary persistence error remains authoritative */ }
  }

  printResult(result);

  logger.log("task_finished", {
    status: result.status,
    iteration: iterationNumber
  });

  process.exitCode =
    result.status === "success" || result.status === "needs_continuation"
      ? 0
      : timeoutTriggered
        ? 124
        : runtime.signalReceived
          ? 130
          : 1;

  return;
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
