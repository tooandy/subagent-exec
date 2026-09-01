export type ErrorCategory =
  | "quota"
  | "auth"
  | "token"
  | "runtime"
  | "protocol"
  | "scope"
  | "verification";

export type TaskStatus =
  | "success"
  | "failed"
  | "cancelled"
  | "timeout"
  | "needs_continuation";

export interface TaskModel {
  provider?: string;
  model?: string;
}

export interface VerificationConfig {
  commands?: string[];
  timeout_ms?: number;
}

/**
 * Iteration control — limits how many times the same task
 * session can be continued (i.e. how many feedback rounds
 * between Codex and Worker).
 */
export interface IterationConfig {
  /**
   * Maximum number of (prompt, response) rounds within a single
   * task session. The first prompt counts as iteration 1.
   * Default 1 means: start task, no continue. Set to 3 to
   * allow Worker self-check + Codex review + one fix.
   */
  max_iterations?: number;
}

export interface Task {
  schema_version: "1.0";

  task_id: string;

  objective: string;

  /**
   * Self-contained instruction sent to the worker.
   * When constraints or acceptance_criteria are present they are appended
   * in named sections so the worker receives them as structured data, not
   * free-form text that could be accidentally overridden by the prompt.
   */
  prompt: string;

  /**
   * High-level intent. Coordinator-only field; NOT transmitted to the worker.
   * Useful for Codex to track why a task was created.
   */
  objective_?: string;

  cwd?: string;

  scope?: "read_only" | "read_write";

  allowed_paths?: string[];

  constraints?: string[];

  acceptance_criteria?: string[];

  verification?: VerificationConfig;

  iteration?: IterationConfig;

  model?: TaskModel;

  timeout_ms?: number;

  metadata?: Record<string, unknown>;
}

/**
 * A continuation command sent to an existing task session.
 * Used for `subagent-exec --continue <task_id> --feedback <file>`.
 */
export interface ContinueTask {
  schema_version: "1.0";

  task_id: string;

  action: "continue";

  /**
   * Feedback from Codex (review findings, additional context,
   * retry instructions). Appended to the conversation as a new
   * user turn in the existing Worker session.
   */
  feedback: string;

  /**
   * Optional per-iteration timeout override. If absent, the
   * original task's timeout_ms applies.
   */
  timeout_ms?: number;

  metadata?: Record<string, unknown>;
}

/**
 * Session metadata persisted between iterations of the same task.
 *
 * Lives at <session_dir>/<task_id>.json. Contains enough info for
 * a fresh `subagent-exec --continue` invocation to spawn a new
 * Pi process and resume the previous session.
 */
export interface SessionMetadata {
  schema_version: "1.0";

  task_id: string;

  /**
   * The worker runtime's session handle (e.g. Pi's session UUID).
   * Used to spawn `--session <id>` on subsequent iterations.
   */
  worker_session_id?: string;

  /**
   * Path to the worker's session storage directory (e.g. Pi's
   * ~/.pi/sessions/<project>/<id>). Used to disambiguate when
   * multiple tasks share a worker session namespace.
   */
  worker_session_dir?: string;

  /**
   * Number of (prompt, response) rounds completed so far.
   * The first start creates iteration 1; each continue bumps it.
   */
  iteration: number;

  /**
   * Last successful result, if any. Used to summarize for the
   * next iteration's prompt so the worker can pick up where it
   * left off without re-deriving context.
   */
  last_result?: {
    status: TaskStatus;
    summary?: string;
    changed_files: string[];
  };

  /**
   * Working directory captured at start. Continuation invocations
   * must run in the same directory to keep scope check meaningful.
   */
  cwd: string;

  created_at: string;
  updated_at: string;

  /**
   * Original task parameters. Captured at start so continue
   * commands don't need to resupply cwd/timeout/etc.
   */
  original_task: {
    objective: string;
    prompt: string;
    scope?: "read_only" | "read_write";
    allowed_paths?: string[];
    constraints?: string[];
    acceptance_criteria?: string[];
    model?: TaskModel;
    timeout_ms?: number;
    metadata?: Record<string, unknown>;
  };
}

export interface ExecutionInfo {
  started_at: string;
  finished_at: string;
  duration_ms: number;

  pid?: number;

  exit_code?: number | null;

  signal?: string | null;
}

export interface WorkerInfo {
  runtime: "pi";

  provider?: string;

  model?: string;

  /**
   * The worker runtime's session ID for this iteration.
   * Persisted to SessionMetadata.worker_session_id.
   */
  session_id?: string;
}

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;

  cache_read_tokens: number;
  cache_write_tokens: number;

  total_tokens: number;

  cost?: number;

  currency?: string;
}

export interface ScopeViolation {
  path: string;

  reason: string;
}

export interface ScopeInfo {
  status:
    | "passed"
    | "failed"
    | "not_checked";

  allowed_paths: string[];

  scope_mode: "read_only" | "read_write";

  changed_files: string[];

  added_files: string[];

  modified_files: string[];

  deleted_files: string[];

  violations: ScopeViolation[];
}

export interface VerificationResult {
  status:
    | "passed"
    | "failed"
    | "not_run";

  commands: string[];

  results: Array<{
    command: string;

    exit_code: number | null;

    duration_ms: number;

    stdout?: string;

    stderr?: string;
  }>;
}

export interface WorkerError {
  category: ErrorCategory;

  code: string;

  message: string;

  details?: unknown;

  retryable?: boolean;
}

export interface WorkerResult {
  schema_version: "1.0";

  task_id: string;

  status: TaskStatus;

  worker: WorkerInfo;

  execution: ExecutionInfo;

  result: {
    summary?: string;

    final_message?: string;

    changed_files: string[];
  };

  scope: ScopeInfo;

  verification: VerificationResult;

  usage?: UsageInfo;

  /**
   * Current iteration number (1-based). Always present.
   */
  iteration: number;

  /**
   * Set when status is needs_continuation — the Worker is asking
   * Codex for review feedback. Always includes the changed_files
   * so Codex can plan the next round without re-running git diff.
   */
  needs_continuation?: {
    reason: string;
  };

  error: WorkerError | null;

  metadata?: Record<string, unknown>;
}
