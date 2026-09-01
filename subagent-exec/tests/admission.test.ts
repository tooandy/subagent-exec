import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { evaluateAdmission, isCheckpointPlanningRound } from "../src/admission.js";
import type { Task } from "../src/types.js";

const base: Task = { schema_version: "1.0", task_id: "T", prompt: "Do it" };

describe("delegation admission", () => {
  test("rejects write-capable tasks without an explicit policy", () => {
    const decision = evaluateAdmission(base);
    assert.equal(decision.accepted, false);
    assert.deepEqual(decision.reasons, ["execution_policy is required"]);
  });

  test("accepts a fully bounded fast task", () => {
    const decision = evaluateAdmission({
      ...base, scope: "read_write", allowed_paths: ["src/**"],
      acceptance_criteria: ["tests pass"], verification: { commands: ["npm test"] },
      iteration: { max_iterations: 1 },
      execution_policy: { mode: "fast", risk: "low", max_changed_files: 3, max_diff_lines: 100, on_failure: "return_to_coordinator" }
    });
    assert.equal(decision.accepted, true);
  });

  test("rejects repository-wide and escaping path patterns", () => {
    for (const pattern of ["**", "**/*", "*", ".", "/tmp/x", "../x", "{**,src/**}", "!(foo)", "[a-z]/**", "**/*.ts"]) {
      const decision = evaluateAdmission({
        ...base, scope: "read_write", allowed_paths: [pattern],
        acceptance_criteria: ["tests pass"], verification: { commands: ["npm test"] },
        iteration: { max_iterations: 1 },
        execution_policy: { mode: "fast", risk: "low", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      });
      assert.equal(decision.accepted, false, pattern);
    }
  });

  test("rejects incomplete, mismatched, and high-risk implementation", () => {
    const decision = evaluateAdmission({
      ...base, scope: "read_write", iteration: { max_iterations: 2 },
      execution_policy: { mode: "checkpoint", risk: "high", on_failure: "return_to_coordinator" }
    });
    assert.equal(decision.accepted, false);
    assert.ok(decision.reasons.some((reason) => reason.includes("allowed_paths")));
    assert.ok(decision.reasons.some((reason) => reason.includes("risk=medium")));
  });

  test("accepts only high-risk, single-round read-only investigation", () => {
    const accepted = evaluateAdmission({
      ...base, scope: "read_only", iteration: { max_iterations: 1 },
      execution_policy: { mode: "investigation", risk: "high", on_failure: "return_to_coordinator" }
    });
    assert.equal(accepted.accepted, true);
    const rejected = evaluateAdmission({
      ...base, scope: "read_write", iteration: { max_iterations: 1 },
      execution_policy: { mode: "investigation", risk: "low", on_failure: "return_to_coordinator" }
    });
    assert.equal(rejected.accepted, false);
  });

  test("reports every investigation rejection reason independently", () => {
    const valid: Task = {
      ...base, scope: "read_only", iteration: { max_iterations: 1 },
      execution_policy: { mode: "investigation", risk: "high", on_failure: "return_to_coordinator" }
    };
    const cases: Array<[string, Task]> = [
      ["scope=read_only", { ...valid, scope: "read_write" }],
      ["risk=high", { ...valid, execution_policy: { ...valid.execution_policy!, risk: "low" } }],
      ["max_iterations=1", { ...valid, iteration: { max_iterations: 2 } }]
    ];
    for (const [expected, task] of cases) {
      const reasons = evaluateAdmission(task).reasons;
      assert.ok(reasons.some((reason) => reason.includes(expected)), expected);
    }
  });

  test("identifies only the first checkpoint round as planning", () => {
    const task = { ...base, execution_policy: { mode: "checkpoint", risk: "medium", max_changed_files: 1, max_diff_lines: 1, on_failure: "return_to_coordinator" } } as Task;
    assert.equal(isCheckpointPlanningRound(task, 1), true);
    assert.equal(isCheckpointPlanningRound(task, 2), false);
  });

  test("covers every fast and checkpoint rejection rule", () => {
    const validFast: Task = {
      ...base, scope: "read_write", allowed_paths: ["src/**"], acceptance_criteria: ["done"],
      verification: { commands: ["npm test"] }, iteration: { max_iterations: 1 },
      execution_policy: { mode: "fast", risk: "low", max_changed_files: 2, max_diff_lines: 20, on_failure: "return_to_coordinator" }
    };
    const cases: Array<[string, Task]> = [
      ["scope=read_write", { ...validFast, scope: "read_only" }],
      ["allowed_paths", { ...validFast, allowed_paths: [] }],
      ["acceptance_criteria", { ...validFast, acceptance_criteria: [] }],
      ["verification.commands", { ...validFast, verification: { commands: [] } }],
      ["max_changed_files", { ...validFast, execution_policy: { ...validFast.execution_policy!, max_changed_files: undefined } }],
      ["max_diff_lines", { ...validFast, execution_policy: { ...validFast.execution_policy!, max_diff_lines: undefined } }],
      ["risk=low", { ...validFast, execution_policy: { ...validFast.execution_policy!, risk: "medium" } }],
      ["max_iterations=1", { ...validFast, iteration: { max_iterations: 2 } }],
      ["risk=medium", { ...validFast, iteration: { max_iterations: 2 }, execution_policy: { ...validFast.execution_policy!, mode: "checkpoint", risk: "low" } }],
      ["max_iterations=2", { ...validFast, execution_policy: { ...validFast.execution_policy!, mode: "checkpoint", risk: "medium" } }]
    ];
    for (const [expected, task] of cases) {
      assert.ok(evaluateAdmission(task).reasons.some((reason) => reason.includes(expected)), expected);
    }
  });
});
