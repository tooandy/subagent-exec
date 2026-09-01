import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  loadSession,
  newSessionMetadata,
  resolveMetadataDir,
  resolvePiSessionDir,
  saveSession,
  withIteration,
  acquireSessionLease
} from "../src/session.js";
import { buildPiArgs } from "../src/process.js";
import { buildContinuePrompt, parseContinueTask } from "../src/task.js";

async function tempWorkspace(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "subagent-session-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("continuation contracts", () => {
  test("fails closed on a stale lease", async () => {
    const workspace = await tempWorkspace();
    try {
      const lockDir = join(workspace.dir, ".subagent-exec", "locks");
      await mkdir(lockDir, { recursive: true });
      await symlink("99999999", join(lockDir, "dead.json"));
      const release = await acquireSessionLease(workspace.dir, "dead");
      assert.equal(release, null);
    } finally { await workspace.cleanup(); }
  });

  test("concurrent contenders cannot reclaim a stale lease", async () => {
    const workspace = await tempWorkspace();
    try {
      const lockDir = join(workspace.dir, ".subagent-exec", "locks");
      await mkdir(lockDir, { recursive: true });
      await symlink("99999999", join(lockDir, "race.json"));
      const [a, b] = await Promise.all([
        acquireSessionLease(workspace.dir, "race"),
        acquireSessionLease(workspace.dir, "race")
      ]);
      assert.equal([a, b].filter(Boolean).length, 0);
      await a?.(); await b?.();
    } finally { await workspace.cleanup(); }
  });
  test("parses a valid continuation and rejects invalid timeout", () => {
    const value = parseContinueTask({
      schema_version: "1.0",
      task_id: "TASK-1",
      action: "continue",
      feedback: "Fix the failing test"
    });
    assert.equal(value.feedback, "Fix the failing test");
    assert.throws(() => parseContinueTask({
      schema_version: "1.0",
      task_id: "TASK-1",
      action: "continue",
      feedback: "x",
      timeout_ms: 86_400_001
    }));
  });

  test("builds bounded review feedback with previous summary", () => {
    const prompt = buildContinuePrompt("Fix it", 2, "Added implementation");
    assert.match(prompt, /REVIEW FEEDBACK \(iteration 2\)/);
    assert.match(prompt, /YOUR PREVIOUS SUMMARY/);
    assert.match(prompt, /Added implementation/);
  });
});

describe("session metadata", () => {
  test("separates metadata and Pi session directories", async () => {
    const workspace = await tempWorkspace();
    try {
      assert.equal(resolveMetadataDir(workspace.dir), join(workspace.dir, ".subagent-exec", "metadata"));
      assert.equal(resolvePiSessionDir(workspace.dir), join(workspace.dir, ".subagent-exec", "pi-sessions"));
    } finally {
      await workspace.cleanup();
    }
  });

  test("round-trips validated metadata and preserves continuation config", async () => {
    const workspace = await tempWorkspace();
    try {
      const metadata = newSessionMetadata({
        schema_version: "1.0",
        task_id: "ROUNDTRIP-1",
        prompt: "Implement it",
        cwd: workspace.dir,
        constraints: ["No dependencies"],
        verification: { commands: ["npm test"], timeout_ms: 1000 },
        iteration: { max_iterations: 2 }
      });
      assert.match(metadata.worker_session_id, /^[0-9a-f-]{36}$/);
      await saveSession(metadata);
      const loaded = await loadSession(workspace.dir, metadata.task_id);
      assert.deepEqual(loaded, JSON.parse(JSON.stringify(metadata)));
      assert.deepEqual(loaded?.original_task.verification?.commands, ["npm test"]);
      assert.equal(loaded?.original_task.iteration?.max_iterations, 2);
      assert.deepEqual(loaded?.original_task.constraints, ["No dependencies"]);
    } finally {
      await workspace.cleanup();
    }
  });

  test("rejects corrupt or structurally invalid session data", async () => {
    const workspace = await tempWorkspace();
    try {
      const dir = resolveMetadataDir(workspace.dir);
      await import("node:fs/promises").then(({ mkdir }) => mkdir(dir, { recursive: true }));
      await writeFile(join(dir, "BAD.json"), JSON.stringify({ schema_version: "1.0" }), "utf8");
      await assert.rejects(() => loadSession(workspace.dir, "BAD"), /failed to parse session file/);
    } finally {
      await workspace.cleanup();
    }
  });

  test("atomically replaces the metadata file without temp residue", async () => {
    const workspace = await tempWorkspace();
    try {
      const initial = newSessionMetadata({
        schema_version: "1.0", task_id: "ATOMIC-1", prompt: "x", cwd: workspace.dir
      });
      await saveSession(initial);
      await saveSession(withIteration(initial, { increment_iteration: true }));
      const text = await readFile(join(resolveMetadataDir(workspace.dir), "ATOMIC-1.json"), "utf8");
      assert.equal(JSON.parse(text).iteration, 1);
      const { readdir } = await import("node:fs/promises");
      assert.deepEqual((await readdir(resolveMetadataDir(workspace.dir))).filter((name) => name.endsWith(".tmp")), []);
    } finally {
      await workspace.cleanup();
    }
  });
});

describe("Pi session targeting", () => {
  test("creates and resumes exact independent session ids", () => {
    const first = newSessionMetadata({ schema_version: "1.0", task_id: "A", prompt: "a", cwd: "/tmp/a" });
    const second = newSessionMetadata({ schema_version: "1.0", task_id: "B", prompt: "b", cwd: "/tmp/a" });
    assert.notEqual(first.worker_session_id, second.worker_session_id);
    assert.deepEqual(buildPiArgs({ schema_version: "1.0", task_id: "A", prompt: "a" }, {
      sessionId: first.worker_session_id,
      sessionDir: first.worker_session_dir
    }).slice(0, 4), ["--mode", "rpc", "--session-id", first.worker_session_id]);
    const resumed = buildPiArgs({ schema_version: "1.0", task_id: "A", prompt: "a" }, {
      continueFrom: first,
      sessionDir: first.worker_session_dir
    });
    assert.deepEqual(resumed.slice(0, 4), ["--mode", "rpc", "--session", first.worker_session_id]);
    assert.ok(!resumed.includes("--continue"));
  });
});
