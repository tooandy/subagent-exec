import {
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";

import type { Task } from "./types.js";

import type { SessionMetadata } from "./session.js";

export interface PiProcess {
  child: ChildProcessWithoutNullStreams;
  pid: number;
}

export interface SpawnOptions {
  /**
   * Existing session to continue. When provided, Pi is spawned
   * with --session and the previous session's full conversation
   * history is loaded.
   */
  continueFrom?: SessionMetadata;

  /**
   * Directory where Pi stores session files. subagent-exec passes
   * a dedicated Pi transcript directory separate from metadata.
   */
  sessionDir?: string;

  /** Exact id used when creating a fresh Pi session. */
  sessionId?: string;
}

export function spawnPi(
  task: Task,
  options: SpawnOptions = {}
): PiProcess {
  const args = buildPiArgs(task, options);

  const child = spawn(
    "pi",
    args,
    {
      cwd: task.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    }
  );

  if (!child.pid) {
    throw new Error("Failed to obtain Pi process PID");
  }

  return { child, pid: child.pid };
}

export function buildPiArgs(
  task: Task,
  options: SpawnOptions = {}
): string[] {
  const args: string[] = [];

  /*
   * RPC mode is mandatory. Without it Pi runs in interactive TUI
   * mode and won't speak JSONL over stdin/stdout.
   */
  args.push("--mode", "rpc");

  if (options.continueFrom) {
    /*
     * Resume only the session recorded for this task.
     */
    args.push("--session", options.continueFrom.worker_session_id);
  } else {
    /*
     * Create an exact task-specific session so future continuation
     * does not depend on the most recently used session.
     */
    if (!options.sessionId) {
      throw new Error("A sessionId is required for a fresh Pi session");
    }
    args.push("--session-id", options.sessionId);
  }

  if (options.sessionDir) {
    args.push("--session-dir", options.sessionDir);
  }

  if (task.model?.provider) {
    args.push("--provider", task.model.provider);
  }

  if (task.model?.model) {
    args.push("--model", task.model.model);
  }

  return args;
}
