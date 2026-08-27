import type {
  ErrorCategory,
  WorkerError
} from "./types.js";

export class ClassifiedError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ClassifiedError";
  }
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
      details: error.details
    };
  }

  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const lower = message.toLowerCase();

  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication") ||
    lower.includes("api key") ||
    lower.includes("credential")
  ) {
    return {
      category: "auth",
      code: "AUTH_ERROR",
      message
    };
  }

  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("quota") ||
    lower.includes("too many requests")
  ) {
    return {
      category: "quota",
      code: "PROVIDER_QUOTA_EXCEEDED",
      message
    };
  }

  if (
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("too many tokens") ||
    lower.includes("maximum tokens") ||
    lower.includes("max tokens") ||
    lower.includes("token limit")
  ) {
    return {
      category: "token",
      code: "TOKEN_LIMIT",
      message
    };
  }

  return {
    category: fallbackCategory,
    code: "RUNTIME_ERROR",
    message
  };
}

export function quotaError(
  message: string,
  details?: unknown
): ClassifiedError {
  return new ClassifiedError(
    "quota",
    "PROVIDER_QUOTA_EXCEEDED",
    message,
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
    details
  );
}

export function runtimeError(
  code: string,
  message: string,
  details?: unknown
): ClassifiedError {
  return new ClassifiedError(
    "runtime",
    code,
    message,
    details
  );
}

export function protocolError(
  code: string,
  message: string,
  details?: unknown
): ClassifiedError {
  return new ClassifiedError(
    "protocol",
    code,
    message,
    details
  );
}
