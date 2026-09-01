import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readlink, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { resolveRuntimeDir } from "./session.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

export async function createCandidateWorktree(mainCwd: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "subagent-candidate-"));
  try { await git(mainCwd, ["worktree", "add", "--detach", path, "HEAD"]); }
  catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  return path;
}

export async function candidateBaseHead(worktree: string): Promise<string> {
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
}

export async function exportCandidatePatch(mainCwd: string, worktree: string, taskId: string): Promise<string> {
  await git(worktree, ["add", "-N", "--", "."]);
  const names = (await git(worktree, ["diff", "--name-only", "-z", "HEAD", "--"]))
    .split("\0").filter(Boolean);
  for (const name of names) {
    const candidatePath = join(worktree, name);
    try {
      if (!(await lstat(candidatePath)).isSymbolicLink()) continue;
      const target = await readlink(candidatePath);
      const fromRoot = relative(resolve(worktree), resolve(dirname(candidatePath), target));
      if (isAbsolute(target) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        throw new Error(`CANDIDATE_SYMLINK_ESCAPE: ${name}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  const patch = await git(worktree, ["diff", "--binary", "HEAD", "--"]);
  const dir = join(resolveRuntimeDir(mainCwd), "candidates");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${taskId}.patch`);
  await writeFile(path, patch, "utf8");
  return path;
}

export async function discardCandidate(mainCwd: string, worktree: string): Promise<void> {
  await git(mainCwd, ["worktree", "remove", "--force", worktree]);
}

export async function acceptCandidate(mainCwd: string, taskId: string, candidateFiles: string[], baseHead: string): Promise<string> {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) throw new Error("invalid candidate task id");
  const dir = join(resolveRuntimeDir(mainCwd), "candidates");
  const patch = join(dir, `${taskId}.patch`);
  const accepted = join(dir, `${taskId}.accepted.patch`);
  const currentHead = (await git(mainCwd, ["rev-parse", "HEAD"])).trim();
  if (currentHead !== baseHead) throw new Error("candidate base HEAD no longer matches checkout HEAD");
  if (candidateFiles.length) {
    const dirty = await git(mainCwd, ["status", "--porcelain=v1", "-z", "--", ...candidateFiles]);
    if (dirty.length) throw new Error("candidate paths contain pre-existing checkout changes");
  }
  await rename(patch, accepted);
  try {
    await git(mainCwd, ["apply", "--check", accepted]);
    await git(mainCwd, ["apply", accepted]);
  } catch (error) {
    await rename(accepted, patch);
    throw error;
  }
  return accepted;
}

export async function rejectCandidate(mainCwd: string, taskId: string): Promise<string> {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) throw new Error("invalid candidate task id");
  const dir = join(resolveRuntimeDir(mainCwd), "candidates");
  const patch = join(dir, `${taskId}.patch`);
  const rejected = join(dir, `${taskId}.rejected.patch`);
  await rename(patch, rejected);
  return rejected;
}
