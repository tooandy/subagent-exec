import type { ExecutionMode, Task } from "./types.js";

export interface AdmissionDecision {
  accepted: boolean;
  mode: ExecutionMode;
  reasons: string[];
}

export function evaluateAdmission(task: Task): AdmissionDecision {
  const policy = task.execution_policy;
  const reasons: string[] = [];
  const readOnly = task.scope === "read_only";

  if (!policy) {
    return {
      accepted: false,
      mode: readOnly ? "investigation" : "fast",
      reasons: ["execution_policy is required"]
    };
  }

  if (policy.mode === "investigation") {
    if (!readOnly) reasons.push("investigation mode requires scope=read_only");
    if (policy.risk !== "high") reasons.push("investigation mode requires risk=high");
    if ((task.iteration?.max_iterations ?? 1) !== 1) {
      reasons.push("investigation mode requires max_iterations=1");
    }
  } else {
    if (readOnly) reasons.push(`${policy.mode} mode requires scope=read_write`);
    if (!task.allowed_paths?.length) reasons.push("implementation requires allowed_paths");
    else if (task.allowed_paths.some(isUnboundedPath)) reasons.push("allowed_paths must be bounded repository-relative patterns");
    if (!task.acceptance_criteria?.length) reasons.push("implementation requires acceptance_criteria");
    if (!task.verification?.commands?.length) reasons.push("implementation requires verification.commands");
    if (!policy.max_changed_files) reasons.push("implementation requires max_changed_files");
    if (!policy.max_diff_lines) reasons.push("implementation requires max_diff_lines");
    if (policy.mode === "fast") {
      if (policy.risk !== "low") reasons.push("fast mode requires risk=low");
      if ((task.iteration?.max_iterations ?? 1) !== 1) reasons.push("fast mode requires max_iterations=1");
    }
    if (policy.mode === "checkpoint") {
      if (policy.risk !== "medium") reasons.push("checkpoint mode requires risk=medium");
      if ((task.iteration?.max_iterations ?? 2) !== 2) reasons.push("checkpoint mode requires max_iterations=2");
    }
  }

  return { accepted: reasons.length === 0, mode: policy.mode, reasons };
}

function isUnboundedPath(pattern: string): boolean {
  const normalized = pattern.trim().replace(/\\/g, "/");
  // Only a deliberately small, auditable glob subset is admitted. Braces,
  // character classes, extglobs and negation can expand into repository-wide
  // matches that are not obvious from the literal pattern.
  if (/[{}[\]()!+@?]/.test(normalized)) return true;
  return !normalized || normalized.startsWith("/") || normalized === "." ||
    normalized === "*" || normalized === "**" || normalized === "**/*" ||
    normalized.startsWith("**/") ||
    normalized.split("/").includes("..");
}

export function isCheckpointPlanningRound(task: Task, iteration: number): boolean {
  return task.execution_policy?.mode === "checkpoint" && iteration === 1;
}
