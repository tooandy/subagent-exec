import {
  execFile
} from "node:child_process";

import {
  promisify
} from "node:util";

import {
  minimatch
} from "minimatch";

import type {
  ScopeInfo,
  ScopeViolation
} from "./types.js";

const execFileAsync =
  promisify(execFile);

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
  } catch {
    return "";
  }
}

export interface WorkspaceBaseline {
  dirtyPaths: Set<string>;
}

export async function captureBaseline(
  cwd: string
): Promise<WorkspaceBaseline> {
  const output =
    await git(
      cwd,
      [
        "status",
        "--porcelain=v1",
        "-z"
      ]
    );

  const paths =
    output
      .split("\0")
      .filter(Boolean);

  const dirtyPaths =
    new Set<string>();

  for (const entry of paths) {
    const path =
      entry.slice(3).trim();

    if (path) {
      dirtyPaths.add(path);
    }
  }

  return {
    dirtyPaths
  };
}

export async function checkScope(
  cwd: string,
  baseline: WorkspaceBaseline,
  allowedPaths: string[]
): Promise<ScopeInfo> {

  const [tracked, untracked, staged, modified, deleted] =
    await Promise.all([
      git(cwd, ["diff", "--name-only"]),
      git(cwd, ["ls-files", "--others", "--exclude-standard"]),
      git(cwd, ["diff", "--cached", "--name-only"]),
      git(cwd, ["diff", "--name-only"]),
      git(cwd, ["diff", "--name-only", "--diff-filter=D"])
    ]);

  const changed = new Set<string>();

  for (const line of tracked.split(/\r?\n/)) {
    if (line.trim()) changed.add(line.trim());
  }

  for (const line of staged.split(/\r?\n/)) {
    if (line.trim()) changed.add(line.trim());
  }

  for (const line of modified.split(/\r?\n/)) {
    if (line.trim()) changed.add(line.trim());
  }

  for (const line of deleted.split(/\r?\n/)) {
    if (line.trim()) changed.add(line.trim());
  }

  for (const line of untracked.split(/\r?\n/)) {
    if (line.trim()) changed.add(line.trim());
  }

  /*
   * Filter out files that were already dirty
   * before worker started.
   */
  const workerChanged =
    [...changed].filter(
      path => !baseline.dirtyPaths.has(path)
    );

  const added: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const path of workerChanged) {
    if (
      baseline.dirtyPaths.has(path) === false &&
      !baseline.dirtyPaths.has(path.replace(/\0.+$/, ""))
    ) {
      const isNew =
        untracked.includes(path);
      const isDeleted =
        deleted.includes(path);

      if (isNew && !isDeleted) {
        added.push(path);
      } else if (isDeleted) {
        deletedFiles.push(path);
      } else {
        modifiedFiles.push(path);
      }
    } else if (
      deleted.includes(path)
    ) {
      deletedFiles.push(path);
    } else {
      modifiedFiles.push(path);
    }
  }

  const violations: ScopeViolation[] = [];

  if (allowedPaths.length > 0) {
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

  return {
    status:
      allowedPaths.length === 0
        ? "not_checked"
        : violations.length === 0
          ? "passed"
          : "failed",

    allowed_paths: allowedPaths,

    changed_files: workerChanged.sort(),

    added_files: added.sort(),

    modified_files: modifiedFiles.sort(),

    deleted_files: deletedFiles.sort(),

    violations
  };
}
