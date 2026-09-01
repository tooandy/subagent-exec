import {
  readFile,
  writeFile,
  rename,
  mkdir,
  unlink,
  access,
  symlink
} from "node:fs/promises";

import {
  resolve,
  join,
  dirname
} from "node:path";

import { randomUUID } from "node:crypto";
import { z } from "zod";

import type {
  SessionMetadata,
  Task
} from "./types.js";

// Re-export so consumers can import from "./session.js" alone.
export type { SessionMetadata };

const SESSION_DIRNAME = ".subagent-exec";
const METADATA_DIRNAME = "metadata";
const PI_SESSION_DIRNAME = "pi-sessions";
const ARCHIVE_DIRNAME = "archive";
const LOCK_DIRNAME = "locks";

const SessionMetadataSchema = z.object({
  schema_version: z.literal("1.0"),
  task_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  worker_session_id: z.string().uuid(),
  worker_session_dir: z.string().min(1),
  iteration: z.number().int().min(0).max(3),
  last_result: z.object({
    status: z.enum(["success", "failed", "cancelled", "timeout", "needs_continuation"]),
    summary: z.string().optional(),
    changed_files: z.array(z.string())
  }).optional(),
  failure_history: z.array(z.object({
    failure_class: z.string().min(1),
    diagnostic_fingerprint: z.string().min(1)
  })).default([]),
  circuit: z.object({
    allow_continuation: z.boolean(),
    state: z.enum(["checkpoint_review", "repairable_failure", "coordinator_required", "terminal_success"]),
    reason: z.enum(["scope_violation", "budget_exceeded", "repeated_failure", "no_new_diagnostics", "coordinator_required", "iteration_limit"]).optional(),
    failure_class: z.string().optional()
  }).optional(),
  candidate_worktree: z.string().min(1).optional(),
  cwd: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  original_task: z.object({
    task_class: z.enum(["mechanical_refactoring", "test_generation", "bug_investigation", "small_feature", "cross_module", "other"]).optional(),
    objective: z.string().optional(),
    prompt: z.string().min(1),
    scope: z.enum(["read_only", "read_write"]).optional(),
    allowed_paths: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    acceptance_criteria: z.array(z.string()).optional(),
    verification: z.object({
      commands: z.array(z.string()).optional(),
      timeout_ms: z.number().int().positive().optional()
    }).optional(),
    iteration: z.object({
      max_iterations: z.number().int().positive().max(3).optional()
    }).optional(),
    execution_policy: z.object({
      mode: z.enum(["fast", "checkpoint", "investigation"]),
      risk: z.enum(["low", "medium", "high"]),
      max_changed_files: z.number().int().positive().optional(),
      max_diff_lines: z.number().int().positive().optional(),
      allow_binary_changes: z.boolean().optional(),
      estimated_direct_cost_usd: z.number().positive().optional(),
      max_cost_ratio: z.number().positive().max(1).optional(),
      on_failure: z.literal("return_to_coordinator")
    }).optional(),
    model: z.object({
      provider: z.string().optional(),
      model: z.string().optional()
    }).optional(),
    timeout_ms: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
});

/**
 * Resolve the session directory.
 *
 * Priority:
 * 1. SUBAGENT_EXEC_SESSION_DIR environment variable
 * 2. <cwd>/.subagent-exec/  (per-project runtime storage)
 *
 * Per-project storage means sessions live next to the worker's
 * working directory. Metadata and Pi transcripts use separate children.
 */
export function resolveRuntimeDir(cwd: string): string {
  if (process.env.SUBAGENT_EXEC_SESSION_DIR) {
    return process.env.SUBAGENT_EXEC_SESSION_DIR;
  }
  return join(resolve(cwd), SESSION_DIRNAME);
}

export function resolveMetadataDir(cwd: string): string {
  return join(resolveRuntimeDir(cwd), METADATA_DIRNAME);
}

export function resolvePiSessionDir(cwd: string): string {
  return join(resolveRuntimeDir(cwd), PI_SESSION_DIRNAME);
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
  const path = sessionPath(resolveMetadataDir(cwd), taskId);

  try {
    await access(path);
  } catch {
    return null;
  }

  const text = await readFile(path, "utf8");

  try {
    return SessionMetadataSchema.parse(JSON.parse(text)) as SessionMetadata;
  } catch (error) {
    throw new Error(
      `failed to parse session file ${path}: ${String(error)}`
    );
  }
}

export async function loadArchivedSession(cwd: string, taskId: string): Promise<SessionMetadata | null> {
  const path = sessionPath(join(resolveRuntimeDir(cwd), ARCHIVE_DIRNAME), taskId);
  try { await access(path); } catch { return null; }
  const text = await readFile(path, "utf8");
  try { return SessionMetadataSchema.parse(JSON.parse(text)) as SessionMetadata; }
  catch (error) { throw new Error(`failed to parse archived session file ${path}: ${String(error)}`); }
}

export async function saveSession(
  metadata: SessionMetadata
): Promise<string> {
  const sessionDir = resolveMetadataDir(metadata.cwd);
  await mkdir(sessionDir, { recursive: true });

  const path = sessionPath(sessionDir, metadata.task_id);

  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      tempPath,
      JSON.stringify(metadata, null, 2),
      "utf8"
    );
    await rename(tempPath, path);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // The write may have failed before creating the temporary file.
    }
    throw error;
  }

  return path;
}

export async function deleteSession(
  cwd: string,
  taskId: string
): Promise<void> {
  const path = sessionPath(resolveMetadataDir(cwd), taskId);
  try {
    await unlink(path);
  } catch {
    /* ignore */
  }
}

export async function archiveSession(cwd: string, taskId: string): Promise<string> {
  const source = sessionPath(resolveMetadataDir(cwd), taskId);
  const archiveDir = join(resolveRuntimeDir(cwd), ARCHIVE_DIRNAME);
  await mkdir(archiveDir, { recursive: true });
  const destination = sessionPath(archiveDir, taskId);
  await rename(source, destination);
  return destination;
}

export async function acquireSessionLease(cwd: string, taskId: string): Promise<(() => Promise<void>) | null> {
  const lockDir = join(resolveRuntimeDir(cwd), LOCK_DIRNAME);
  await mkdir(lockDir, { recursive: true });
  const path = sessionPath(lockDir, taskId);
  try {
    await symlink(String(process.pid), path);
  } catch (error) {
    // Fail closed for both live and stale locks. Automatic stale-owner
    // takeover cannot be implemented as a portable filesystem CAS and risks
    // two processes believing they own the task. Operators may remove a stale
    // symlink only after independently confirming its process is gone.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  return async () => { try { await unlink(path); } catch { /* already released */ } };
}

/**
 * Create initial session metadata at task start.
 */
export function newSessionMetadata(task: Task): SessionMetadata {
  const now = new Date().toISOString();

  return SessionMetadataSchema.parse({
    schema_version: "1.0",
    task_id: task.task_id,
    worker_session_id: randomUUID(),
    worker_session_dir: resolvePiSessionDir(task.cwd ?? process.cwd()),
    iteration: 0,
    failure_history: [],
    cwd: task.cwd ?? process.cwd(),
    created_at: now,
    updated_at: now,
    original_task: {
      task_class: task.task_class,
      objective: task.objective,
      prompt: task.prompt,
      scope: task.scope,
      allowed_paths: task.allowed_paths,
      constraints: task.constraints,
      acceptance_criteria: task.acceptance_criteria,
      verification: task.verification,
      iteration: task.iteration,
      execution_policy: task.execution_policy,
      model: task.model,
      timeout_ms: task.timeout_ms,
      metadata: task.metadata
    }
  }) as SessionMetadata;
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
    failure_history?: SessionMetadata["failure_history"];
    circuit?: SessionMetadata["circuit"];
    candidate_worktree?: string | null;
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
    failure_history: update.failure_history ?? prev.failure_history,
    circuit: update.circuit ?? prev.circuit,
    candidate_worktree: update.candidate_worktree === null
      ? undefined
      : update.candidate_worktree ?? prev.candidate_worktree,
    updated_at: new Date().toISOString()
  };
}
