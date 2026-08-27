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

interface WorkspaceSnapshot {
  dirtyPaths: Set<string>;
}

async function git(
  cwd: string,
  args: string[]
): Promise<string> {
  const { stdout } =
    await execFileAsync(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      }
    );

  return stdout;
}

async function getDirtyPaths(
  cwd: string
): Promise<Set<string>> {
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

  const result =
    new Set<string>();

  for (const entry of paths) {
    /*
     * Format:
     * XY path
     *
     * Rename/copy may contain:
     * XY old\0new
     *
     * For V1 we conservatively take
     * the path after the status columns.
     */
    const path =
      entry.slice(3).trim();

    if (path) {
      result.add(path);
    }
  }

  return result;
}

export async function captureBaseline(
  cwd: string
): Promise<WorkspaceSnapshot> {
  return {
    dirtyPaths:
      await getDirtyPaths(cwd)
  };
}

export async function getChangedFiles(
  cwd: string
): Promise<string[]> {
  const tracked =
    await git(
      cwd,
      [
        "diff",
        "--name-only",
        "--diff-filter=ACDMRTUXB"
      ]
    );

  const untracked =
    await git(
      cwd,
      [
        "ls-files",
        "--others",
        "--exclude-standard"
      ]
    );

  const files =
    new Set<string>();

  for (const line of tracked.split(/\r?\n/)) {
    if (line.trim()) {
      files.add(line.trim());
    }
  }

  for (const line of untracked.split(/\r?\n/)) {
    if (line.trim()) {
      files.add(line.trim());
    }
  }

  return [...files].sort();
}

function isAllowed(
  file: string,
  patterns: string[]
): boolean {
  return patterns.some(
    pattern =>
      minimatch(
        file,
        pattern,
        {
          dot: true,
          nocase: false
        }
      )
  );
}

export async function checkScope(
  cwd: string,
  baseline: WorkspaceSnapshot,
  allowedPaths: string[] = []
): Promise<ScopeInfo> {
  const finalDirty =
    await getDirtyPaths(cwd);

  const changedFiles =
    await getChangedFiles(cwd);

  /*
   * Files that were already dirty before
   * the worker started are excluded from
   * worker scope validation.
   */
  const workerChanged =
    changedFiles.filter(
      file => !baseline.dirtyPaths.has(file)
    );

  if (allowedPaths.length === 0) {
    return {
      status: "not_checked",
      allowed_paths: [],
      changed_files: workerChanged,
      violations: []
    };
  }

  const violations: ScopeViolation[] = [];

  for (const file of workerChanged) {
    if (!isAllowed(file, allowedPaths)) {
      violations.push({
        path: file,
        reason:
          "File was modified outside allowed_paths"
      });
    }
  }

  /*
   * Keep this reference so the compiler doesn't
   * consider finalDirty unused if this module
   * is later extended for deleted-file handling.
   */
  void finalDirty;

  return {
    status:
      violations.length === 0
        ? "passed"
        : "failed",

    allowed_paths: allowedPaths,

    changed_files: workerChanged,

    violations
  };
}
