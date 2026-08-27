import {
  spawn
} from "node:child_process";

import type {
  VerificationResult
} from "./types.js";

export async function runVerification(
  cwd: string,
  commands: string[],
  timeoutMs = 120_000,
  abortSignal?: AbortSignal
): Promise<VerificationResult> {

  if (commands.length === 0) {
    return {
      status: "not_run",
      commands: [],
      results: []
    };
  }

  /*
   * Pre-check: if already aborted before we start, fail fast.
   */
  if (abortSignal?.aborted) {
    return {
      status: "failed",
      commands,
      results: commands.map((command) => ({
        command,
        exit_code: null,
        duration_ms: 0,
        stderr: "Verification cancelled before start"
      }))
    };
  }

  const results = [];

  for (const command of commands) {

    /*
     * Listen for cancellation between commands too.
     */
    if (abortSignal?.aborted) {
      results.push({
        command,
        exit_code: null,
        duration_ms: 0,
        stderr: "Verification cancelled"
      });
      break;
    }

    const result = await runOneCommand(
      command,
      cwd,
      timeoutMs,
      abortSignal
    );

    results.push(result);

    /*
     * Fail-fast on first failure.
     */
    if (result.exit_code !== 0) {
      break;
    }
  }

  const passed =
    results.length === commands.length &&
    results.every(
      result =>
        result.exit_code === 0
    );

  return {
    status:
      passed
        ? "passed"
        : "failed",

    commands,

    results
  };
}

interface CommandResult {
  command: string;
  exit_code: number | null;
  duration_ms: number;
  stdout?: string;
  stderr?: string;
}

async function runOneCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<CommandResult> {

  const started = Date.now();

  /*
   * We use spawn (not exec) so that we can kill the
   * child process if cancellation or timeout fires.
   */
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  /*
   * Cleanup on timeout or cancellation:
   * - SIGTERM the child
   * - if still alive after grace, SIGKILL
   */
  const killChild = (signal: NodeJS.Signals) => {
    if (!child.killed && child.exitCode === null) {
      child.kill(signal);
    }
  };

  let timeoutTimer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;

  const cleanup = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    if (abortHandler && abortSignal) {
      abortSignal.removeEventListener(
        "abort",
        abortHandler
      );
      abortHandler = undefined;
    }
  };

  /*
   * Timeout.
   */
  timeoutTimer = setTimeout(() => {
    killChild("SIGTERM");
    setTimeout(() => killChild("SIGKILL"), 1000);
  }, timeoutMs);

  /*
   * Cancellation via AbortSignal.
   */
  if (abortSignal) {
    abortHandler = () => {
      killChild("SIGTERM");
      setTimeout(() => killChild("SIGKILL"), 1000);
    };
    abortSignal.addEventListener(
      "abort",
      abortHandler,
      { once: true }
    );
  }

  /*
   * Wait for child to exit.
   */
  const exitCode: number | null = await new Promise(
    (resolve) => {
      child.once("exit", (code) => {
        resolve(code);
      });
      child.once("error", () => {
        resolve(null);
      });
    }
  );

  cleanup();

  const duration = Date.now() - started;

  return {
    command,
    exit_code: exitCode,
    duration_ms: duration,
    stdout: stdout.slice(0, 10000),
    stderr: stderr.slice(0, 10000)
  };
}
