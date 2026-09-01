import type {
  ErrorCategory,
  WorkerError
} from "./types.js";
import { isQuotaMessage } from "./model-policy.js";

export class ClassifiedError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ClassifiedError";
  }
}

export function createError(
  category: ErrorCategory,
  code: string,
  message: string,
  options: {
    retryable?: boolean;
    details?: unknown;
  } = {}
): WorkerError {
  return {
    category,
    code,
    message,
    retryable: options.retryable ?? false,
    details: options.details
  };
}

export function classifyError(
  error: unknown,
  fallbackCategory: ErrorCategory = "runtime"
): WorkerError {
  if (error instanceof ClassifiedError) {
    return {
      category: error.category,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details
    };
  }

  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const lower = message.toLowerCase();

  if (lower.includes("architecture decision") || lower.includes("architectural decision")) {
    return createError("architecture", "ARCHITECTURE_DECISION_REQUIRED", message, { retryable: false });
  }
  if (lower.includes("ambiguous requirement") || lower.includes("requirements unclear")) {
    return createError("requirement", "REQUIREMENT_CLARIFICATION_REQUIRED", message, { retryable: false });
  }

  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication") ||
    lower.includes("api key") ||
    lower.includes("credential")
  ) {
    return createError(
      "auth",
      "AUTH_ERROR",
      message,
      { retryable: false }
    );
  }

  if (isQuotaMessage(lower)) {
    return createError(
      "quota",
      "PROVIDER_QUOTA_EXCEEDED",
      message,
      { retryable: true }
    );
  }

  if (
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("too many tokens") ||
    lower.includes("maximum tokens") ||
    lower.includes("max tokens") ||
    lower.includes("token limit")
  ) {
    return createError(
      "token",
      "TOKEN_LIMIT",
      message,
      { retryable: false }
    );
  }

  return createError(
    fallbackCategory,
    "RUNTIME_ERROR",
    message,
    { retryable: false }
  );
}

export function quotaError(
  message: string,
  details?: unknown
): ClassifiedError {
  return new ClassifiedError(
    "quota",
    "PROVIDER_QUOTA_EXCEEDED",
    message,
    true,
    details
  );
}

export function authError(
  message: string,
  details?: unknown
): ClassifiedError {
  return new ClassifiedError(
    "auth",
    "AUTH_ERROR",
    message,
    false,
    details
  );
}

export function tokenError(
  message: string,
  details?: unknown
): ClassifiedError {
  return new ClassifiedError(
    "token",
    "TOKEN_LIMIT",
    message,
    false,
    details
  );
}

export function runtimeError(
  code: string,
  message: string,
  details?: unknown,
  retryable = false
): ClassifiedError {
  return new ClassifiedError(
    "runtime",
    code,
    message,
    retryable,
    details
  );
}

export function protocolError(
  code: string,
  message: string,
  details?: unknown,
  retryable = false
): ClassifiedError {
  return new ClassifiedError(
    "protocol",
    code,
    message,
    retryable,
    details
  );
}

export function scopeError(
  message: string,
  details?: unknown
): ClassifiedError {
  return new ClassifiedError(
    "scope",
    "MODIFICATION_SCOPE_VIOLATION",
    message,
    false,
    details
  );
}

export function verificationError(
  message: string,
  details?: unknown
): ClassifiedError {
  return new ClassifiedError(
    "verification",
    "VERIFICATION_FAILED",
    message,
    false,
    details
  );
}

export function maxIterationsError(
  message: string,
  details?: unknown
): ClassifiedError {
  return new ClassifiedError(
    "runtime",
    "MAX_ITERATIONS_EXCEEDED",
    message,
    false,
    details
  );
}

export function sessionNotFoundError(
  taskId: string
): ClassifiedError {
  return new ClassifiedError(
    "protocol",
    "SESSION_NOT_FOUND",
    `No active session for task_id "${taskId}". Start a new task with --task first.`,
    false,
    { task_id: taskId }
  );
}
