import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { describe, test } from "node:test";

const cli = resolve(process.cwd(), "dist/cli.js");

async function fixture(mode = "success") {
  const fixtureRoot = join(process.cwd(), ".test-fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  const dir = await mkdtemp(join(fixtureRoot, "subagent-cli-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
  const logRoot = join(dir, ".subagent-exec", "pi-sessions");
  await mkdir(logRoot, { recursive: true });
  const argsLog = join(logRoot, "test-args.log");
  const promptsLog = join(logRoot, "test-prompts.log");
  const outsideArgsLog = `${dir}.args.log`;
  const outsidePromptsLog = `${dir}.prompts.log`;
  await writeFile(argsLog, "");
  await writeFile(promptsLog, "");
  await writeFile(outsideArgsLog, "");
  await writeFile(outsidePromptsLog, "");
  const bin = join(dir, "bin");
  await mkdir(bin);
  const pi = join(bin, "pi");
  await writeFile(pi, `#!/usr/bin/env node
const fs = require("node:fs");
const contained = process.cwd().includes("subagent-candidate-");
const argsLog = contained ? process.env.PI_CONTAINED_ARGS_LOG : process.env.PI_ARGS_LOG;
const promptsLog = contained ? process.env.PI_CONTAINED_PROMPTS_LOG : process.env.PI_PROMPTS_LOG;
fs.appendFileSync(argsLog, JSON.stringify(process.argv.slice(2)) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes("\\n")) {
    const i = buffer.indexOf("\\n");
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      const answer = process.env.PI_MESSAGE || "done";
      fs.appendFileSync(promptsLog, command.message + "\\n---PROMPT---\\n");
      if (process.env.PI_TOUCH) fs.writeFileSync(require("node:path").basename(process.env.PI_TOUCH), "one\\ntwo\\n");
      if (process.env.PI_TOUCH_SECOND) fs.writeFileSync(require("node:path").basename(process.env.PI_TOUCH_SECOND), "three\\n");
      if (process.env.PI_ESCAPE) fs.writeFileSync(process.env.PI_ESCAPE, "escaped");
      if (process.env.PI_SYMLINK_ESCAPE) {
        fs.symlinkSync(process.env.PI_SYMLINK_ESCAPE, "worker-escape-link");
        fs.writeFileSync("worker-escape-link", "escaped");
      }
      if (process.env.PI_MUTATION_MODE === "binary") fs.writeFileSync("binary.bin", Buffer.from([0,1,2,255]));
      if (process.env.PI_MUTATION_MODE === "mixed") {
        fs.writeFileSync("binary.bin", Buffer.from([0,1,2,255]));
        fs.writeFileSync("large.txt", "one\\ntwo\\nthree\\nfour\\n");
      }
      if (process.env.PI_MUTATION_MODE === "delete") fs.unlinkSync("tracked.txt");
      if (process.env.PI_MUTATION_MODE === "rename") fs.renameSync("tracked.txt", "renamed.txt");
      if (process.env.PI_MUTATION_MODE === "escape-symlink") fs.symlinkSync(process.env.PI_SYMLINK_TARGET, "escape-link");
      process.stdout.write(JSON.stringify({type:"response",id:command.id,success:true})+"\\n");
      if (process.env.PI_EXIT_EARLY) process.exit(7);
      if ((process.env.PI_MODE || ${JSON.stringify(mode)}) !== "hang") {
        process.stdout.write(JSON.stringify({type:"agent_start"})+"\\n");
        process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:answer}})+"\\n");
        process.stdout.write(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:answer}]})+"\\n");
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
    env: { ...process.env, PI_ARGS_LOG: outsideArgsLog, PI_PROMPTS_LOG: outsidePromptsLog,
      PI_CONTAINED_ARGS_LOG: argsLog, PI_CONTAINED_PROMPTS_LOG: promptsLog, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(argsLog, { force: true });
      await rm(promptsLog, { force: true });
      await rm(outsideArgsLog, { force: true });
      await rm(outsidePromptsLog, { force: true });
    }
  };
}

function runCli(cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: string) {
  if (input !== undefined) {
    const parsed = JSON.parse(input);
    if (parsed.action !== "continue" && !parsed.execution_policy) {
      if (parsed.scope === "read_only") {
        parsed.iteration = { max_iterations: 1 };
        parsed.execution_policy = { mode: "investigation", risk: "high", on_failure: "return_to_coordinator" };
      } else {
        const checkpoint = parsed.iteration?.max_iterations === 2;
        parsed.scope = "read_write";
        parsed.allowed_paths ??= ["*.txt"];
        parsed.acceptance_criteria ??= ["Complete the requested task"];
        parsed.verification ??= { commands: ["true"] };
        parsed.iteration ??= { max_iterations: checkpoint ? 2 : 1 };
        parsed.execution_policy = {
          mode: checkpoint ? "checkpoint" : "fast",
          risk: checkpoint ? "medium" : "low",
          max_changed_files: 20,
          max_diff_lines: 2000,
          on_failure: "return_to_coordinator"
        };
      }
      input = JSON.stringify(parsed);
    }
  }
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
  test("rejects inadmissible delegation before spawning Pi", async () => {
    const f = await fixture();
    try {
      const result = await runCli(f.dir, f.env, [], JSON.stringify({
        schema_version: "1.0", task_id: "REJECT", prompt: "x", cwd: f.dir,
        acceptance_criteria: ["must remain visible"],
        execution_policy: { mode: "fast", risk: "high", on_failure: "return_to_coordinator" }
      }));
      assert.equal(result.code, 2);
      const rejected = JSON.parse(result.stdout);
      assert.equal(rejected.error.code, "DELEGATION_NOT_RECOMMENDED");
      assert.equal(rejected.acceptance_evidence.criteria[0].criterion, "must remain visible");
      assert.ok(rejected.acceptance_evidence.recommended_next_action);
      assert.equal(await readFile(f.argsLog, "utf8"), "");
    } finally { await f.cleanup(); }
  });

  test("fails closed before spawning when lease infrastructure is unavailable", async () => {
    const f = await fixture();
    try {
      const blocked = join(f.dir, "runtime-file");
      await writeFile(blocked, "not a directory", "utf8");
      const result = await runCli(f.dir, { ...f.env, SUBAGENT_EXEC_SESSION_DIR: blocked }, [], JSON.stringify({
        schema_version: "1.0", task_id: "LOCK-FAIL", prompt: "x", cwd: f.dir
      }));
      assert.equal(JSON.parse(result.stdout).error.code, "SESSION_LEASE_ERROR");
      assert.equal(await readFile(f.argsLog, "utf8"), "");
    } finally { await f.cleanup(); }
  });

  test("starts then resumes the exact same session and reruns verification", async () => {
    const f = await fixture();
    try {
      const verificationLog = join(f.dir, ".subagent-exec", "pi-sessions", "verified.log");
      await mkdir(join(f.dir, ".subagent-exec", "pi-sessions"), { recursive: true });
      const task = {
        schema_version: "1.0", task_id: "FLOW-1", prompt: "first", cwd: f.dir,
        scope: "read_write", constraints: ["stay read-only"],
        acceptance_criteria: ["return a concise result"], iteration: { max_iterations: 2 },
        verification: { commands: [`node -e "require('fs').appendFileSync('${verificationLog}','v')"`] }
      };
      const first = await runCli(f.dir, f.env, [], JSON.stringify(task));
      assert.equal(first.code, 0, first.stderr);
      const continued = await runCli(f.dir, f.env, ["--continue", "FLOW-1"], JSON.stringify({
        schema_version: "1.0", task_id: "FLOW-1", action: "continue", feedback: "review feedback"
      }));
      assert.equal(continued.code, 0, `${continued.stderr}\n${continued.stdout}`);
      assert.equal(await readFile(verificationLog, "utf8"), "v");
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
      assert.equal(JSON.parse(exhausted.stdout).error.code, "CIRCUIT_BREAKER_OPEN");
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
      await mkdir(metadata.worker_session_dir, { recursive: true });
      const continuedArgsLog = join(metadata.worker_session_dir, "args.log");
      const continuedPromptsLog = join(metadata.worker_session_dir, "prompts.log");
      await writeFile(continuedArgsLog, "");
      await writeFile(continuedPromptsLog, "");
      await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
      const continued = await runCli(f.dir, { ...f.env, PI_CONTAINED_ARGS_LOG: continuedArgsLog, PI_CONTAINED_PROMPTS_LOG: continuedPromptsLog }, ["--continue", "DIR-1"], JSON.stringify({
        schema_version: "1.0", task_id: "DIR-1", action: "continue", feedback: "x"
      }));
      assert.equal(continued.code, 0, continued.stderr);
      const args = JSON.parse((await readFile(continuedArgsLog, "utf8")).trim());
      assert.equal(args[args.indexOf("--session-dir") + 1], metadata.worker_session_dir);
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
      assert.equal(JSON.parse(timed.stdout).acceptance_evidence.criteria[0].status, "manual_review_required");
      assert.ok(JSON.parse(timed.stdout).acceptance_evidence.recommended_next_action);
      const timedMetadata = JSON.parse(await readFile(join(hanging.dir, ".subagent-exec", "archive", "TIME.json"), "utf8"));
      assert.equal(timedMetadata.iteration, 1);
      assert.equal(timedMetadata.last_result.status, "timeout");

      const child = spawn(process.execPath, [cli], { cwd: hanging.dir, env: hanging.env, stdio: "pipe" });
      let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stdin.end(JSON.stringify({
        schema_version: "1.0", task_id: "CANCEL", prompt: "x", cwd: hanging.dir, timeout_ms: 5000,
        scope: "read_write", allowed_paths: ["*.txt"], acceptance_criteria: ["done"],
        verification: { commands: ["false"] }, iteration: { max_iterations: 1 },
        execution_policy: { mode: "fast", risk: "low", max_changed_files: 10, max_diff_lines: 100, on_failure: "return_to_coordinator" }
      }));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
      child.kill("SIGTERM");
      const code = await new Promise<number | null>((resolvePromise) => child.on("exit", resolvePromise));
      assert.equal(code, 130);
      assert.equal(JSON.parse(stdout).status, "cancelled");
      assert.ok(JSON.parse(stdout).acceptance_evidence.recommended_next_action);
      const cancelledMetadata = JSON.parse(await readFile(join(hanging.dir, ".subagent-exec", "archive", "CANCEL.json"), "utf8"));
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
      await writeFile(marker, "1", "utf8");
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
      const blockedPath = join(f.dir, "blocked-runtime");
      await mkdir(blockedPath);
      await writeFile(join(blockedPath, "metadata"), "file", "utf8");
      const result = await runCli(f.dir, { ...f.env, SUBAGENT_EXEC_SESSION_DIR: blockedPath }, [], JSON.stringify({
        schema_version: "1.0", task_id: "PERSIST-FAIL", prompt: "x", cwd: f.dir
      }));
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.status, "failed");
      assert.equal(parsed.error.code, "SESSION_PERSISTENCE_FAILED");
      assert.ok(parsed.acceptance_evidence.recommended_next_action);
      assert.equal(parsed.continuation.allow_continuation, false);
      assert.equal(parsed.continuation.state, "coordinator_required");
      assert.equal(parsed.continuation.failure_class, "runtime:SESSION_PERSISTENCE_FAILED");
    } finally { await f.cleanup(); }
  });

  test("runs inherited verification even when continuation violates scope", async () => {
    const f = await fixture();
    try {
      const verificationLog = join(f.dir, ".subagent-exec", "pi-sessions", "scope-verified");
      await mkdir(join(f.dir, ".subagent-exec", "pi-sessions"), { recursive: true });
      const first = await runCli(f.dir, f.env, [], JSON.stringify({
        schema_version: "1.0", task_id: "SCOPE-CONT", prompt: "x", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], iteration: { max_iterations: 2 },
        acceptance_criteria: ["Complete safely"],
        verification: { commands: [`touch '${verificationLog}'`] },
        execution_policy: { mode: "checkpoint", risk: "medium", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      }));
      assert.equal(first.code, 0, first.stderr);
      await rm(verificationLog, { force: true });
      const changed = join(f.dir, "worker-change.txt");
      const continued = await runCli(f.dir, { ...f.env, PI_TOUCH: changed }, ["--continue", "SCOPE-CONT"], JSON.stringify({
        schema_version: "1.0", task_id: "SCOPE-CONT", action: "continue", feedback: "x"
      }));
      const result = JSON.parse(continued.stdout);
      assert.equal(result.error.code, "MODIFICATION_SCOPE_VIOLATION");
      assert.equal(result.verification.status, "passed");
      assert.equal(await readFile(verificationLog, "utf8"), "");
      await rm(verificationLog, { force: true });
    } finally { await f.cleanup(); }
  });

  test("enforces checkpoint planning and implementation change budgets", async () => {
    const f = await fixture();
    try {
      const policy = { mode: "checkpoint", risk: "medium", max_changed_files: 2, max_diff_lines: 1, on_failure: "return_to_coordinator" };
      const task = {
        schema_version: "1.0", task_id: "BUDGET", prompt: "plan and implement", cwd: f.dir,
        scope: "read_write", allowed_paths: ["budget-change.txt"], acceptance_criteria: ["done"],
        verification: { commands: ["true"] }, iteration: { max_iterations: 2 }, execution_policy: policy
      };
      const planned = await runCli(f.dir, f.env, [], JSON.stringify(task));
      const planResult = JSON.parse(planned.stdout);
      assert.equal(planResult.status, "needs_continuation");
      assert.equal(planResult.scope.scope_mode, "read_only");
      assert.equal(planResult.verification.status, "not_run");

      const changed = join(f.dir, "budget-change.txt");
      const implemented = await runCli(f.dir, { ...f.env, PI_TOUCH: changed }, ["--continue", "BUDGET"], JSON.stringify({
        schema_version: "1.0", task_id: "BUDGET", action: "continue", feedback: "plan approved"
      }));
      const result = JSON.parse(implemented.stdout);
      assert.equal(result.error.code, "CHANGE_BUDGET_EXCEEDED");
      assert.ok(result.error.details.diff_lines > 1);
    } finally { await f.cleanup(); }
  });

  test("does not continue a failed checkpoint planning round", async () => {
    const f = await fixture();
    try {
      const task = {
        schema_version: "1.0", task_id: "FAILED-PLAN", prompt: "plan", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["approved plan"],
        verification: { commands: ["true"] }, iteration: { max_iterations: 2 },
        execution_policy: { mode: "checkpoint", risk: "medium", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      };
      const failed = await runCli(f.dir, { ...f.env, PI_TOUCH: join(f.dir, "tracked.txt") }, [], JSON.stringify(task));
      assert.equal(JSON.parse(failed.stdout).error.code, "READ_ONLY_SCOPE_VIOLATION");
      const continued = await runCli(f.dir, f.env, ["--continue", "FAILED-PLAN"], JSON.stringify({
        schema_version: "1.0", task_id: "FAILED-PLAN", action: "continue", feedback: "continue anyway"
      }));
      assert.equal(continued.code, 1);
      assert.equal(JSON.parse(continued.stdout).error.code, "CIRCUIT_BREAKER_OPEN");
    } finally { await f.cleanup(); }
  });

  test("maps an unexpected child exit to failed exit code 1", async () => {
    const f = await fixture();
    try {
      const failed = await runCli(f.dir, { ...f.env, PI_EXIT_EARLY: "1" }, [], JSON.stringify({
        schema_version: "1.0", task_id: "CHILD-EXIT", prompt: "x", cwd: f.dir
      }));
      assert.equal(failed.code, 1);
      assert.equal(JSON.parse(failed.stdout).status, "failed");
    } finally { await f.cleanup(); }
  });

  test("enforces max_changed_files", async () => {
    const f = await fixture();
    try {
      const failed = await runCli(f.dir, {
        ...f.env,
        PI_TOUCH: join(f.dir, "one.txt"),
        PI_TOUCH_SECOND: join(f.dir, "two.txt")
      }, [], JSON.stringify({
        schema_version: "1.0", task_id: "FILE-BUDGET", prompt: "edit bounded files", cwd: f.dir,
        scope: "read_write", allowed_paths: ["*.txt"], acceptance_criteria: ["done"],
        verification: { commands: ["true"] }, iteration: { max_iterations: 1 },
        execution_policy: { mode: "fast", risk: "low", max_changed_files: 1, max_diff_lines: 100, on_failure: "return_to_coordinator" }
      }));
      assert.equal(JSON.parse(failed.stdout).error.code, "CHANGE_BUDGET_EXCEEDED");
    } finally { await f.cleanup(); }
  });

  test("keeps investigation mode single-round and read-only", async () => {
    const f = await fixture();
    try {
      const failed = await runCli(f.dir, { ...f.env, PI_TOUCH: join(f.dir, "evidence.txt") }, [], JSON.stringify({
        schema_version: "1.0", task_id: "INVESTIGATE", prompt: "inspect only", cwd: f.dir,
        scope: "read_only", iteration: { max_iterations: 1 },
        execution_policy: { mode: "investigation", risk: "high", on_failure: "return_to_coordinator" }
      }));
      assert.equal(failed.code, 1);
      assert.equal(JSON.parse(failed.stdout).error.code, "READ_ONLY_SCOPE_VIOLATION");
    } finally { await f.cleanup(); }
  });

  test("emits normalized structured acceptance evidence", async () => {
    const f = await fixture();
    try {
      const message = `done\n\`\`\`subagent-evidence\n${JSON.stringify({
        assumptions: ["clean fixture"], decisions: ["minimal change"],
        criteria: [{ criterion: "tests pass", status: "passed", evidence: [{ type: "command", reference: "true" }] }],
        changed_symbols: ["fixture"], tests_added: ["integration"], known_risks: [], unresolved_items: [],
        review_locations: ["tracked.txt:1"], recommended_next_action: "accept"
      })}\n\`\`\``;
      const completed = await runCli(f.dir, { ...f.env, PI_MESSAGE: message }, [], JSON.stringify({
        schema_version: "1.0", task_id: "EVIDENCE", prompt: "report", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["tests pass"],
        verification: { commands: ["true"] }, iteration: { max_iterations: 1 },
        execution_policy: { mode: "fast", risk: "low", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      }));
      const evidence = JSON.parse(completed.stdout).acceptance_evidence;
      assert.equal(evidence.criteria[0].status, "passed");
      assert.equal(evidence.review_locations[0], "tracked.txt:1");
    } finally { await f.cleanup(); }
  });

  test("opens the cost circuit at the configured direct-execution fraction", async () => {
    const f = await fixture();
    try {
      const completed = await runCli(f.dir, f.env, [], JSON.stringify({
        schema_version: "1.0", task_id: "COST", prompt: "small edit", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["done"],
        verification: { commands: ["false"] }, iteration: { max_iterations: 1 },
        execution_policy: { mode: "fast", risk: "low", max_changed_files: 1, max_diff_lines: 10,
          estimated_direct_cost_usd: 0.01, max_cost_ratio: 0.5, on_failure: "return_to_coordinator" }
      }));
      const result = JSON.parse(completed.stdout);
      assert.equal(result.error.code, "WORKER_COST_BUDGET_EXCEEDED");
      assert.equal(result.continuation.reason, "budget_exceeded");
    } finally { await f.cleanup(); }
  });

  test("preserves budget_exceeded when cost opens during checkpoint planning", async () => {
    const f = await fixture();
    try {
      const result = JSON.parse((await runCli(f.dir, f.env, [], JSON.stringify({
        schema_version: "1.0", task_id: "PLAN-COST", prompt: "plan", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["plan"],
        verification: { commands: ["true"] }, iteration: { max_iterations: 2 },
        execution_policy: { mode: "checkpoint", risk: "medium", max_changed_files: 1, max_diff_lines: 10,
          estimated_direct_cost_usd: 0.01, max_cost_ratio: 0.5, on_failure: "return_to_coordinator" }
      }))).stdout);
      assert.equal(result.error.code, "WORKER_COST_BUDGET_EXCEEDED");
      assert.equal(result.continuation.reason, "budget_exceeded");
      assert.equal(result.continuation.failure_class, "budget_exceeded");
    } finally { await f.cleanup(); }
  });

  test("allows one checkpoint repair then opens on unchanged repeated failure", async () => {
    const f = await fixture();
    try {
      const task = {
        schema_version: "1.0", task_id: "REPAIR", prompt: "plan then implement", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["verification passes"],
        verification: { commands: ["false"] }, iteration: { max_iterations: 3 },
        execution_policy: { mode: "checkpoint", risk: "medium", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      };
      assert.equal(JSON.parse((await runCli(f.dir, f.env, [], JSON.stringify(task))).stdout).status, "needs_continuation");
      const implementation = await runCli(f.dir, f.env, ["--continue", "REPAIR"], JSON.stringify({ schema_version: "1.0", task_id: "REPAIR", action: "continue", feedback: "implement" }));
      assert.equal(JSON.parse(implementation.stdout).continuation.allow_continuation, true);
      const repair = await runCli(f.dir, f.env, ["--continue", "REPAIR"], JSON.stringify({ schema_version: "1.0", task_id: "REPAIR", action: "continue", feedback: "repair" }));
      const result = JSON.parse(repair.stdout);
      assert.equal(result.continuation.allow_continuation, false);
      assert.equal(result.continuation.reason, "no_new_diagnostics");
      const blocked = await runCli(f.dir, f.env, ["--continue", "REPAIR"], JSON.stringify({ schema_version: "1.0", task_id: "REPAIR", action: "continue", feedback: "again" }));
      assert.equal(JSON.parse(blocked.stdout).error.code, "CIRCUIT_BREAKER_OPEN");
    } finally { await f.cleanup(); }
  });

  test("archives an exhausted two-round checkpoint without offering repair", async () => {
    const f = await fixture();
    try {
      const task = {
        schema_version: "1.0", task_id: "NO-REPAIR", prompt: "plan", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["pass"],
        verification: { commands: ["false"] }, iteration: { max_iterations: 2 },
        execution_policy: { mode: "checkpoint", risk: "medium", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      };
      await runCli(f.dir, f.env, [], JSON.stringify(task));
      const failed = JSON.parse((await runCli(f.dir, f.env, ["--continue", "NO-REPAIR"], JSON.stringify({ schema_version: "1.0", task_id: "NO-REPAIR", action: "continue", feedback: "implement" }))).stdout);
      assert.equal(failed.continuation.reason, "iteration_limit");
      assert.equal(failed.candidate.status, "discarded");
      await assert.rejects(() => readFile(join(f.dir, ".subagent-exec", "metadata", "NO-REPAIR.json"), "utf8"));
      assert.ok(await readFile(join(f.dir, ".subagent-exec", "archive", "NO-REPAIR.json"), "utf8"));
    } finally { await f.cleanup(); }
  });

  test("retains an isolated candidate for one repair and exports it on success", async () => {
    const f = await fixture();
    try {
      const marker = join(f.dir, ".subagent-exec", "pi-sessions", "repair-marker");
      await mkdir(join(f.dir, ".subagent-exec", "pi-sessions"), { recursive: true });
      const command = `node -e "const fs=require('fs'); if(fs.existsSync('${marker}')) process.exit(0); fs.writeFileSync('${marker}','1'); process.exit(1)"`;
      const evidence = `\`\`\`subagent-evidence\n${JSON.stringify({ criteria: [{ criterion: "passes", status: "passed", evidence: [{ type: "command", reference: command }] }] })}\n\`\`\``;
      const task = { schema_version: "1.0", task_id: "CANDIDATE-REPAIR", prompt: "plan", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["passes"], verification: { commands: [command] },
        iteration: { max_iterations: 3 }, execution_policy: { mode: "checkpoint", risk: "medium", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" } };
      await runCli(f.dir, f.env, [], JSON.stringify(task));
      const first = JSON.parse((await runCli(f.dir, { ...f.env, PI_TOUCH: "tracked.txt", PI_MESSAGE: evidence }, ["--continue", "CANDIDATE-REPAIR"], JSON.stringify({ schema_version: "1.0", task_id: "CANDIDATE-REPAIR", action: "continue", feedback: "implement" }))).stdout);
      assert.equal(first.candidate.status, "pending");
      const repaired = JSON.parse((await runCli(f.dir, { ...f.env, PI_TOUCH: "tracked.txt", PI_MESSAGE: evidence }, ["--continue", "CANDIDATE-REPAIR"], JSON.stringify({ schema_version: "1.0", task_id: "CANDIDATE-REPAIR", action: "continue", feedback: "repair" }))).stdout);
      assert.equal(repaired.status, "success");
      assert.equal(repaired.candidate.status, "ready");
      assert.equal(await readFile(join(f.dir, "tracked.txt"), "utf8"), "base");
    } finally { await f.cleanup(); }
  });

  test("rejects concurrent continuations with a task lease", async () => {
    const f = await fixture();
    try {
      const task = { schema_version: "1.0", task_id: "LEASE", prompt: "plan", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["done"], verification: { commands: ["true"] },
        iteration: { max_iterations: 2 }, execution_policy: { mode: "checkpoint", risk: "medium", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" } };
      await runCli(f.dir, f.env, [], JSON.stringify(task));
      const first = runCli(f.dir, { ...f.env, PI_MODE: "hang" }, ["--continue", "LEASE"], JSON.stringify({ schema_version: "1.0", task_id: "LEASE", action: "continue", feedback: "one", timeout_ms: 1000 }));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      const second = await runCli(f.dir, f.env, ["--continue", "LEASE"], JSON.stringify({ schema_version: "1.0", task_id: "LEASE", action: "continue", feedback: "two" }));
      assert.equal(JSON.parse(second.stdout).error.code, "SESSION_BUSY");
      await first;
    } finally { await f.cleanup(); }
  });

  test("reloads metadata under the lease instead of executing a stale iteration", async () => {
    const f = await fixture();
    try {
      const task = { schema_version: "1.0", task_id: "STALE", prompt: "plan", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["done"], verification: { commands: ["true"] },
        iteration: { max_iterations: 2 }, execution_policy: { mode: "checkpoint", risk: "medium", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" } };
      await runCli(f.dir, f.env, [], JSON.stringify(task));
      const delayed = runCli(f.dir, { ...f.env, SUBAGENT_EXEC_TEST_PRE_LEASE_DELAY_MS: "500" }, ["--continue", "STALE"], JSON.stringify({ schema_version: "1.0", task_id: "STALE", action: "continue", feedback: "stale" }));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      const winner = await runCli(f.dir, f.env, ["--continue", "STALE"], JSON.stringify({ schema_version: "1.0", task_id: "STALE", action: "continue", feedback: "winner" }));
      assert.equal(JSON.parse(winner.stdout).status, "success");
      const stale = await delayed;
      assert.equal(JSON.parse(stale.stdout).error.code, "CIRCUIT_BREAKER_OPEN");
      const prompts = await readFile(f.promptsLog, "utf8");
      assert.equal((prompts.match(/---PROMPT---/g) ?? []).length, 2);
    } finally { await f.cleanup(); }
  });

  test("turns structured architecture handoff into coordinator-required failure", async () => {
    const f = await fixture();
    try {
      const message = `\`\`\`subagent-evidence\n${JSON.stringify({ criteria: [], handoff: { type: "architecture", reason: "choose a storage boundary" } })}\n\`\`\``;
      const result = JSON.parse((await runCli(f.dir, { ...f.env, PI_MESSAGE: message }, [], JSON.stringify({
        schema_version: "1.0", task_id: "HANDOFF", prompt: "investigate", cwd: f.dir,
        scope: "read_only", iteration: { max_iterations: 1 }, execution_policy: { mode: "investigation", risk: "high", on_failure: "return_to_coordinator" }
      }))).stdout);
      assert.equal(result.error.code, "ARCHITECTURE_DECISION_REQUIRED");
      assert.equal(result.continuation.state, "coordinator_required");
    } finally { await f.cleanup(); }
  });

  test("keeps candidate changes isolated until explicit acceptance", async () => {
    const f = await fixture();
    try {
      const evidence = `\`\`\`subagent-evidence\n${JSON.stringify({ criteria: [{ criterion: "changed", status: "passed", evidence: [{ type: "command", reference: "true" }] }] })}\n\`\`\``;
      const result = JSON.parse((await runCli(f.dir, { ...f.env, PI_TOUCH: "tracked.txt", PI_MESSAGE: evidence }, [], JSON.stringify({
        schema_version: "1.0", task_id: "ISOLATED", prompt: "edit", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["changed"],
        verification: { commands: ["true"] }, iteration: { max_iterations: 1 },
        execution_policy: { mode: "fast", risk: "low", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      }))).stdout);
      assert.equal(result.status, "success");
      assert.equal(result.candidate.status, "ready");
      assert.equal(await readFile(join(f.dir, "tracked.txt"), "utf8"), "base");
      const accepted = await runCli(f.dir, f.env, ["--accept-candidate", "ISOLATED"]);
      assert.equal(JSON.parse(accepted.stdout).status, "accepted");
      assert.equal(await readFile(join(f.dir, "tracked.txt"), "utf8"), "one\ntwo\n");
      const duplicate = await runCli(f.dir, f.env, ["--accept-candidate", "ISOLATED"]);
      assert.equal(JSON.parse(duplicate.stdout).error.code, "CANDIDATE_APPLY_FAILED");
    } finally { await f.cleanup(); }
  });

  test("discards a rejected candidate without changing the main workspace", async () => {
    const f = await fixture();
    try {
      const result = JSON.parse((await runCli(f.dir, { ...f.env, PI_TOUCH: "outside.txt" }, [], JSON.stringify({
        schema_version: "1.0", task_id: "DISCARD", prompt: "edit", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["changed"],
        verification: { commands: ["true"] }, iteration: { max_iterations: 1 },
        execution_policy: { mode: "fast", risk: "low", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      }))).stdout);
      assert.equal(result.candidate.status, "discarded");
      await assert.rejects(() => readFile(join(f.dir, "outside.txt"), "utf8"));
    } finally { await f.cleanup(); }
  });

  test("coordinator explicitly rejects a ready candidate", async () => {
    const f = await fixture();
    try {
      const evidence = `\`\`\`subagent-evidence\n${JSON.stringify({ criteria: [{ criterion: "changed", status: "passed", evidence: [{ type: "command", reference: "true" }] }] })}\n\`\`\``;
      await runCli(f.dir, { ...f.env, PI_TOUCH: "tracked.txt", PI_MESSAGE: evidence }, [], JSON.stringify({
        schema_version: "1.0", task_id: "REJECT-CANDIDATE", prompt: "edit", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["changed"],
        verification: { commands: ["true"] }, iteration: { max_iterations: 1 },
        execution_policy: { mode: "fast", risk: "low", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      }));
      const rejected = await runCli(f.dir, f.env, ["--reject-candidate", "REJECT-CANDIDATE"]);
      assert.equal(JSON.parse(rejected.stdout).status, "rejected");
      assert.equal(await readFile(join(f.dir, "tracked.txt"), "utf8"), "base");
    } finally { await f.cleanup(); }
  });

  test("verification side effects are included in final scope validation", async () => {
    const f = await fixture();
    try {
      const result = JSON.parse((await runCli(f.dir, { ...f.env, PI_TOUCH: "tracked.txt" }, [], JSON.stringify({
        schema_version: "1.0", task_id: "VERIFY-SCOPE", prompt: "edit", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["changed"],
        verification: { commands: ["node -e \"require('fs').writeFileSync('outside.txt','bad')\""] }, iteration: { max_iterations: 1 },
        execution_policy: { mode: "fast", risk: "low", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      }))).stdout);
      assert.equal(result.error.code, "MODIFICATION_SCOPE_VIOLATION");
      assert.equal(result.candidate.status, "discarded");
      await assert.rejects(() => readFile(join(f.dir, "outside.txt"), "utf8"));
    } finally { await f.cleanup(); }
  });

  test("OS containment blocks planning, absolute-path, and symlink escapes", async () => {
    for (const attack of ["planning", "absolute", "symlink"] as const) {
      const f = await fixture();
      try {
        const escaped = join(f.dir, `${attack}-escaped.txt`);
        const checkpoint = attack === "planning";
        const env = attack === "symlink" ? { ...f.env, PI_SYMLINK_ESCAPE: escaped } : { ...f.env, PI_ESCAPE: escaped };
        const task = { schema_version: "1.0", task_id: `ESCAPE-${attack}`, prompt: "attempt", cwd: f.dir,
          scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["safe"], verification: { commands: ["true"] },
          iteration: { max_iterations: checkpoint ? 2 : 1 }, execution_policy: { mode: checkpoint ? "checkpoint" : "fast", risk: checkpoint ? "medium" : "low", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" } };
        const result = JSON.parse((await runCli(f.dir, env, [], JSON.stringify(task))).stdout);
        assert.equal(result.status, "failed");
        await assert.rejects(() => readFile(escaped, "utf8"));
      } finally { await f.cleanup(); }
    }
  });

  test("exports and accepts binary, deletion, and rename candidates", async () => {
    for (const mode of ["binary", "delete", "rename"] as const) {
      const f = await fixture();
      try {
        const evidence = `\`\`\`subagent-evidence\n${JSON.stringify({ criteria: [{ criterion: "mutation", status: "passed", evidence: [{ type: "command", reference: "true" }] }] })}\n\`\`\``;
        const allowed = mode === "binary" ? ["binary.bin"] : mode === "rename" ? ["tracked.txt", "renamed.txt"] : ["tracked.txt"];
        const taskId = `PATCH-${mode}`;
        const result = JSON.parse((await runCli(f.dir, { ...f.env, PI_MUTATION_MODE: mode, PI_MESSAGE: evidence }, [], JSON.stringify({
          schema_version: "1.0", task_id: taskId, prompt: "mutate", cwd: f.dir,
          scope: "read_write", allowed_paths: allowed, acceptance_criteria: ["mutation"], verification: { commands: ["true"] },
          iteration: { max_iterations: 1 }, execution_policy: { mode: "fast", risk: "low", max_changed_files: 2, max_diff_lines: 20,
            allow_binary_changes: mode === "binary", on_failure: "return_to_coordinator" }
        }))).stdout);
        assert.equal(result.candidate.status, "ready", JSON.stringify(result));
        assert.equal(JSON.parse((await runCli(f.dir, f.env, ["--accept-candidate", taskId])).stdout).status, "accepted");
        if (mode === "binary") assert.deepEqual(await readFile(join(f.dir, "binary.bin")), Buffer.from([0,1,2,255]));
        if (mode === "delete") await assert.rejects(() => readFile(join(f.dir, "tracked.txt")));
        if (mode === "rename") assert.equal(await readFile(join(f.dir, "renamed.txt"), "utf8"), "base");
      } finally { await f.cleanup(); }
    }
  });

  test("rejects candidate artifacts containing an escaping symlink", async () => {
    const f = await fixture();
    try {
      const evidence = `\`\`\`subagent-evidence\n${JSON.stringify({ criteria: [{ criterion: "safe link", status: "passed", evidence: [{ type: "command", reference: "true" }] }] })}\n\`\`\``;
      const result = JSON.parse((await runCli(f.dir, { ...f.env, PI_MUTATION_MODE: "escape-symlink", PI_SYMLINK_TARGET: join(f.dir, "tracked.txt"), PI_MESSAGE: evidence }, [], JSON.stringify({
        schema_version: "1.0", task_id: "ESCAPING-LINK", prompt: "link", cwd: f.dir,
        scope: "read_write", allowed_paths: ["escape-link"], acceptance_criteria: ["safe link"], verification: { commands: ["true"] },
        iteration: { max_iterations: 1 }, execution_policy: { mode: "fast", risk: "low", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      }))).stdout);
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "CANDIDATE_EXPORT_FAILED");
      assert.equal(result.candidate.status, "discarded");
    } finally { await f.cleanup(); }
  });

  test("binary opt-in never bypasses the text line budget", async () => {
    const f = await fixture();
    try {
      const result = JSON.parse((await runCli(f.dir, { ...f.env, PI_MUTATION_MODE: "mixed" }, [], JSON.stringify({
        schema_version: "1.0", task_id: "MIXED-BUDGET", prompt: "mixed", cwd: f.dir,
        scope: "read_write", allowed_paths: ["binary.bin", "large.txt"], acceptance_criteria: ["bounded"], verification: { commands: ["true"] },
        iteration: { max_iterations: 1 }, execution_policy: { mode: "fast", risk: "low", max_changed_files: 2,
          max_diff_lines: 2, allow_binary_changes: true, on_failure: "return_to_coordinator" }
      }))).stdout);
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "CHANGE_BUDGET_EXCEEDED");
      assert.equal(result.error.details.has_binary, true);
      assert.equal(result.error.details.diff_lines, 4);
    } finally { await f.cleanup(); }
  });

  test("contains verification subprocess writes outside the candidate", async () => {
    const f = await fixture();
    try {
      const escaped = join(f.dir, "verification-escaped.txt");
      const script = `require("node:child_process").execFileSync(process.execPath,["-e",${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(escaped)},"escaped")`)}])`;
      const result = JSON.parse((await runCli(f.dir, { ...f.env, PI_TOUCH: "tracked.txt" }, [], JSON.stringify({
        schema_version: "1.0", task_id: "VERIFY-CONTAINMENT", prompt: "edit", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["safe"],
        verification: { commands: [`node -e ${JSON.stringify(script)}`] }, iteration: { max_iterations: 1 },
        execution_policy: { mode: "fast", risk: "low", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      }))).stdout);
      assert.equal(result.status, "failed");
      assert.equal(result.verification.status, "failed");
      await assert.rejects(() => readFile(escaped, "utf8"));
    } finally { await f.cleanup(); }
  });

  test("refuses conflicting and path-traversing candidate acceptance", async () => {
    const f = await fixture();
    try {
      const evidence = `\`\`\`subagent-evidence\n${JSON.stringify({ criteria: [{ criterion: "changed", status: "passed", evidence: [{ type: "command", reference: "true" }] }] })}\n\`\`\``;
      await runCli(f.dir, { ...f.env, PI_TOUCH: "tracked.txt", PI_MESSAGE: evidence }, [], JSON.stringify({
        schema_version: "1.0", task_id: "CONFLICT", prompt: "edit", cwd: f.dir,
        scope: "read_write", allowed_paths: ["tracked.txt"], acceptance_criteria: ["changed"],
        verification: { commands: ["true"] }, iteration: { max_iterations: 1 },
        execution_policy: { mode: "fast", risk: "low", max_changed_files: 1, max_diff_lines: 10, on_failure: "return_to_coordinator" }
      }));
      await writeFile(join(f.dir, "tracked.txt"), "user edit\n");
      const conflict = await runCli(f.dir, f.env, ["--accept-candidate", "CONFLICT"]);
      assert.equal(JSON.parse(conflict.stdout).error.code, "CANDIDATE_APPLY_FAILED");
      assert.equal(await readFile(join(f.dir, "tracked.txt"), "utf8"), "user edit\n");
      const traversal = await runCli(f.dir, f.env, ["--accept-candidate", "../escape"]);
      assert.equal(JSON.parse(traversal.stdout).error.code, "CANDIDATE_APPLY_FAILED");
    } finally { await f.cleanup(); }
  });
});
