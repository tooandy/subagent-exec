import { createHash } from "node:crypto";
import type { SessionMetadata, WorkerError, WorkerResult } from "./types.js";

export type CircuitReason = "scope_violation" | "budget_exceeded" | "repeated_failure" |
  "no_new_diagnostics" | "coordinator_required" | "iteration_limit";

export interface CircuitDecision {
  allow_continuation: boolean;
  state: "checkpoint_review" | "repairable_failure" | "coordinator_required" | "terminal_success";
  reason?: CircuitReason;
  failure_class?: string;
}

export function failureClass(error: WorkerError): string {
  if (error.category === "scope") return error.code.includes("BUDGET_EXCEEDED") ? "budget_exceeded" : "scope_violation";
  if (["protocol", "auth", "token", "architecture", "requirement"].includes(error.category)) return "coordinator_required";
  return `${error.category}:${error.code}`;
}

export function diagnosticFingerprint(result: WorkerResult): string {
  const diagnostic = JSON.stringify({
    error: result.error && { category: result.error.category, code: result.error.code },
    verification: result.verification.results.map((item) => ({ command: item.command, exit_code: item.exit_code, stdout: item.stdout, stderr: item.stderr })),
    unresolved: result.acceptance_evidence.unresolved_items,
    risks: result.acceptance_evidence.known_risks
  });
  return createHash("sha256").update(diagnostic).digest("hex");
}

export function evaluateResultCircuit(result: WorkerResult, previous: SessionMetadata["failure_history"] = []): CircuitDecision {
  if (!result.error) return { allow_continuation: false, state: "terminal_success" };
  const currentClass = failureClass(result.error);
  if (currentClass === "scope_violation" || currentClass === "budget_exceeded" || currentClass === "coordinator_required") {
    return { allow_continuation: false, state: "coordinator_required", reason: currentClass, failure_class: currentClass };
  }
  if (result.error.category === "runtime" && !result.error.retryable) {
    return { allow_continuation: false, state: "coordinator_required", reason: "coordinator_required", failure_class: currentClass };
  }
  const fingerprint = diagnosticFingerprint(result);
  const sameClass = previous.filter((item) => item.failure_class === currentClass);
  if (previous.some((item) => item.diagnostic_fingerprint === fingerprint)) {
    return { allow_continuation: false, state: "coordinator_required", reason: "no_new_diagnostics", failure_class: currentClass };
  }
  if (sameClass.length >= 1) {
    return { allow_continuation: false, state: "coordinator_required", reason: "repeated_failure", failure_class: currentClass };
  }
  return { allow_continuation: true, state: "repairable_failure", failure_class: currentClass };
}

export function canContinueSession(metadata: SessionMetadata): CircuitDecision {
  if (metadata.circuit?.state === "coordinator_required" || metadata.circuit?.state === "terminal_success") {
    return metadata.circuit;
  }
  return metadata.circuit ?? { allow_continuation: true, state: "repairable_failure" };
}
