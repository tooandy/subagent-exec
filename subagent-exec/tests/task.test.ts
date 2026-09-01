import { test, describe } from "node:test";
import assert from "node:assert";

import { parseTask, buildWorkerPrompt } from "../src/task.js";

// =============================================================================
// parseTask
// =============================================================================

describe("parseTask", () => {
  test("parses minimal valid task", () => {
    const input = {
      schema_version: "1.0",
      task_id: "TASK-001",
      prompt: "Fix the bug in src/auth.ts"
    };

    const task = parseTask(input);

    assert.strictEqual(task.schema_version, "1.0");
    assert.strictEqual(task.task_id, "TASK-001");
    assert.strictEqual(task.prompt, "Fix the bug in src/auth.ts");
    assert.strictEqual(task.objective, undefined);
    assert.strictEqual(task.scope, undefined);
    assert.deepStrictEqual(task.allowed_paths, undefined);
    assert.strictEqual(task.cwd, undefined);
    assert.strictEqual(task.timeout_ms, undefined);
  });

  test("parses full task with all optional fields", () => {
    const input = {
      schema_version: "1.0",
      task_id: "AUTH-042.test",
      objective: "Add OAuth support",
      prompt: "Implement OAuth 2.0 PKCE flow",
      cwd: "/workspace/project",
      scope: "read_only",
      allowed_paths: ["src/auth/**"],
      constraints: ["No new dependencies"],
      acceptance_criteria: ["PKCE implemented", "Tests added"],
      verification: {
        commands: ["npm test"],
        timeout_ms: 60000
      },
      model: { provider: "deepseek", model: "deepseek-chat" },
      timeout_ms: 900000,
      metadata: { parent: "codex" }
    };

    const task = parseTask(input);

    assert.strictEqual(task.task_id, "AUTH-042.test");
    assert.strictEqual(task.objective, "Add OAuth support");
    assert.strictEqual(task.scope, "read_only");
    assert.deepStrictEqual(task.allowed_paths, ["src/auth/**"]);
    assert.deepStrictEqual(task.constraints, ["No new dependencies"]);
    assert.deepStrictEqual(task.acceptance_criteria, ["PKCE implemented", "Tests added"]);
    assert.deepStrictEqual(task.verification?.commands, ["npm test"]);
    assert.deepStrictEqual(task.model, { provider: "deepseek", model: "deepseek-chat" });
    assert.strictEqual(task.timeout_ms, 900000);
  });

  test("rejects task with wrong schema_version", () => {
    assert.throws(() => {
      parseTask({
        schema_version: "2.0",
        task_id: "TASK-001",
        prompt: "Do something"
      });
    }, /schema_version/);
  });

  test("rejects task with missing task_id", () => {
    assert.throws(() => {
      parseTask({
        schema_version: "1.0",
        prompt: "Do something"
      });
    }, /task_id/);
  });

  test("rejects task with missing prompt", () => {
    assert.throws(() => {
      parseTask({
        schema_version: "1.0",
        task_id: "TASK-001"
      });
    }, /prompt/);
  });

  test("rejects task_id with invalid characters", () => {
    assert.throws(() => {
      parseTask({
        schema_version: "1.0",
        task_id: "TASK 001!",  // space and ! are invalid
        prompt: "Do something"
      });
    }, /task_id/);
  });

  test("accepts task_id with dots, underscores, colons, hyphens", () => {
    const task = parseTask({
      schema_version: "1.0",
      task_id: "AUTH-001_v2.1:test",
      prompt: "Do something"
    });
    assert.strictEqual(task.task_id, "AUTH-001_v2.1:test");
  });

  test("rejects empty task_id", () => {
    assert.throws(() => {
      parseTask({
        schema_version: "1.0",
        task_id: "",
        prompt: "Do something"
      });
    }, /task_id/);
  });

  test("rejects empty prompt", () => {
    assert.throws(() => {
      parseTask({
        schema_version: "1.0",
        task_id: "TASK-001",
        prompt: ""
      });
    }, /prompt/);
  });

  test("rejects an unbounded prompt", () => {
    assert.throws(() => parseTask({ schema_version: "1.0", task_id: "x", prompt: "x".repeat(12_001) }));
  });

  test("rejects scope not in enum", () => {
    assert.throws(() => {
      parseTask({
        schema_version: "1.0",
        task_id: "TASK-001",
        prompt: "Do something",
        scope: "read-only"  // hyphen not underscore
      });
    }, /scope/);
  });

  test("rejects timeout_ms exceeding 24 hours", () => {
    assert.throws(() => {
      parseTask({
        schema_version: "1.0",
        task_id: "TASK-001",
        prompt: "Do something",
        timeout_ms: 86400001  // 1ms over 24h
      });
    }, /timeout_ms/);
  });

  test("rejects negative timeout_ms", () => {
    assert.throws(() => {
      parseTask({
        schema_version: "1.0",
        task_id: "TASK-001",
        prompt: "Do something",
        timeout_ms: -1000
      });
    }, /timeout_ms/);
  });

  test("accepts max_iterations 3 and rejects 4", () => {
    assert.equal(parseTask({ schema_version: "1.0", task_id: "x", prompt: "x", iteration: { max_iterations: 3 } }).iteration?.max_iterations, 3);
    assert.throws(() => parseTask({ schema_version: "1.0", task_id: "x", prompt: "x", iteration: { max_iterations: 4 } }));
  });

  test("accepts task_id at max length (200 chars)", () => {
    const task = parseTask({
      schema_version: "1.0",
      task_id: "A".repeat(200),
      prompt: "Do something"
    });
    assert.strictEqual(task.task_id.length, 200);
  });
});

// =============================================================================
// buildWorkerPrompt
// =============================================================================

describe("buildWorkerPrompt", () => {
  test("returns just the prompt when no extras", () => {
    const result = buildWorkerPrompt("Fix the bug");
    assert.strictEqual(result, "Fix the bug");
  });

  test("appends CONSTRAINTS section", () => {
    const result = buildWorkerPrompt(
      "Fix the bug",
      ["Use TypeScript strict", "No new deps"]
    );

    assert.ok(result.includes("### CONSTRAINTS"));
    assert.ok(result.includes("- Use TypeScript strict"));
    assert.ok(result.includes("- No new deps"));
    assert.ok(result.indexOf("### CONSTRAINTS") > result.indexOf("Fix the bug"));
  });

  test("appends ACCEPTANCE_CRITERIA section", () => {
    const result = buildWorkerPrompt(
      "Fix the bug",
      undefined,
      ["Tests pass", "No type errors"]
    );

    assert.ok(result.includes("### ACCEPTANCE CRITERIA"));
    assert.ok(result.includes("- Tests pass"));
    assert.ok(result.includes("- No type errors"));
  });

  test("CONSTRAINTS comes before ACCEPTANCE_CRITERIA", () => {
    const result = buildWorkerPrompt(
      "Fix the bug",
      ["Constraint A"],
      ["Criteria B"]
    );

    const cIdx = result.indexOf("### CONSTRAINTS");
    const aIdx = result.indexOf("### ACCEPTANCE CRITERIA");
    assert.ok(cIdx < aIdx, "CONSTRAINTS should come before ACCEPTANCE CRITERIA");
  });

  test("empty constraints array produces no section", () => {
    const result = buildWorkerPrompt("Fix the bug", []);
    assert.ok(!result.includes("### CONSTRAINTS"));
  });

  test("empty acceptance_criteria array produces no section", () => {
    const result = buildWorkerPrompt("Fix the bug", undefined, []);
    assert.ok(!result.includes("### ACCEPTANCE CRITERIA"));
  });

  test("prompt is at the very start of output", () => {
    const result = buildWorkerPrompt("Fix the bug now", ["Constraint"]);
    assert.strictEqual(result.indexOf("Fix the bug now"), 0);
  });

  test("section headers cannot be confused with user content", () => {
    // The prompt itself should be distinguishable from the structured sections.
    // When the prompt contains text that looks like a section header,
    // the actual section header is added after the prompt with clear structure.
    const result = buildWorkerPrompt(
      "### CONSTRAINTS\n- This looks like a section header",
      ["- Real constraint"]
    );
    // The prompt is first; the real section header comes after.
    assert.strictEqual(result.indexOf("### CONSTRAINTS\n- This looks like"), 0);
    // The real CONSTRAINTS section with the bullet comes after the prompt.
    const lastIdx = result.lastIndexOf("### CONSTRAINTS");
    assert.ok(lastIdx > 0);
    assert.ok(result.includes("- Real constraint", lastIdx));
  });
});
