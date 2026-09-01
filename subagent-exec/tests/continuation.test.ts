import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, test } from "node:test";

const cli = resolve(process.cwd(), "dist/cli.js");

async function fixture(mode = "success") {
  const dir = await mkdtemp(join(tmpdir(), "subagent-cli-"));
  const argsLog = `${dir}.args.log`;
  const promptsLog = `${dir}.prompts.log`;
  const bin = join(dir, "bin");
  await mkdir(bin);
  const pi = join(bin, "pi");
  await writeFile(pi, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes("\\n")) {
    const i = buffer.indexOf("\\n");
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      fs.appendFileSync(process.env.PI_PROMPTS_LOG, command.message + "\\n---PROMPT---\\n");
      if (process.env.PI_TOUCH) fs.writeFileSync(process.env.PI_TOUCH, "worker change");
      process.stdout.write(JSON.stringify({type:"response",id:command.id,success:true})+"\\n");
      if ((process.env.PI_MODE || ${JSON.stringify(mode)}) !== "hang") {
        process.stdout.write(JSON.stringify({type:"agent_start"})+"\\n");
        process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:"done"}})+"\\n");
        process.stdout.write(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:"done"}]})+"\\n");
        process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n");
      }
    } else if (command.type === "get_session_stats") {
      process.stdout.write(JSON.stringify({type:"response",id:command.id,success:true,data:{tokens:{input:1,output:1,cacheRead:0,cacheWrite:0},cost:0.01}})+"\\n");
    } else if (command.type === "abort") {
      process.stdout.write(JSON.stringify({type:"response",id:command.id,success:true})+"\\n");
      setTimeout(() => process.exit(0), 5);
    }
  }
});
`, "utf8");
  await chmod(pi, 0o755);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "tracked.txt"), "base", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return {
    dir,
    argsLog,
    promptsLog,
    env: { ...process.env, PI_ARGS_LOG: argsLog, PI_PROMPTS_LOG: promptsLog, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(argsLog, { force: true });
      await rm(promptsLog, { force: true });
    }
  };
}

function runCli(cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: "pipe" });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("continuation CLI integration", () => {
  test("starts then resumes the exact same session and reruns verification", async () => {
    const f = await fixture();
    try {
      const task = {
        schema_version: "1.0", task_id: "FLOW-1", prompt: "first", cwd: f.dir,
        scope: "read_only", constraints: ["stay read-only"],
        acceptance_criteria: ["return a concise result"], iteration: { max_iterations: 2 },
        verification: { commands: ["node -e \"require('fs').appendFileSync('verified.log','v')\""] }
      };
      const first = await runCli(f.dir, f.env, [], JSON.stringify(task));
      assert.equal(first.code, 0, first.stderr);
      const continued = await runCli(f.dir, f.env, ["--continue", "FLOW-1"], JSON.stringify({
        schema_version: "1.0", task_id: "FLOW-1", action: "continue", feedback: "review feedback"
      }));
      assert.equal(continued.code, 0, continued.stderr);
      assert.equal(await readFile(join(f.dir, "verified.log"), "utf8"), "vv");
      const args = (await readFile(f.argsLog, "utf8")).trim().split("\n").map(JSON.parse);
      const createdId = args[0][args[0].indexOf("--session-id") + 1];
      const resumedId = args[1][args[1].indexOf("--session") + 1];
      assert.equal(resumedId, createdId);
      assert.ok(!args[1].includes("--continue"));
      const prompts = await readFile(f.promptsLog, "utf8");
      const continuedPrompt = prompts.split("---PROMPT---")[1];
      assert.match(continuedPrompt, /### CONSTRAINTS\nstay read-only|- stay read-only/);
      assert.match(continuedPrompt, /### ACCEPTANCE CRITERIA/);
      assert.match(continuedPrompt, /- return a concise result/);
      const result = JSON.parse(continued.stdout);
      assert.equal(result.iteration, 2);
    } finally { await f.cleanup(); }
  });

  test("rejects a missing session and an exhausted iteration limit", async () => {
    const f = await fixture();
    try {
      const missing = await runCli(f.dir, f.env, ["--continue", "MISSING"], JSON.stringify({
        schema_version: "1.0", task_id: "MISSING", action: "continue", feedback: "x"
      }));
      assert.equal(missing.code, 2);
      assert.equal(JSON.parse(missing.stdout).error.code, "SESSION_NOT_FOUND");

      const task = { schema_version: "1.0", task_id: "ONE", prompt: "x", cwd: f.dir, iteration: { max_iterations: 1 } };
      assert.equal((await runCli(f.dir, f.env, [], JSON.stringify(task))).code, 0);
      const exhausted = await runCli(f.dir, f.env, ["--continue", "ONE"], JSON.stringify({
        schema_version: "1.0", task_id: "ONE", action: "continue", feedback: "x"
      }));
      assert.equal(JSON.parse(exhausted.stdout).error.code, "MAX_ITERATIONS_EXCEEDED");
    } finally { await f.cleanup(); }
  });

  test("keeps interleaved tasks bound to their own sessions", async () => {
    const f = await fixture();
    try {
      for (const taskId of ["INTERLEAVE-A", "INTERLEAVE-B"]) {
        const started = await runCli(f.dir, f.env, [], JSON.stringify({
          schema_version: "1.0", task_id: taskId, prompt: taskId, cwd: f.dir,
          iteration: { max_iterations: 2 }
        }));
        assert.equal(started.code, 0, started.stderr);
      }
      const continued = await runCli(f.dir, f.env, ["--continue", "INTERLEAVE-A"], JSON.stringify({
        schema_version: "1.0", task_id: "INTERLEAVE-A", action: "continue", feedback: "fix A"
      }));
      assert.equal(continued.code, 0, continued.stderr);
      const args = (await readFile(f.argsLog, "utf8")).trim().split("\n").map(JSON.parse);
      const idA = args[0][args[0].indexOf("--session-id") + 1];
      const idB = args[1][args[1].indexOf("--session-id") + 1];
      const resumed = args[2][args[2].indexOf("--session") + 1];
      assert.notEqual(idA, idB);
      assert.equal(resumed, idA);
    } finally { await f.cleanup(); }
  });

  test("uses the persisted Pi session directory instead of recomputing it", async () => {
    const f = await fixture();
    try {
      const started = await runCli(f.dir, f.env, [], JSON.stringify({
        schema_version: "1.0", task_id: "DIR-1", prompt: "x", cwd: f.dir, iteration: { max_iterations: 2 }
      }));
      assert.equal(started.code, 0, started.stderr);
      const metadataPath = join(f.dir, ".subagent-exec", "metadata", "DIR-1.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      metadata.worker_session_dir = join(f.dir, "persisted-pi-dir");
      await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
      const continued = await runCli(f.dir, f.env, ["--continue", "DIR-1"], JSON.stringify({
        schema_version: "1.0", task_id: "DIR-1", action: "continue", feedback: "x"
      }));
      assert.equal(continued.code, 0, continued.stderr);
      const args = (await readFile(f.argsLog, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(args[1][args[1].indexOf("--session-dir") + 1], metadata.worker_session_dir);
    } finally { await f.cleanup(); }
  });

  test("maps verification failure, timeout, and cancellation", async () => {
    const failing = await fixture();
    try {
      const failed = await runCli(failing.dir, failing.env, [], JSON.stringify({
        schema_version: "1.0", task_id: "VERIFY", prompt: "x", cwd: failing.dir,
        verification: { commands: ["node -e \"process.exit(7)\""] }
      }));
      assert.equal(JSON.parse(failed.stdout).error.code, "VERIFICATION_FAILED");
    } finally { await failing.cleanup(); }

    const hanging = await fixture("hang");
    try {
      const timed = await runCli(hanging.dir, hanging.env, [], JSON.stringify({
        schema_version: "1.0", task_id: "TIME", prompt: "x", cwd: hanging.dir, timeout_ms: 1000
      }));
      assert.equal(timed.code, 124);
      assert.equal(JSON.parse(timed.stdout).status, "timeout");
      const timedMetadata = JSON.parse(await readFile(join(hanging.dir, ".subagent-exec", "metadata", "TIME.json"), "utf8"));
      assert.equal(timedMetadata.iteration, 1);
      assert.equal(timedMetadata.last_result.status, "timeout");

      const child = spawn(process.execPath, [cli], { cwd: hanging.dir, env: hanging.env, stdio: "pipe" });
      let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stdin.end(JSON.stringify({ schema_version: "1.0", task_id: "CANCEL", prompt: "x", cwd: hanging.dir, timeout_ms: 5000 }));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
      child.kill("SIGTERM");
      const code = await new Promise<number | null>((resolvePromise) => child.on("exit", resolvePromise));
      assert.equal(code, 130);
      assert.equal(JSON.parse(stdout).status, "cancelled");
      const cancelledMetadata = JSON.parse(await readFile(join(hanging.dir, ".subagent-exec", "metadata", "CANCEL.json"), "utf8"));
      assert.equal(cancelledMetadata.iteration, 1);
      assert.equal(cancelledMetadata.last_result.status, "cancelled");
    } finally { await hanging.cleanup(); }
  });

  test("applies timeout and inherited verification failure on continuation", async () => {
    const f = await fixture();
    try {
      const marker = join(f.dir, "verify-count");
      const command = `test ! -e '${marker}' && touch '${marker}'`;
      const first = await runCli(f.dir, f.env, [], JSON.stringify({
        schema_version: "1.0", task_id: "CONT-FAIL", prompt: "x", cwd: f.dir,
        iteration: { max_iterations: 2 }, verification: { commands: [command] }
      }));
      assert.equal(first.code, 0, first.stderr);
      const failed = await runCli(f.dir, f.env, ["--continue", "CONT-FAIL"], JSON.stringify({
        schema_version: "1.0", task_id: "CONT-FAIL", action: "continue", feedback: "x"
      }));
      assert.equal(JSON.parse(failed.stdout).error.code, "VERIFICATION_FAILED");

      const startTimeout = await runCli(f.dir, f.env, [], JSON.stringify({
        schema_version: "1.0", task_id: "CONT-TIME", prompt: "x", cwd: f.dir,
        iteration: { max_iterations: 2 }, timeout_ms: 1000
      }));
      assert.equal(startTimeout.code, 0, startTimeout.stderr);
      const timed = await runCli(f.dir, { ...f.env, PI_MODE: "hang" }, ["--continue", "CONT-TIME"], JSON.stringify({
        schema_version: "1.0", task_id: "CONT-TIME", action: "continue", feedback: "x", timeout_ms: 1000
      }));
      assert.equal(timed.code, 124);
      assert.equal(JSON.parse(timed.stdout).status, "timeout");
    } finally { await f.cleanup(); }
  });

  test("turns session persistence failure into a structured failure", async () => {
    const f = await fixture();
    try {
      const blockedPath = join(f.dir, "not-a-directory");
      await writeFile(blockedPath, "file", "utf8");
      const result = await runCli(f.dir, { ...f.env, SUBAGENT_EXEC_SESSION_DIR: blockedPath }, [], JSON.stringify({
        schema_version: "1.0", task_id: "PERSIST-FAIL", prompt: "x", cwd: f.dir
      }));
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.status, "failed");
      assert.equal(parsed.error.code, "SESSION_PERSISTENCE_FAILED");
    } finally { await f.cleanup(); }
  });

  test("runs inherited verification even when continuation violates scope", async () => {
    const f = await fixture();
    try {
      const verificationLog = `${f.dir}.scope-verified`;
      const first = await runCli(f.dir, f.env, [], JSON.stringify({
        schema_version: "1.0", task_id: "SCOPE-CONT", prompt: "x", cwd: f.dir,
        scope: "read_only", iteration: { max_iterations: 2 },
        verification: { commands: [`touch '${verificationLog}'`] }
      }));
      assert.equal(first.code, 0, first.stderr);
      await rm(verificationLog, { force: true });
      const changed = join(f.dir, "worker-change.txt");
      const continued = await runCli(f.dir, { ...f.env, PI_TOUCH: changed }, ["--continue", "SCOPE-CONT"], JSON.stringify({
        schema_version: "1.0", task_id: "SCOPE-CONT", action: "continue", feedback: "x"
      }));
      const result = JSON.parse(continued.stdout);
      assert.equal(result.error.code, "READ_ONLY_SCOPE_VIOLATION");
      assert.equal(result.verification.status, "passed");
      assert.equal(await readFile(verificationLog, "utf8"), "");
      await rm(verificationLog, { force: true });
    } finally { await f.cleanup(); }
  });
});
