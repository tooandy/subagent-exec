export type ErrorCategory =
  | "quota"
  | "auth"
  | "token"
  | "runtime"
  | "protocol";

export type TaskStatus =
  | "success"
  | "failed"
  | "cancelled"
  | "timeout";

export interface TaskModel {
  provider?: string;
  model?: string;
}

export interface Task {
  task_id: string;

  objective: string;

  /**
   * Actual prompt sent to Pi.
   */
  prompt: string;

  /**
   * Working directory.
   */
  cwd?: string;

  /**
   * Files/directories the worker is allowed to modify.
   *
   * Glob patterns, e.g.
   *   src/foo/**
   *   tests/foo/**
   */
  allowed_paths?: string[];

  constraints?: string[];

  acceptance_criteria?: string[];

  model?: TaskModel;

  timeout_ms?: number;

  /**
   * Additional metadata that is simply carried through.
   */
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
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export interface ScopeViolation {
  path: string;
  reason: string;
}

export interface ScopeInfo {
  status: "passed" | "failed" | "not_checked";
  allowed_paths: string[];
  changed_files: string[];
  violations: ScopeViolation[];
}

export interface TestInfo {
  status: "unknown" | "passed" | "failed";
  commands: string[];
}

export interface WorkerError {
  category: ErrorCategory;
  code: string;
  message: string;
  details?: unknown;
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

  tests: TestInfo;

  usage?: UsageInfo;

  error: WorkerError | null;

  metadata?: Record<string, unknown>;
}
