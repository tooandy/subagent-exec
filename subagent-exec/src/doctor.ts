import { execFile } from "node:child_process";
import { open, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { DEFAULT_QUOTA_FALLBACK_MODEL, DEFAULT_WORKER_MODEL } from "./model-policy.js";
import { supportsWriteContainment } from "./containment.js";

const execFileAsync = promisify(execFile);

export interface DoctorCheck { name: string; status: "passed" | "failed"; detail: string }
export interface DoctorResult {
  schema_version: "1.0";
  status: "passed" | "failed";
  primary_model: typeof DEFAULT_WORKER_MODEL;
  quota_fallback_model: typeof DEFAULT_QUOTA_FALLBACK_MODEL;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  requireGitMetadata?: boolean;
  models?: Array<{ provider: string; model: string; name: string }>;
}

async function command(executable: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(executable, args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

export async function runDoctor(cwd: string, options: DoctorOptions = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  checks.push({ name: "write_containment", status: supportsWriteContainment() ? "passed" : "failed",
    detail: supportsWriteContainment() ? "macOS sandbox-exec backend is available" : "no supported write-containment backend" });

  try {
    const version = (await command("pi", ["--version"], cwd)).trim();
    checks.push({ name: "pi_cli", status: "passed", detail: `pi ${version}` });
    const models = await command("pi", ["--list-models"], cwd);
    const requestedModels = options.models ?? [
      { name: "primary_model", ...DEFAULT_WORKER_MODEL },
      { name: "quota_fallback_model", ...DEFAULT_QUOTA_FALLBACK_MODEL }
    ];
    for (const selected of requestedModels) {
      const visible = models.split(/\r?\n/).some(line => line.trim().startsWith(`${selected.provider} `) && line.includes(selected.model));
      checks.push({ name: selected.name, status: visible ? "passed" : "failed",
        detail: visible ? `${selected.provider}/${selected.model} is available to Pi` : `${selected.provider}/${selected.model} is not available or authenticated` });
    }
  } catch (error) {
    checks.push({ name: "pi_cli", status: "failed", detail: String(error) });
  }

  if (options.requireGitMetadata !== false) try {
    const rawGitDir = (await command("git", ["rev-parse", "--git-common-dir"], cwd)).trim();
    const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(cwd, rawGitDir);
    const probe = resolve(gitDir, `.subagent-exec-doctor-${process.pid}-${randomUUID()}`);
    let created = false;
    try {
      const handle = await open(probe, "wx", 0o600);
      created = true;
      await handle.close();
    } finally {
      if (created) await unlink(probe);
    }
    checks.push({ name: "git_worktree_metadata", status: "passed", detail: `${gitDir} permits worktree metadata writes` });
  } catch (error) {
    checks.push({ name: "git_worktree_metadata", status: "failed", detail: `candidate worktrees require additional Git metadata permission: ${String(error)}` });
  }

  return {
    schema_version: "1.0",
    status: checks.every(check => check.status === "passed") ? "passed" : "failed",
    primary_model: DEFAULT_WORKER_MODEL,
    quota_fallback_model: DEFAULT_QUOTA_FALLBACK_MODEL,
    checks
  };
}
