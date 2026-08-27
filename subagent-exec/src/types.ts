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
  | "timeout";

export interface TaskModel {
  provider?: string;
  model?: string;
}

export interface VerificationConfig {
  commands?: string[];
  timeout_ms?: number;
}

/**
 * Task Contract — the input JSON for a worker invocation.
 *
 * Schema version 1.0 is the stable baseline. Fields introduced after 1.0
 * are added in separate minor-version documents and are opt-in.
 *
 * Required fields (must be present and non-empty):
 *   - schema_version  (must be "1.0")
 *   - task_id
 *   - prompt
 *
 * Optional fields:
 *   - objective       high-level intent; coordinator-only, NOT sent to worker
 *   - cwd             working directory; defaults to process cwd
 *   - scope           read_only | read_write  (default: read_write)
 *   - allowed_paths   glob patterns; empty + read_write → no scope check;
 *                     empty + read_only → ANY modification is a violation
 *   - constraints     implementation constraints sent to worker as fixed section
 *   - acceptance_criteria  criteria sent to worker as fixed section
 *   - verification    post-execution commands
 *   - model           { provider, model } forwarded to worker runtime
 *   - timeout_ms      max execution ms; default 900000; max 86400000
 *   - metadata        passthrough data
 */
export interface Task {
  schema_version: "1.0";

  /** Unique task identifier. Matches ^[A-Za-z0-9._:-]+$, max 200 chars. */
  task_id: string;

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
  objective?: string;

  /** Working directory for the worker. Defaults to process cwd. */
  cwd?: string;

  /**
   * Scope mode for the workspace.
   *   - read_write  (default) worker may modify files matching allowed_paths
   *   - read_only   any file creation, modification, or deletion fails the task
   */
  scope?: "read_only" | "read_write";

  /**
   * Glob patterns the worker is allowed to modify.
   *   - read_write + empty  → scope is not checked
   *   - read_write + non-empty → only these paths may be modified
   *   - read_only + any value → ANY change is a violation
   */
  allowed_paths?: string[];

  /**
   * Implementation constraints sent to the worker as a structured section.
   * Each entry becomes a bullet point; no free-form concatenation.
   */
  constraints?: string[];

  /**
   * Acceptance criteria sent to the worker as a structured section.
   * Each entry becomes a bullet point; no free-form concatenation.
   */
  acceptance_criteria?: string[];

  verification?: VerificationConfig;

  model?: TaskModel;

  /** Maximum execution time in ms. Default 900000 (15 min). Max 86400000 (24 h). */
  timeout_ms?: number;

  metadata?: Record<string, unknown>;
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

  error: WorkerError | null;

  metadata?: Record<string, unknown>;
}
