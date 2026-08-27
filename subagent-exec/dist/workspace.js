import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { minimatch } from "minimatch";
const execFileAsync = promisify(execFile);
async function git(cwd, args) {
    const { stdout } = await execFileAsync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
}
async function getDirtyPaths(cwd) {
    const output = await git(cwd, [
        "status",
        "--porcelain=v1",
        "-z"
    ]);
    const paths = output
        .split("\0")
        .filter(Boolean);
    const result = new Set();
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
        const path = entry.slice(3).trim();
        if (path) {
            result.add(path);
        }
    }
    return result;
}
export async function captureBaseline(cwd) {
    return {
        dirtyPaths: await getDirtyPaths(cwd)
    };
}
export async function getChangedFiles(cwd) {
    const tracked = await git(cwd, [
        "diff",
        "--name-only",
        "--diff-filter=ACDMRTUXB"
    ]);
    const untracked = await git(cwd, [
        "ls-files",
        "--others",
        "--exclude-standard"
    ]);
    const files = new Set();
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
function isAllowed(file, patterns) {
    return patterns.some(pattern => minimatch(file, pattern, {
        dot: true,
        nocase: false
    }));
}
export async function checkScope(cwd, baseline, allowedPaths = []) {
    const finalDirty = await getDirtyPaths(cwd);
    const changedFiles = await getChangedFiles(cwd);
    /*
     * Files that were already dirty before
     * the worker started are excluded from
     * worker scope validation.
     */
    const workerChanged = changedFiles.filter(file => !baseline.dirtyPaths.has(file));
    if (allowedPaths.length === 0) {
        return {
            status: "not_checked",
            allowed_paths: [],
            changed_files: workerChanged,
            violations: []
        };
    }
    const violations = [];
    for (const file of workerChanged) {
        if (!isAllowed(file, allowedPaths)) {
            violations.push({
                path: file,
                reason: "File was modified outside allowed_paths"
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
        status: violations.length === 0
            ? "passed"
            : "failed",
        allowed_paths: allowedPaths,
        changed_files: workerChanged,
        violations
    };
}
//# sourceMappingURL=workspace.js.map