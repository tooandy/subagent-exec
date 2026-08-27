import {
  exec
} from "node:child_process";

import {
  promisify
} from "node:util";

import type {
  VerificationResult
} from "./types.js";

const execAsync =
  promisify(exec);

export async function runVerification(
  cwd: string,
  commands: string[],
  timeoutMs = 120_000
): Promise<VerificationResult> {

  if (commands.length === 0) {
    return {
      status: "not_run",
      commands: [],
      results: []
    };
  }

  const results = [];

  for (
    const command of commands
  ) {

    const started =
      Date.now();

    try {

      const {
        stdout,
        stderr
      } = await execAsync(
        command,
        {
          cwd,
          timeout:
            timeoutMs,
          maxBuffer:
            20 * 1024 * 1024
        }
      );

      results.push({
        command,

        exit_code: 0,

        duration_ms:
          Date.now() - started,

        stdout:
          stdout.slice(0, 10000),

        stderr:
          stderr.slice(0, 10000)
      });

    } catch (error: unknown) {

      const execError = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      results.push({
        command,

        exit_code:
          typeof execError?.code === "number"
            ? execError.code
            : null,

        duration_ms:
          Date.now() - started,

        stdout:
          String(
            execError?.stdout ?? ""
          ).slice(0, 10000),

        stderr:
          String(
            execError?.stderr ??
            execError?.message ??
            ""
          ).slice(0, 10000)
      });

      /*
       * Fail-fast on first failure.
       */
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
