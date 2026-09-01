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
   * with --continue and the previous session's full conversation
   * history is loaded.
   */
  continueFrom?: SessionMetadata;

  /**
   * Directory where Pi stores session files. subagent-exec passes
   * its own session dir so Pi's sessions are co-located with
   * subagent-exec's metadata.
   */
  sessionDir?: string;
}

export function spawnPi(
  task: Task,
  options: SpawnOptions = {}
): PiProcess {
  const args: string[] = [];

  /*
   * RPC mode is mandatory. Without it Pi runs in interactive TUI
   * mode and won't speak JSONL over stdin/stdout.
   */
  args.push("--mode", "rpc");

  if (options.continueFrom) {
    /*
     * Resume the previous session. --continue tells Pi to look
     * up the most recent session in --session-dir; --session
     * explicitly targets the recorded session_id when known.
     */
    args.push("--continue");

    if (options.continueFrom.worker_session_id) {
      args.push(
        "--session",
        options.continueFrom.worker_session_id
      );
    }
  } else {
    /*
     * Fresh session: do NOT use --no-session because we WANT Pi
     * to persist the session so a future --continue can resume
     * the conversation. subagent-exec records the session_id
     * to its own metadata after the first prompt is accepted.
     */
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
    throw new Error(
      "Failed to obtain Pi process PID"
    );
  }

  return {
    child,
    pid: child.pid
  };
}
