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

export interface Task {
  schema_version: "1.0";

  task_id: string;

  objective: string;

  prompt: string;

  cwd?: string;

  allowed_paths?: string[];

  constraints?: string[];

  acceptance_criteria?: string[];

  verification?: VerificationConfig;

  model?: TaskModel;

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
