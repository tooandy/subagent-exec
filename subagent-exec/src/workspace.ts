import {
  execFile
} from "node:child_process";

import {
  promisify
} from "node:util";

import {
  lstat,
  readFile
} from "node:fs/promises";

import {
  resolve
} from "node:path";

import {
  minimatch
} from "minimatch";

import type {
  ScopeInfo,
  ScopeViolation
} from "./types.js";

const execFileAsync =
  promisify(execFile);

/**
 * Error thrown when workspace operations cannot be performed.
 * Used to distinguish git/IO failures from "clean workspace".
 */
export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly fatal: boolean = false
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export async function countDiffLines(
  cwd: string,
  files: string[],
  baseline?: WorkspaceBaseline
): Promise<number> {
  const measurement = await measureDiff(cwd, files, baseline);
  return measurement.hasBinary ? Number.MAX_SAFE_INTEGER : measurement.textDiffLines;
}

export interface DiffMeasurement {
  textDiffLines: number;
  hasBinary: boolean;
}

export async function measureDiff(
  cwd: string,
  files: string[],
  baseline?: WorkspaceBaseline
): Promise<DiffMeasurement> {
  if (files.length === 0) return { textDiffLines: 0, hasBinary: false };
  let total = 0;
  let hasBinary = false;
  const remaining: string[] = [];
  for (const file of files) {
    if (!baseline?.dirtyPaths.has(file)) {
      remaining.push(file);
      continue;
    }
    const before = baseline.contents.get(file) ?? null;
    let after: Buffer | null = null;
    try { after = await readFile(resolve(cwd, file)); } catch { /* deleted */ }
    if (isBinary(before) || isBinary(after)) { hasBinary = true; continue; }
    total += changedTextLines(before, after);
  }
  if (remaining.length === 0) return { textDiffLines: total, hasBinary };
  const outputs = await Promise.all([
    git(cwd, ["diff", "HEAD", "--numstat", "--", ...remaining])
  ]);
  const tracked = new Set<string>();
  for (const line of outputs.join("\n").split(/\r?\n/)) {
    if (!line) continue;
    const [added, deleted, path] = line.split("\t");
    if (path) tracked.add(path);
    if (added === "-" || deleted === "-") {
      hasBinary = true;
    } else {
      total += (Number(added) || 0) + (Number(deleted) || 0);
    }
  }
  for (const file of remaining) {
    if (tracked.has(file)) continue;
    try {
      const content = await readFile(resolve(cwd, file));
      if (isBinary(content)) { hasBinary = true; continue; }
      total += textLines(content).length;
    } catch {
      // Deleted files are already represented by git numstat.
    }
  }
  return { textDiffLines: total, hasBinary };
}

function isBinary(content: Buffer | null): boolean {
  return content?.includes(0) ?? false;
}

function textLines(content: Buffer | null): string[] {
  if (!content?.length) return [];
  return content.toString("utf8").split(/\r?\n/).filter((_, index, lines) => index < lines.length - 1 || lines[index] !== "");
}

function changedTextLines(before: Buffer | null, after: Buffer | null): number {
  const a = textLines(before);
  const b = textLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length - 1;
  let bEnd = b.length - 1;
  while (aEnd >= start && bEnd >= start && a[aEnd] === b[bEnd]) { aEnd--; bEnd--; }
  return Math.max(0, aEnd - start + 1) + Math.max(0, bEnd - start + 1);
}

async function git(
  cwd: string,
  args: string[]
): Promise<string> {
  try {
    const { stdout } =
      await execFileAsync(
        "git",
        args,
        {
          cwd,
          encoding: "utf8",
          maxBuffer:
            10 * 1024 * 1024
        }
      );

    return stdout;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new WorkspaceError(
          `git not found in PATH`,
          true
        );
      }
    }
    // Git errors (non-ENOENT) are treated as fatal — we cannot
    // reliably determine workspace state.
    throw new WorkspaceError(
      `git ${args.join(" ")} failed: ${String(error)}`,
      true
    );
  }
}

export interface WorkspaceBaseline {
  dirtyPaths: Set<string>;
  fingerprints: Map<string, string>;
  contents: Map<string, Buffer | null>;
}

/**
 * Lightweight fingerprint for "did this file change since baseline?"
 *
 * For tracked dirty files we use `git hash-object` — Git reads the file
 * itself and computes its blob hash in a single subprocess, which is
 * much faster than Node reading the entire file and computing SHA256
 * for large workspaces.
 *
 * For untracked files we use size + mtime. These are cheap, and a
 * collision on (size, mtime) for an untracked file across a worker
 * invocation is extremely unlikely; if the user is editing an untracked
 * file and the worker modifies it, mtime changes and we detect it.
 *
 * We deliberately do not read full file contents into Node memory —
 * a multi-GB dirty file should not blow up subagent-exec.
 */
async function fingerprint(cwd: string, path: string): Promise<string> {
  try {
    const stat = await lstat(resolve(cwd, path));
    if (!stat.isFile()) {
      // Symlink, dir, etc. — use mode + size + mtime.
      return `meta:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
    }

    /*
     * If the path is tracked, prefer git hash-object. Git will not
     * read+hash more than once because the blob store is keyed by
     * content hash already, but the path still flows through Git's
     * subprocess rather than Node's readFile+SHA256 — substantially
     * faster for large files and large numbers of files.
     */
    const isTracked = await isPathTracked(cwd, path);
    if (isTracked) {
      try {
        const hash = (
          await git(cwd, ["hash-object", "--", path])
        ).trim();
        return `git:${hash}`;
      } catch {
        // Fall through to size+mtime below.
      }
    }

    return `fs:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw new WorkspaceError(`Cannot fingerprint ${path}: ${String(error)}`, true);
  }
}

async function isPathTracked(cwd: string, path: string): Promise<boolean> {
  try {
    const out = await git(cwd, ["ls-files", "--", path]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Capture the current workspace state before the worker runs.
 *
 * We record every path that is already dirty (tracked changes,
 * untracked files, renames, deletions) so we can subtract it from
 * post-run changes and isolate only what the worker introduced.
 *
 * @param cwd  Working directory that must be a git repository.
 * @throws WorkspaceError if cwd is not a git repository or git query fails.
 */
export async function captureBaseline(
  cwd: string
): Promise<WorkspaceBaseline> {
  /*
   * Verify cwd is a git repository first.
   * git status exits non-zero if not in a repo.
   */
  await git(cwd, ["rev-parse", "--is-inside-work-tree"]);

  /*
   * status --porcelain=v1 -z produces NUL-delimited output:
   *   XY filename
   * where XY is the two-character status code.
   *
   * We care about all statuses because a pre-existing dirty file
   * might be renamed, deleted, or have its content changed — any
   * of those would show up here.
   *
   * Renamed files appear as:
   *   R  old_name -> new_name
   * The second name is the new path; we record both.
   */
  const output =
    await git(cwd, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "-z"
    ]);

  if (!output) {
    return { dirtyPaths: new Set(), fingerprints: new Map(), contents: new Map() };
  }

  const paths =
    output
      .split("\0")
      .filter(Boolean);

  const dirtyPaths =
    new Set<string>();

  for (const entry of paths) {
    /*
     * entry format: "XY filename" or "XY oldname -> newname"
     * where XY is exactly 2 chars at positions 0-1, then a single
     * separator space at position 2. We split on that separator.
     *
     * Note: porcelain v1 has no leading space (unlike v0); the very
     * first char of the status code can be a space (e.g. " M" for
     * unstaged modification). So we must split on the SECOND space,
     * not indexOf(" ").
     */
    if (entry.length < 4) continue;
    const namesPart = entry.slice(3);

    // For renames: "oldname -> newname"
    const arrowIdx = namesPart.indexOf(" -> ");
    if (arrowIdx !== -1) {
      dirtyPaths.add(namesPart.slice(0, arrowIdx));
      dirtyPaths.add(namesPart.slice(arrowIdx + 4));
    } else {
      dirtyPaths.add(namesPart);
    }
  }

  const fingerprints = new Map<string, string>();
  const contents = new Map<string, Buffer | null>();
  for (const path of dirtyPaths) {
    fingerprints.set(path, await fingerprint(cwd, path));
    try { contents.set(path, await readFile(resolve(cwd, path))); }
    catch { contents.set(path, null); }
  }

  return { dirtyPaths, fingerprints, contents };
}

export type ScopeMode = "read_only" | "read_write";

/**
 * Check what the worker changed and verify it against allowed_paths
 * and scope mode.
 *
 * @param cwd         Working directory
 * @param baseline    State captured before worker ran
 * @param allowedPaths  Glob patterns the worker is allowed to touch
 * @param scopeMode   read_only or read_write
 * @throws WorkspaceError if cwd is not a git repository or git fails.
 */
export async function checkScope(
  cwd: string,
  baseline: WorkspaceBaseline,
  allowedPaths: string[],
  scopeMode: ScopeMode = "read_write"
): Promise<ScopeInfo> {

  /*
   * Verify git repo first — we must not silently pass on git failures.
   * If the workspace is not a git repo, scope checking cannot be done
   * reliably and must be treated as fatal.
   */
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }
    throw new WorkspaceError(
      `cwd is not a git repository: ${cwd}`,
      true
    );
  }

  /*
   * Four distinct git queries:
   * 1. Tracked unstaged changes
   * 2. Staged changes (staged changes to tracked files)
   * 3. Untracked files (excluding ignored)
   * 4. Deleted tracked files
   *
   * Note: renamed files appear in both diff output and status output.
   * We use status --porcelain for completeness.
   */
  const [unstaged, staged, untracked, deleted] =
    await Promise.all([
      git(cwd, ["diff", "--name-only"]),
      git(cwd, ["diff", "--cached", "--name-only"]),
      git(cwd, ["ls-files", "--others", "--exclude-standard"]),
      git(cwd, ["diff", "--name-only", "--diff-filter=D"])
    ]);

  const changed = new Set<string>();

  for (const line of unstaged.split(/\r?\n/)) {
    if (line.trim()) changed.add(line.trim());
  }

  for (const line of staged.split(/\r?\n/)) {
    if (line.trim()) changed.add(line.trim());
  }

  for (const line of deleted.split(/\r?\n/)) {
    if (line.trim()) changed.add(line.trim());
  }

  for (const line of untracked.split(/\r?\n/)) {
    if (line.trim()) changed.add(line.trim());
  }

  /*
   * Filter out files that were already dirty before the worker started.
   * This ensures we only flag changes introduced by the worker.
   */
  const workerChanged: string[] = [];
  for (const path of changed) {
    if (!baseline.dirtyPaths.has(path)) {
      workerChanged.push(path);
      continue;
    }
    const before = baseline.fingerprints.get(path);
    const after = await fingerprint(cwd, path);
    if (before !== after) {
      workerChanged.push(path);
    }
  }

  /*
   * Classify changes into added / modified / deleted.
   * We use the git diff --name-only --diff-filter output which tells us
   * exactly what happened.
   */
  const added: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const path of workerChanged) {
    const isNew =
      untracked
        .split(/\r?\n/)
        .includes(path);

    const isDeleted =
      deleted
        .split(/\r?\n/)
        .includes(path);

    if (isNew && !isDeleted) {
      added.push(path);
    } else if (isDeleted) {
      deletedFiles.push(path);
    } else {
      modifiedFiles.push(path);
    }
  }

  const violations: ScopeViolation[] = [];

  /*
   * Violation logic:
   * - read_only: ANY modification is a violation (regardless of allowed_paths)
   * - read_write + empty allowed_paths: scope not checked
   * - read_write + non-empty allowed_paths: check against glob patterns
   */
  if (scopeMode === "read_only") {
    if (workerChanged.length > 0) {
      for (const path of workerChanged) {
        violations.push({
          path,
          reason:
            "Worker modified a file in read_only scope"
        });
      }
    }
  } else if (allowedPaths.length > 0) {
    for (const path of workerChanged) {
      if (
        !allowedPaths.some(pattern =>
          minimatch(path, pattern, { dot: true })
        )
      ) {
        violations.push({
          path,
          reason:
            "Worker changed a file outside allowed_paths"
        });
      }
    }
  }

  let status: ScopeInfo["status"];
  if (scopeMode === "read_only" && workerChanged.length === 0) {
    status = "passed";
  } else if (scopeMode === "read_only" && violations.length > 0) {
    status = "failed";
  } else if (
    scopeMode === "read_write" &&
    allowedPaths.length === 0
  ) {
    status = "not_checked";
  } else if (violations.length === 0) {
    status = "passed";
  } else {
    status = "failed";
  }

  return {
    status,
    allowed_paths: allowedPaths,
    scope_mode: scopeMode,
    changed_files: workerChanged.sort(),
    added_files: added.sort(),
    modified_files: modifiedFiles.sort(),
    deleted_files: deletedFiles.sort(),
    violations
  };
}
