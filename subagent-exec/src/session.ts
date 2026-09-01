import {
  readFile,
  writeFile,
  mkdir,
  unlink,
  access
} from "node:fs/promises";

import {
  resolve,
  join,
  dirname
} from "node:path";

import type {
  SessionMetadata,
  Task
} from "./types.js";

// Re-export so consumers can import from "./session.js" alone.
export type { SessionMetadata };

const SESSION_DIRNAME = ".subagent-exec";

/**
 * Resolve the session directory.
 *
 * Priority:
 * 1. SUBAGENT_EXEC_SESSION_DIR environment variable
 * 2. <cwd>/.subagent-exec/  (per-project session storage)
 *
 * Per-project storage means sessions live next to the worker's
 * working directory, which matches Pi's own session layout and
 * makes sessions discoverable to humans running `ls .subagent-exec/`.
 */
export function resolveSessionDir(cwd: string): string {
  if (process.env.SUBAGENT_EXEC_SESSION_DIR) {
    return process.env.SUBAGENT_EXEC_SESSION_DIR;
  }
  return join(resolve(cwd), SESSION_DIRNAME);
}

function sessionPath(
  sessionDir: string,
  taskId: string
): string {
  return join(sessionDir, `${taskId}.json`);
}

export async function loadSession(
  cwd: string,
  taskId: string
): Promise<SessionMetadata | null> {
  const path = sessionPath(resolveSessionDir(cwd), taskId);

  try {
    await access(path);
  } catch {
    return null;
  }

  const text = await readFile(path, "utf8");

  try {
    const data = JSON.parse(text) as SessionMetadata;

    if (data.schema_version !== "1.0") {
      throw new Error(
        `unsupported session schema_version: ${data.schema_version}`
      );
    }

    return data;
  } catch (error) {
    throw new Error(
      `failed to parse session file ${path}: ${String(error)}`
    );
  }
}

export async function saveSession(
  metadata: SessionMetadata
): Promise<string> {
  const sessionDir = resolveSessionDir(metadata.cwd);
  await mkdir(sessionDir, { recursive: true });

  const path = sessionPath(sessionDir, metadata.task_id);

  await writeFile(
    path,
    JSON.stringify(metadata, null, 2),
    "utf8"
  );

  return path;
}

export async function deleteSession(
  cwd: string,
  taskId: string
): Promise<void> {
  const path = sessionPath(resolveSessionDir(cwd), taskId);
  try {
    await unlink(path);
  } catch {
    /* ignore */
  }
}

/**
 * Create initial session metadata at task start.
 */
export function newSessionMetadata(task: Task): SessionMetadata {
  const now = new Date().toISOString();

  return {
    schema_version: "1.0",
    task_id: task.task_id,
    iteration: 0,
    cwd: task.cwd ?? process.cwd(),
    created_at: now,
    updated_at: now,
    original_task: {
      objective: task.objective,
      prompt: task.prompt,
      scope: task.scope,
      allowed_paths: task.allowed_paths,
      constraints: task.constraints,
      acceptance_criteria: task.acceptance_criteria,
      model: task.model,
      timeout_ms: task.timeout_ms,
      metadata: task.metadata
    }
  };
}

/**
 * Update session metadata after a successful iteration.
 * Returns a new metadata object — does not mutate in place.
 */
export function withIteration(
  prev: SessionMetadata,
  update: {
    worker_session_id?: string;
    worker_session_dir?: string;
    last_result?: SessionMetadata["last_result"];
    increment_iteration: boolean;
  }
): SessionMetadata {
  return {
    ...prev,
    iteration: update.increment_iteration
      ? prev.iteration + 1
      : prev.iteration,
    worker_session_id:
      update.worker_session_id ?? prev.worker_session_id,
    worker_session_dir:
      update.worker_session_dir ?? prev.worker_session_dir,
    last_result:
      update.last_result ?? prev.last_result,
    updated_at: new Date().toISOString()
  };
}
