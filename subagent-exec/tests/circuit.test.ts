import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { diagnosticFingerprint, evaluateResultCircuit } from "../src/circuit.js";
import type { WorkerResult } from "../src/types.js";

function failed(category: "scope" | "verification" | "architecture" = "verification", code = "VERIFICATION_FAILED"): WorkerResult {
  return {
    schema_version: "1.0", task_id: "T", status: "failed", worker: { runtime: "pi" },
    execution: { started_at: "x", finished_at: "x", duration_ms: 1 },
    result: { changed_files: [] },
    scope: { status: "passed", allowed_paths: [], scope_mode: "read_write", changed_files: [], added_files: [], modified_files: [], deleted_files: [], violations: [] },
    verification: { status: "failed", commands: ["false"], results: [{ command: "false", exit_code: 1, duration_ms: 1, stderr: "same" }] },
    acceptance_evidence: { assumptions: [], decisions: [], criteria: [], changed_symbols: [], tests_added: [], known_risks: [], unresolved_items: [], review_locations: [] },
    continuation: { allow_continuation: false, state: "coordinator_required" }, iteration: 1,
    error: { category, code, message: "failed", retryable: false }
  };
}

describe("repair circuit breaker", () => {
  test("scope, budget, and architecture failures require immediate coordinator takeover", () => {
    assert.equal(evaluateResultCircuit(failed("scope", "MODIFICATION_SCOPE_VIOLATION")).reason, "scope_violation");
    assert.equal(evaluateResultCircuit(failed("scope", "CHANGE_BUDGET_EXCEEDED")).reason, "budget_exceeded");
    assert.equal(evaluateResultCircuit(failed("architecture", "ARCHITECTURE_DECISION_REQUIRED")).reason, "coordinator_required");
  });

  test("allows one verification repair, then stops on repeated or unchanged diagnostics", () => {
    const first = failed();
    assert.equal(evaluateResultCircuit(first).allow_continuation, true);
    const history = [{ failure_class: "verification:VERIFICATION_FAILED", diagnostic_fingerprint: diagnosticFingerprint(first) }];
    assert.equal(evaluateResultCircuit(first, history).reason, "no_new_diagnostics");
    const changed = failed(); changed.verification.results[0].stderr = "new evidence";
    assert.equal(evaluateResultCircuit(changed, history).reason, "repeated_failure");
  });
});
