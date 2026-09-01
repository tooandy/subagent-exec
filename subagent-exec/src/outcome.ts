import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, readlink, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Task, WorkerResult } from "./types.js";
import { resolveRuntimeDir } from "./session.js";

export type TaskClass = "mechanical_refactoring" | "test_generation" | "bug_investigation" | "small_feature" | "cross_module" | "other";
export interface OutcomeRecord {
  schema_version: "1.0"; task_id: string; task_class: TaskClass; started_at: string; updated_at: string; accepted_at?: string;
  attempts: number; iterations: number; total_worker_tokens: number; total_worker_cost: number;
  first_pass_verification: "passed" | "failed" | "not_run"; final_verification: "passed" | "failed" | "not_run";
  scope_violations: number; coordinator_decision?: "accepted" | "rejected"; accepted_files: string[];
  accepted_fingerprints?: Record<string, string>; reworked_files: string[]; elapsed_ms_to_accepted?: number;
  terminal_failure_reason?: string; delegation_outcome?: "saved" | "neutral" | "amplified";
  rounds?: Array<{ iteration: number; tokens: number; cost: number; verification: "passed" | "failed" | "not_run"; scope_violations: number; terminal_reason?: string }>;
}

export function validateOutcomeTaskId(taskId: string): void { if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) throw new Error("invalid outcome task id"); }
function outcomePath(cwd: string, taskId: string): string { validateOutcomeTaskId(taskId); return join(resolveRuntimeDir(cwd), "outcomes", `${taskId}.json`); }
async function load(cwd: string, taskId: string): Promise<OutcomeRecord | null> {
  try { return JSON.parse(await readFile(outcomePath(cwd, taskId), "utf8")) as OutcomeRecord; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function save(cwd: string, record: OutcomeRecord): Promise<void> {
  const path = outcomePath(cwd, record.task_id); await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8"); await rename(temp, path);
}
async function fingerprint(cwd: string, file: string): Promise<string> {
  try {
    const path = join(cwd, file); const stat = await lstat(path); const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) return `symlink:${mode}:${await readlink(path)}`;
    if (!stat.isFile()) return `other:${mode}:${stat.size}`;
    return `file:${mode}:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
export async function fingerprintFiles(cwd: string, files: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await fingerprint(cwd, file)])));
}

export async function recordIteration(cwd: string, task: Task, result: WorkerResult): Promise<void> {
  const now = new Date().toISOString(); const previous = await load(cwd, task.task_id);
  const record: OutcomeRecord = previous ?? { schema_version: "1.0", task_id: task.task_id, task_class: task.task_class ?? "other",
    started_at: result.execution.started_at, updated_at: now, attempts: 0, iterations: 0, total_worker_tokens: 0, total_worker_cost: 0,
    first_pass_verification: result.verification.status, final_verification: result.verification.status,
    scope_violations: 0, accepted_files: [], reworked_files: [] };
  record.updated_at = now;
  record.rounds ??= [];
  const terminalReason = !result.continuation.allow_continuation && result.status !== "success"
    ? result.error?.code ?? result.continuation.reason ?? result.status : undefined;
  const round = { iteration: result.iteration, tokens: result.usage?.total_tokens ?? 0, cost: result.usage?.cost ?? 0,
    verification: result.verification.status, scope_violations: result.scope.violations.length, terminal_reason: terminalReason };
  const existingRound = record.rounds.findIndex(item => item.iteration === result.iteration);
  if (existingRound >= 0) record.rounds[existingRound] = round; else record.rounds.push(round);
  record.rounds.sort((a, b) => a.iteration - b.iteration);
  record.attempts = record.rounds.length; record.iterations = Math.max(...record.rounds.map(item => item.iteration));
  record.total_worker_tokens = record.rounds.reduce((sum, item) => sum + item.tokens, 0);
  record.total_worker_cost = record.rounds.reduce((sum, item) => sum + item.cost, 0);
  record.first_pass_verification = record.rounds[0].verification; record.final_verification = record.rounds.at(-1)!.verification;
  record.scope_violations = record.rounds.reduce((sum, item) => sum + item.scope_violations, 0);
  if (result.candidate?.status === "ready") {
    record.accepted_files = [...result.scope.changed_files];
    record.accepted_fingerprints = result.candidate.fingerprints;
  }
  if (!result.continuation.allow_continuation && result.status !== "success") {
    record.terminal_failure_reason = result.error?.code ?? result.continuation.reason ?? result.status; record.delegation_outcome = "amplified";
  }
  await save(cwd, record);
}

export async function recordCoordinatorDecision(cwd: string, taskId: string, decision: "accepted" | "rejected", files: string[] = []): Promise<OutcomeRecord> {
  const record = await load(cwd, taskId); if (!record) throw new Error(`outcome record not found for ${taskId}`);
  record.updated_at = new Date().toISOString(); record.coordinator_decision = decision;
  if (decision === "rejected") { record.delegation_outcome = "amplified"; record.terminal_failure_reason ??= "COORDINATOR_REJECTED"; }
  else { record.accepted_at = record.updated_at; record.elapsed_ms_to_accepted = Date.parse(record.accepted_at) - Date.parse(record.started_at);
    record.accepted_files = files.length ? files : record.accepted_files;
    if (!record.accepted_fingerprints) throw new Error("durable candidate fingerprints are unavailable");
    record.delegation_outcome = "neutral"; }
  await save(cwd, record); return record;
}

export async function recordPersistenceFailure(cwd: string, task: Task, result: WorkerResult): Promise<void> {
  await recordIteration(cwd, task, result);
}

export async function assessOutcome(cwd: string, taskId: string): Promise<OutcomeRecord> {
  let record = await load(cwd, taskId); if (!record) throw new Error(`outcome not found for ${taskId}`);
  const candidateDir = join(resolveRuntimeDir(cwd), "candidates");
  const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };
  const accepted = await exists(join(candidateDir, `${taskId}.accepted.patch`));
  const rejected = await exists(join(candidateDir, `${taskId}.rejected.patch`));
  const pending = await exists(join(candidateDir, `${taskId}.patch`));
  if (Number(accepted) + Number(rejected) + Number(pending) > 1) throw new Error(`conflicting candidate decision artifacts for ${taskId}`);
  if (rejected) return await recordCoordinatorDecision(cwd, taskId, "rejected");
  if (!accepted) throw new Error(pending ? `candidate decision pending for ${taskId}` : `candidate decision artifact missing for ${taskId}`);
  if (!record.accepted_fingerprints) throw new Error(`durable accepted fingerprints not found for ${taskId}`);
  if (record.coordinator_decision !== "accepted") record = await recordCoordinatorDecision(cwd, taskId, "accepted");
  record.reworked_files = (await Promise.all(record.accepted_files.map(async file => [file, await fingerprint(cwd, file)] as const)))
    .filter(([file, hash]) => record.accepted_fingerprints?.[file] !== hash).map(([file]) => file);
  record.delegation_outcome = record.reworked_files.length === 0 ? "saved" : record.reworked_files.length < record.accepted_files.length ? "neutral" : "amplified";
  record.updated_at = new Date().toISOString(); await save(cwd, record); return record;
}
