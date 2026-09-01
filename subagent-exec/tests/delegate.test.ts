import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, test } from "node:test";

const script = resolve(process.cwd(), "../scripts/delegate.sh");

function run(args: string[]) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } });
}

describe("delegate.sh argument validation", () => {
  test("rejects missing input", () => {
    const result = run([]);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /usage/);
  });

  test("rejects continuation without feedback", () => {
    const result = run(["--continue", "TASK-1"]);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /requires --feedback/);
  });

  test("rejects conflicting continuation and task file", () => {
    const result = run(["--continue", "TASK-1", "--feedback", "feedback.json", "task.json"]);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /cannot be combined/);
  });

  test("rejects repeated options", () => {
    const result = run(["--continue", "A", "--continue", "B", "--feedback", "feedback.json"]);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /only be specified once/);
    assert.match(run(["--continue", "A", "--feedback", "a", "--feedback", "b"]).stderr, /only be specified once/);
    assert.match(run(["--task-id", "A", "--task-id", "B", "task.json"]).stderr, /only be specified once/);
  });

  test("rejects unknown options and multiple files", () => {
    assert.equal(run(["--wat"]).status, 64);
    assert.equal(run(["one.json", "two.json"]).status, 64);
    assert.equal(run(["--feedback", "feedback.json", "task.json"]).status, 64);
  });
});
